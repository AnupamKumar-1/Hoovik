from __future__ import annotations

import json
import logging
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import torch
from sklearn.metrics import balanced_accuracy_score, classification_report
from tqdm import tqdm

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from training.train_xgb import build_features

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("calibrate_ensemble")


def load_config() -> dict:
    """Load and return the project configuration from config.json.

    Returns:
        dict: Parsed configuration dictionary.
    """
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


cfg = load_config()

_SEED: int = cfg["misc"]["seed"]
random.seed(_SEED)
np.random.seed(_SEED)
torch.manual_seed(_SEED)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(_SEED)

DEVICE: str = (
    "mps"
    if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available() else "cpu"
)
logger.info("Device: %s", DEVICE)


def load_dataset() -> dict:
    """Load the pre-extracted dataset NPZ file.

    Returns:
        dict: Mapping of array names to NumPy arrays.
    """
    path = BASE_DIR / cfg["paths"]["dataset"]
    logger.info("Loading dataset from %s", path)
    return dict(np.load(path))


def unpack_split(data: dict, split: str):
    """Unpack all arrays for a given data split.

    Args:
        data: Full dataset dictionary as returned by :func:`load_dataset`.
        split: Split name, one of ``"train"``, ``"val"``, or ``"test"``.

    Returns:
        tuple: ``(Xf, Xa, fm, am, y, actor, modality)`` arrays for the split.
    """
    return (
        data[f"X_face_{split}"],
        data[f"X_audio_{split}"],
        data[f"face_mask_{split}"],
        data[f"audio_mask_{split}"],
        data[f"y_{split}"],
        data[f"actor_{split}"],
        data[f"modality_{split}"],
    )


def load_modal():
    """Load the EmotionTransformer checkpoint and set it to eval mode.

    Returns:
        torch.nn.Module: Loaded model in eval mode on ``DEVICE``.
    """
    from training.train_modal import EmotionTransformer, build_train_config

    train_cfg = build_train_config(cfg)
    model = EmotionTransformer(train_cfg).to(DEVICE)
    ckpt = BASE_DIR / cfg["paths"]["models"]["modal"]
    model.load_state_dict(torch.load(ckpt, map_location=DEVICE))
    model.eval()
    logger.info("Modal model loaded from %s", ckpt)
    return model


def load_xgb():
    """Load the XGBoost model, optional PCA transformer, and column medians.

    Column medians are required whenever PCA is present and are used to impute
    NaN values before the PCA transform is applied.

    Returns:
        tuple: ``(xgb_model, pca, col_medians)`` where ``pca`` and
            ``col_medians`` are ``None`` when PCA is disabled.

    Raises:
        FileNotFoundError: If PCA is present but ``col_medians.npy`` is missing.
    """
    xgb_dir = BASE_DIR / cfg["paths"]["checkpoints"]["xgb"]
    xgb_model = joblib.load(BASE_DIR / cfg["paths"]["models"]["xgb"])

    pca_path = BASE_DIR / cfg["paths"]["models"]["pca"]
    pca = joblib.load(pca_path) if pca_path.exists() else None

    col_medians = None
    medians_path = xgb_dir / "col_medians.npy"
    if pca is not None:
        if not medians_path.exists():
            raise FileNotFoundError(
                f"PCA is present but col_medians.npy not found at {medians_path}. "
                "Re-run train_xgb.py to regenerate it."
            )
        col_medians = np.load(medians_path)

    logger.info(
        "XGB loaded (PCA: %s, col_medians: %s)",
        "yes" if pca is not None else "no",
        "yes" if col_medians is not None else "no",
    )
    return xgb_model, pca, col_medians


def get_modal_logits(
    model,
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    batch_size: int = 64,
) -> np.ndarray:
    """Run batched forward passes through the EmotionTransformer and collect logits.

    Args:
        model: EmotionTransformer in eval mode.
        Xf: Face feature sequences of shape (N, T, face_dim).
        Xa: Audio feature sequences of shape (N, T, audio_dim).
        fm: Binary face masks of shape (N, T).
        am: Binary audio masks of shape (N, T).
        batch_size: Number of samples per forward pass.

    Returns:
        np.ndarray: Fusion logits of shape (N, num_classes).
    """
    all_logits: list[np.ndarray] = []
    for start in tqdm(range(0, len(Xf), batch_size), desc="Modal inference"):
        end = min(start + batch_size, len(Xf))
        xf_t = torch.from_numpy(Xf[start:end]).float().to(DEVICE)
        xa_t = torch.from_numpy(Xa[start:end]).float().to(DEVICE)
        fm_t = torch.from_numpy(fm[start:end].astype(np.float32)).to(DEVICE)
        am_t = torch.from_numpy(am[start:end].astype(np.float32)).to(DEVICE)
        with torch.no_grad():
            fusion_logits, _, _, _, _, _ = model(xf_t, xa_t, fm_t, am_t)
        all_logits.append(fusion_logits.cpu().numpy())
    return np.concatenate(all_logits, axis=0)


def get_xgb_probs(
    xgb_model,
    pca,
    col_medians: np.ndarray | None,
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    mod: np.ndarray,
) -> np.ndarray:
    """Build features and return XGBoost class probabilities.

    When PCA is enabled, NaN values are imputed with training column medians
    before the PCA transform is applied. When PCA is disabled, NaNs are passed
    directly to XGBoost via ``missing=np.nan``.

    Args:
        xgb_model: Trained XGBoost classifier.
        pca: Fitted PCA transformer, or ``None`` if PCA is disabled.
        col_medians: Column medians for NaN imputation, or ``None``.
        Xf: Face feature sequences of shape (N, T, face_dim).
        Xa: Audio feature sequences of shape (N, T, audio_dim).
        fm: Binary face masks of shape (N, T).
        am: Binary audio masks of shape (N, T).
        mod: Modality flags of shape (N,).

    Returns:
        np.ndarray: Class probability matrix of shape (N, num_classes), dtype float32.
    """
    X = build_features(Xf, Xa, fm, am, mod)
    if pca is not None:
        nan_mask = np.isnan(X)
        if nan_mask.any():
            X[nan_mask] = np.take(col_medians, np.where(nan_mask)[1])
        X = pca.transform(X)
    return xgb_model.predict_proba(X).astype(np.float32)


def fit_temperature(
    logits: np.ndarray,
    y: np.ndarray,
    t_range: tuple[float, float] = (0.3, 4.0),
    n_steps: int = 141,
) -> float:
    """Find the temperature scalar that maximises balanced accuracy on a validation set.

    Args:
        logits: Raw transformer logits of shape (N, num_classes).
        y: True labels of shape (N,).
        t_range: ``(min, max)`` range for the temperature grid search.
        n_steps: Number of evenly-spaced temperature candidates to evaluate.

    Returns:
        float: Temperature value with the highest balanced accuracy.
    """
    best_T = 1.0
    best_bal = -1.0
    logits_t = torch.from_numpy(logits).float()
    for T in np.linspace(t_range[0], t_range[1], n_steps):
        probs = torch.softmax(logits_t / T, dim=-1).numpy()
        bal = balanced_accuracy_score(y, probs.argmax(1))
        if bal > best_bal:
            best_bal = bal
            best_T = float(T)
    logger.info("Temperature fit: T=%.3f  (calib bal_acc=%.4f)", best_T, best_bal)
    return best_T


def apply_temperature(logits: np.ndarray, T: float) -> np.ndarray:
    """Apply temperature scaling to logits and return a probability array.

    Args:
        logits: Raw logits of shape (N, num_classes).
        T: Temperature scalar.

    Returns:
        np.ndarray: Calibrated probabilities of shape (N, num_classes), dtype float32.
    """
    return (
        torch.softmax(torch.from_numpy(logits).float() / T, dim=-1)
        .numpy()
        .astype(np.float32)
    )


def calibrate_weights(
    p_modal: np.ndarray,
    p_xgb: np.ndarray,
    y: np.ndarray,
    n_steps: int = 201,
) -> tuple[tuple[float, float], float, float]:
    """Grid-search the modal weight that maximises balanced accuracy on a validation set.

    Args:
        p_modal: Temperature-scaled transformer probabilities of shape (N, num_classes).
        p_xgb: XGBoost probabilities of shape (N, num_classes).
        y: True labels of shape (N,).
        n_steps: Number of evenly-spaced weight candidates in ``[0, 1]``.

    Returns:
        tuple: ``((w_modal, w_xgb), best_bal_acc, best_acc)`` where weights sum to 1.
    """
    best_bal = -1.0
    best_w = 0.5
    for w in np.linspace(0.0, 1.0, n_steps):
        probs = w * p_modal + (1.0 - w) * p_xgb
        bal = balanced_accuracy_score(y, probs.argmax(1))
        if bal > best_bal:
            best_bal = bal
            best_w = float(w)

    best_probs = best_w * p_modal + (1.0 - best_w) * p_xgb
    best_acc = float((best_probs.argmax(1) == y).mean())
    return (best_w, 1.0 - best_w), best_bal, best_acc


def preflight_check() -> None:
    """Verify all prerequisite model files exist before running calibration.

    This script is step 4 in the pipeline:
      1. ``extract_embeddings_data.py`` → dataset.npz
      2. ``train_modal.py``             → models/modal/best_modal.pt
      3. ``train_xgb.py``               → models/xgb/xgb_model.joblib
      4. ``calibrate_ensemble.py``      ← current script

    Raises:
        FileNotFoundError: If one or more prerequisite files are missing.
    """
    required = {
        "Dataset -- run extract_embeddings_data.py first": BASE_DIR
        / cfg["paths"]["dataset"],
        "Modal transformer checkpoint -- run train_modal.py first": BASE_DIR
        / cfg["paths"]["models"]["modal"],
        "XGBoost model -- run train_xgb.py first": BASE_DIR
        / cfg["paths"]["models"]["xgb"],
    }
    missing = [(desc, path) for desc, path in required.items() if not path.exists()]
    if missing:
        lines = "\n".join(f"  x  {desc}\n     -> {path}" for desc, path in missing)
        raise FileNotFoundError(
            f"\ncalibrate_ensemble.py: {len(missing)} prerequisite(s) missing:\n\n"
            f"{lines}\n\n"
            "Complete the missing steps before running calibration."
        )
    logger.info("Preflight OK -- all prerequisite files present")


def main() -> None:
    """Entry point for ensemble calibration.

    Runs temperature scaling on the validation set, grid-searches ensemble
    weights, evaluates the calibrated ensemble on the test set, and writes
    the resulting weights and metrics to ``weights.json``.
    """
    preflight_check()
    data = load_dataset()

    Xf_val, Xa_val, fm_val, am_val, y_val, act_val, mod_val = unpack_split(data, "val")
    Xf_te, Xa_te, fm_te, am_te, y_te, act_te, mod_te = unpack_split(data, "test")

    modal = load_modal()
    xgb_model, pca, col_medians = load_xgb()

    logger.info("Calibration-set inference …")
    logits_val = get_modal_logits(modal, Xf_val, Xa_val, fm_val, am_val)
    p_xgb_val = get_xgb_probs(
        xgb_model, pca, col_medians, Xf_val, Xa_val, fm_val, am_val, mod_val
    )

    temperature = fit_temperature(logits_val, y_val)
    p_modal_val = apply_temperature(logits_val, temperature)

    (w_modal, w_xgb), cal_bal_acc, cal_acc = calibrate_weights(
        p_modal_val, p_xgb_val, y_val
    )
    logger.info(
        "Calibration → modal=%.2f  xgb=%.2f  |  bal_acc=%.4f  acc=%.4f",
        w_modal,
        w_xgb,
        cal_bal_acc,
        cal_acc,
    )

    logger.info("Test-set inference …")
    logits_te = get_modal_logits(modal, Xf_te, Xa_te, fm_te, am_te)
    p_modal_te = apply_temperature(logits_te, temperature)
    p_xgb_te = get_xgb_probs(
        xgb_model, pca, col_medians, Xf_te, Xa_te, fm_te, am_te, mod_te
    )

    probs_te = w_modal * p_modal_te + w_xgb * p_xgb_te
    preds_te = probs_te.argmax(1)

    test_acc = float((preds_te == y_te).mean())
    test_bal_acc = float(balanced_accuracy_score(y_te, preds_te))

    modal_only_preds = p_modal_te.argmax(1)
    modal_only_acc = float((modal_only_preds == y_te).mean())
    modal_only_bal = float(balanced_accuracy_score(y_te, modal_only_preds))

    xgb_only_preds = p_xgb_te.argmax(1)
    xgb_only_acc = float((xgb_only_preds == y_te).mean())
    xgb_only_bal = float(balanced_accuracy_score(y_te, xgb_only_preds))

    ensemble_delta = test_acc - modal_only_acc
    class_names = cfg["misc"]["class_names"]

    logger.info("-- INDIVIDUAL MODEL BREAKDOWN --")
    logger.info(
        "  Modal alone  → acc=%.4f  bal_acc=%.4f", modal_only_acc, modal_only_bal
    )
    logger.info("  XGB alone    → acc=%.4f  bal_acc=%.4f", xgb_only_acc, xgb_only_bal)
    logger.info("  Ensemble     → acc=%.4f  bal_acc=%.4f", test_acc, test_bal_acc)
    logger.info("  Delta (ens - modal) = %+.4f", ensemble_delta)

    if abs(ensemble_delta) < 0.005:
        logger.warning(
            "Ensemble gives negligible gain over modal alone — weights may need re-tuning"
        )

    logger.info("\n%s", classification_report(y_te, preds_te, target_names=class_names))

    for source_name, idx in [("RAVDESS", act_te < 1000), ("CREMA-D", act_te >= 1000)]:
        if idx.sum() == 0:
            continue
        src_acc = (preds_te[idx] == y_te[idx]).mean()
        src_bal = balanced_accuracy_score(y_te[idx], preds_te[idx])
        logger.info(
            "%s test acc (%d samples): acc=%.4f  bal_acc=%.4f",
            source_name,
            idx.sum(),
            src_acc,
            src_bal,
        )
        logger.info(
            "\n%s",
            classification_report(
                y_te[idx],
                preds_te[idx],
                target_names=class_names,
                zero_division=0,
            ),
        )

    save_dir = BASE_DIR / cfg["paths"]["checkpoints"]["ensemble"]
    save_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "w_modal": w_modal,
        "w_xgb": w_xgb,
        "temperature": temperature,
        "cal_acc": cal_acc,
        "cal_bal_acc": float(cal_bal_acc),
        "n_samples_cal": int(len(y_val)),
        "test_acc": test_acc,
        "test_bal_acc": test_bal_acc,
        "modal_only_acc": modal_only_acc,
        "modal_only_bal_acc": modal_only_bal,
        "xgb_only_acc": xgb_only_acc,
        "xgb_only_bal_acc": xgb_only_bal,
        "ensemble_delta": ensemble_delta,
        "n_samples_test": int(len(y_te)),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "device": DEVICE,
        "model_version": cfg.get("version", "unknown"),
        "seed": _SEED,
    }

    weights_path = save_dir / "weights.json"
    with open(weights_path, "w") as f:
        json.dump(payload, f, indent=2)

    logger.info("Saved → %s", weights_path)
    logger.info(" -- SUMMARY --")
    logger.info("  Temperature         : %.3f", temperature)
    logger.info("  Calibration bal_acc : %.4f", cal_bal_acc)
    logger.info("  Calibration acc     : %.4f", cal_acc)
    logger.info("  Test acc            : %.4f", test_acc)
    logger.info("  Test bal_acc        : %.4f", test_bal_acc)
    logger.info("  Weights             : modal=%.2f  xgb=%.2f", w_modal, w_xgb)
    logger.info("----")


if __name__ == "__main__":
    main()
