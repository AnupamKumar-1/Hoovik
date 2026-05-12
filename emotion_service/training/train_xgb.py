"""
train_xgb.py — Train the XGBoost emotion classifier.

Loads pre-extracted embeddings from dataset.npz, builds the flat feature
matrix, optionally reduces with PCA, trains XGBoost with early stopping,
evaluates on test split (overall / per-dataset / per-modality), saves
model + PCA + col_medians artefacts, and writes confusion / importance plots.

Usage:
    python train_xgb.py
"""

import json
import logging
from pathlib import Path

import numpy as np
import xgboost as xgb
import matplotlib.pyplot as plt
import joblib

from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    ConfusionMatrixDisplay,
)
from sklearn.decomposition import PCA

BASE_DIR = Path(__file__).resolve().parents[1]

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2

LANDMARK_END = 136 * 2
BLENDSHAPE_START = 272
BLENDSHAPE_END = 323
POSE_START = 323

_BLENDSHAPE_ORDER = [
    "browDownLeft",
    "browDownRight",
    "browInnerUp",
    "browOuterUpLeft",
    "browOuterUpRight",
    "cheekPuff",
    "cheekSquintLeft",
    "cheekSquintRight",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "eyeLookDownLeft",
    "eyeLookDownRight",
    "eyeLookInLeft",
    "eyeLookInRight",
    "eyeLookOutLeft",
    "eyeLookOutRight",
    "eyeLookUpLeft",
    "eyeLookUpRight",
    "eyeSquintLeft",
    "eyeSquintRight",
    "eyeWideLeft",
    "eyeWideRight",
    "jawForward",
    "jawLeft",
    "jawOpen",
    "jawRight",
    "mouthClose",
    "mouthDimpleLeft",
    "mouthDimpleRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "mouthFunnel",
    "mouthLeft",
    "mouthLowerDownLeft",
    "mouthLowerDownRight",
    "mouthPressLeft",
    "mouthPressRight",
    "mouthPucker",
    "mouthRight",
    "mouthRollLower",
    "mouthRollUpper",
    "mouthShrugLower",
    "mouthShrugUpper",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthStretchLeft",
    "mouthStretchRight",
    "mouthUpperUpLeft",
    "mouthUpperUpRight",
    "noseSneerLeft",
    "noseSneerRight",
]

_EMOTION_BLEND_NAMES = [
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "browDownLeft",
    "browDownRight",
    "browInnerUp",
    "jawOpen",
    "noseSneerLeft",
    "noseSneerRight",
    "eyeWideLeft",
    "eyeWideRight",
    "cheekPuff",
    "mouthPucker",
    "mouthFunnel",
]
EMOTION_BLEND_IDXS = [_BLENDSHAPE_ORDER.index(n) for n in _EMOTION_BLEND_NAMES]


def load_config() -> dict:
    """Load JSON config from ``<BASE_DIR>/config/config.json``.

    Returns:
        dict: Parsed configuration dictionary.
    """
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


def setup_logging(log_dir: str, log_filename: str = "train_xgb.log") -> logging.Logger:
    """Configure file and console logging, clearing any existing handlers.

    Args:
        log_dir: Directory where the log file will be written.
        log_filename: Name of the log file.

    Returns:
        logging.Logger: Configured logger for this module.
    """
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.handlers.clear()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(f"{log_dir}/{log_filename}", mode="w"),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)


def aggregate_sequence(X: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Compute mean, std, min, and max per dim over valid frames.

    Absent-modality rows remain NaN so XGBoost's native missing-value handler
    learns the best split direction rather than treating zeros as valid signal.

    Args:
        X: Sequence array of shape ``(N, T, D)``.
        mask: Binary validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Aggregated features of shape ``(N, D * 4)``.
    """
    N, T, D = X.shape
    feats = np.full((N, D * 4), np.nan, dtype=np.float32)
    for i in range(N):
        valid = X[i][mask[i] == 1]
        if len(valid) == 0:
            continue
        feats[i, :D] = valid.mean(0)
        feats[i, D : 2 * D] = valid.std(0)
        feats[i, 2 * D : 3 * D] = valid.min(0)
        feats[i, 3 * D :] = valid.max(0)
    return feats


def temporal_delta(X: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Compute last valid frame minus first valid frame per dim.

    Args:
        X: Sequence array of shape ``(N, T, D)``.
        mask: Binary validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Delta features of shape ``(N, D)``.
    """
    N, T, D = X.shape
    delta = np.full((N, D), np.nan, dtype=np.float32)
    for i in range(N):
        idx = np.where(mask[i] == 1)[0]
        if len(idx) >= 2:
            delta[i] = X[i, idx[-1]] - X[i, idx[0]]
    return delta


def temporal_slope(X: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Compute OLS slope in standardised time per dim.

    Args:
        X: Sequence array of shape ``(N, T, D)``.
        mask: Binary validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Slope features of shape ``(N, D)``.
    """
    N, T, D = X.shape
    slope = np.full((N, D), np.nan, dtype=np.float32)
    for i in range(N):
        idx = np.where(mask[i] == 1)[0]
        if len(idx) < 2:
            continue
        t = idx.astype(np.float32)
        t = (t - t.mean()) / (t.std() + 1e-6)
        vals = X[i, idx]
        slope[i] = (t[:, None] * vals).sum(0) / ((t * t).sum() + 1e-6)
    return slope


def blendshape_features(Xf: np.ndarray, fm: np.ndarray) -> np.ndarray:
    """Compute mean and max of 15 emotion-relevant blendshapes plus smile and brow asymmetry.

    Returns 32 features per sample.

    Args:
        Xf: Face embedding array of shape ``(N, T, face_dim)``.
        fm: Face validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Blendshape features of shape ``(N, 32)``.
    """
    N, T, D = Xf.shape
    n_blend = len(EMOTION_BLEND_IDXS)
    out = np.full((N, n_blend * 2 + 2), np.nan, dtype=np.float32)

    smile_L = _BLENDSHAPE_ORDER.index("mouthSmileLeft")
    smile_R = _BLENDSHAPE_ORDER.index("mouthSmileRight")
    brow_L = _BLENDSHAPE_ORDER.index("browDownLeft")
    brow_R = _BLENDSHAPE_ORDER.index("browDownRight")

    for i in range(N):
        valid_mask = fm[i] == 1
        if not valid_mask.any():
            continue
        blend = Xf[i][valid_mask][:, BLENDSHAPE_START:BLENDSHAPE_END]
        sel = blend[:, EMOTION_BLEND_IDXS]
        out[i, :n_blend] = sel.mean(0)
        out[i, n_blend : n_blend * 2] = sel.max(0)
        out[i, n_blend * 2] = np.abs(blend[:, smile_L] - blend[:, smile_R]).mean()
        out[i, n_blend * 2 + 1] = np.abs(blend[:, brow_L] - blend[:, brow_R]).mean()
    return out


def pose_features(Xf: np.ndarray, fm: np.ndarray) -> np.ndarray:
    """Compute mean and std of pitch, yaw, and roll over valid frames.

    Pose variance correlates with arousal and aids angry-vs-disgust separation.
    Returns 6 features per sample.

    Args:
        Xf: Face embedding array of shape ``(N, T, face_dim)``.
        fm: Face validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Pose features of shape ``(N, 6)``.
    """
    N, T, D = Xf.shape
    out = np.full((N, 6), np.nan, dtype=np.float32)
    for i in range(N):
        valid = Xf[i][fm[i] == 1][:, POSE_START:]
        if len(valid) == 0:
            continue
        out[i, :3] = valid.mean(0)
        out[i, 3:] = valid.std(0)
    return out


def audio_rhythm_features(Xa: np.ndarray, am: np.ndarray) -> np.ndarray:
    """Compute temporal energy pattern of audio embeddings.

    Embeddings are z-score-normalised per-dim, so raw L2 norms reflect
    embedding scale rather than acoustic energy. Each sample's norm sequence
    is normalised by its own mean (sample-relative shape).

    Returns 3 features per sample:
        - ``norm_cv``: coefficient of variation (std / mean), energy variability.
        - ``norm_slope``: linear trend of relative energy across the sequence.
        - ``peak_position``: normalised frame index of peak energy (0=start, 1=end).

    Args:
        Xa: Audio embedding array of shape ``(N, T, audio_dim)``.
        am: Audio validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Rhythm features of shape ``(N, 3)``.
    """
    N, T, D = Xa.shape
    out = np.full((N, 3), np.nan, dtype=np.float32)
    for i in range(N):
        idx = np.where(am[i] == 1)[0]
        if len(idx) == 0:
            continue
        norms = np.linalg.norm(Xa[i, idx], axis=1)
        mean_norm = norms.mean()
        if mean_norm < 1e-6:
            continue
        rel = norms / mean_norm
        out[i, 0] = rel.std()
        if len(idx) >= 2:
            t = (idx - idx[0]).astype(np.float32)
            t_std = t / (t.std() + 1e-6)
            out[i, 1] = (t_std * rel).sum() / ((t_std**2).sum() + 1e-6)
        out[i, 2] = float(idx[norms.argmax()]) / T
    return out


def face_motion_energy(Xf: np.ndarray, fm: np.ndarray) -> np.ndarray:
    """Compute mean-squared frame-to-frame landmark change.

    Captures motion intensity: high for angry/fearful, low for neutral.
    Returns 1 feature per sample.

    Args:
        Xf: Face embedding array of shape ``(N, T, face_dim)``.
        fm: Face validity mask of shape ``(N, T)``.

    Returns:
        np.ndarray: Motion energy of shape ``(N, 1)``.
    """
    N, T, D = Xf.shape
    out = np.full((N, 1), np.nan, dtype=np.float32)
    for i in range(N):
        idx = np.where(fm[i] == 1)[0]
        if len(idx) < 2:
            continue
        lm = Xf[i, idx, :LANDMARK_END]
        out[i, 0] = (np.diff(lm, axis=0) ** 2).mean()
    return out


def build_features(
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    mod: np.ndarray,
) -> np.ndarray:
    """Assemble the flat feature matrix fed to XGBoost.

    NaN marks absent-modality entries so XGBoost learns optimal split
    directions via its native missing-value handler (pass ``missing=np.nan``).

    Feature groups:
        1. Sequence statistics: aggregate_sequence, temporal_delta, slope.
        2. Blendshape features: emotion-relevant blendshape means/maxes + asymmetry.
        3. Head-pose features: mean and std of pitch/yaw/roll.
        4. Audio rhythm: energy slope, std, peak position.
        5. Face motion energy: frame-to-frame landmark change.
        6. Modality indicators: has_face, has_audio, coverage ratios, one-hot.

    Args:
        Xf: Face embeddings of shape ``(N, T, face_dim)``.
        Xa: Audio embeddings of shape ``(N, T, audio_dim)``.
        fm: Face validity mask of shape ``(N, T)``.
        am: Audio validity mask of shape ``(N, T)``.
        mod: Modality flags of shape ``(N,)``.

    Returns:
        np.ndarray: Feature matrix of shape ``(N, num_features)``.
    """
    has_face = (fm.sum(1) > 0).astype(np.float32).reshape(-1, 1)
    has_audio = (am.sum(1) > 0).astype(np.float32).reshape(-1, 1)
    is_audio_only = (mod == MODALITY_AUDIO_ONLY).astype(np.float32).reshape(-1, 1)
    is_video_only = (mod == MODALITY_VIDEO_ONLY).astype(np.float32).reshape(-1, 1)
    is_both = (mod == MODALITY_BOTH).astype(np.float32).reshape(-1, 1)

    return np.concatenate(
        [
            aggregate_sequence(Xf, fm),
            aggregate_sequence(Xa, am),
            temporal_delta(Xf, fm),
            temporal_delta(Xa, am),
            temporal_slope(Xf, fm),
            temporal_slope(Xa, am),
            blendshape_features(Xf, fm),
            pose_features(Xf, fm),
            audio_rhythm_features(Xa, am),
            face_motion_energy(Xf, fm),
            has_face,
            has_audio,
            fm.mean(1, keepdims=True).astype(np.float32),
            am.mean(1, keepdims=True).astype(np.float32),
            is_audio_only,
            is_video_only,
            is_both,
        ],
        axis=1,
    )


def compute_sample_weights(
    y: np.ndarray,
    mod: np.ndarray,
    num_classes: int,
    fearful_label: int = 1,
) -> np.ndarray:
    """Compute per-sample weights combining inverse-sqrt class balancing with a fearful boost.

    Applies a targeted 1.5× boost for fearful samples. Fearful has the fewest
    training samples (~1264 vs ~1624 for others); without the boost, leaf weight
    sums hover at the ``min_child_weight`` boundary, causing near-zero recall on
    fearful video-only slices.

    Args:
        y: Integer class labels of shape ``(N,)``.
        mod: Modality flags of shape ``(N,)`` (unused, reserved for future use).
        num_classes: Total number of emotion classes.
        fearful_label: Class index for the fearful emotion.

    Returns:
        np.ndarray: Per-sample weights of shape ``(N,)``.
    """
    counts = np.bincount(y, minlength=num_classes).astype(np.float32)
    with np.errstate(divide="ignore", invalid="ignore"):
        w = np.where(counts > 0, 1.0 / np.sqrt(counts), 0.0)
    mean_w = w[w > 0].mean() if (w > 0).any() else 1.0
    w = w / mean_w
    sample_w = w[y]
    sample_w[y == fearful_label] *= 1.5
    return sample_w


def plot_confusion(
    y: np.ndarray,
    preds: np.ndarray,
    names: list,
    path: Path,
    normalize: bool = True,
) -> None:
    """Save raw (and optionally row-normalised) confusion matrix plots.

    Args:
        y: Ground-truth class indices of shape ``(N,)``.
        preds: Predicted class indices of shape ``(N,)``.
        names: List of class name strings.
        path: Output path for the normalised plot; raw plot is saved alongside it.
        normalize: If ``True``, also save a row-normalised version.
    """
    cm_raw = confusion_matrix(y, preds)
    raw_path = path.parent / (path.stem + "_raw" + path.suffix)
    ConfusionMatrixDisplay(cm_raw, display_labels=names).plot(cmap="Blues")
    plt.tight_layout()
    plt.savefig(raw_path, dpi=150)
    plt.close()

    if normalize:
        row_sums = cm_raw.sum(axis=1, keepdims=True)
        row_sums = np.where(row_sums == 0, 1, row_sums)
        cm_norm = cm_raw.astype(np.float32) / row_sums
        ConfusionMatrixDisplay(cm_norm, display_labels=names).plot(cmap="Blues")
        plt.tight_layout()
        plt.savefig(path, dpi=150)
        plt.close()


def plot_importance(
    model: xgb.XGBClassifier,
    path: Path,
    importance_type: str = "gain",
    top_n: int = 30,
    logger: logging.Logger = None,
) -> None:
    """Save a horizontal bar chart of the top-N XGBoost feature importances.

    Args:
        model: Fitted :class:`xgb.XGBClassifier`.
        path: Output file path for the plot.
        importance_type: XGBoost importance metric (e.g. ``"gain"``, ``"weight"``).
        top_n: Number of top features to display.
        logger: Optional logger; used to emit a warning if scores are empty.
    """
    scores = model.get_booster().get_score(importance_type=importance_type)
    if not scores:
        if logger:
            logger.warning("Feature importance scores are empty — skipping plot.")
        return
    items = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_n]
    keys, vals = zip(*items)
    plt.figure(figsize=(8, 10))
    plt.barh(keys[::-1], vals[::-1])
    plt.xlabel(importance_type.capitalize())
    plt.title(f"Top-{top_n} feature importance ({importance_type})")
    plt.tight_layout()
    plt.savefig(path, dpi=150)
    plt.close()


def preprocess_features(
    X_tr: np.ndarray,
    X_va: np.ndarray,
    X_te: np.ndarray,
    use_pca: bool,
    pca_dim: int,
    seed: int,
    logger: logging.Logger,
):
    """Zero-fill all-NaN and zero-variance columns, then optionally apply PCA.

    Args:
        X_tr: Training feature matrix of shape ``(N_tr, F)``.
        X_va: Validation feature matrix of shape ``(N_va, F)``.
        X_te: Test feature matrix of shape ``(N_te, F)``.
        use_pca: If ``True``, impute NaNs with train column medians and apply PCA.
        pca_dim: Target number of PCA components.
        seed: Random seed for PCA reproducibility.
        logger: Logger for diagnostic messages.

    Returns:
        Tuple of:
            - X_tr, X_va, X_te: Processed arrays.
            - pca: Fitted :class:`sklearn.decomposition.PCA` or ``None``.
            - col_medians: 1-D array of training column medians used before PCA, or ``None``.
            - all_nan_cols: Column indices that were all-NaN (for auditing).
    """
    all_nan_cols = np.where(np.isnan(X_tr).all(axis=0))[0]
    if len(all_nan_cols):
        logger.warning(
            f"{len(all_nan_cols)} all-NaN column(s) zeroed out "
            f"(cols: {all_nan_cols[:10].tolist()}{'...' if len(all_nan_cols) > 10 else ''})"
        )
        X_tr[:, all_nan_cols] = 0.0
        X_va[:, all_nan_cols] = 0.0
        X_te[:, all_nan_cols] = 0.0

    zero_var_cols = np.where(np.nanvar(X_tr, axis=0) == 0)[0]
    if len(zero_var_cols):
        logger.warning(
            f"{len(zero_var_cols)} zero-variance feature(s) zeroed out "
            f"(cols: {zero_var_cols[:10].tolist()}{'...' if len(zero_var_cols) > 10 else ''})"
        )
        X_tr[:, zero_var_cols] = 0.0
        X_va[:, zero_var_cols] = 0.0
        X_te[:, zero_var_cols] = 0.0

    pca = None
    col_medians = None
    if use_pca:
        logger.info("Filling NaNs with train column medians before PCA...")
        col_medians = np.nanmedian(X_tr, axis=0)
        col_medians = np.where(np.isnan(col_medians), 0.0, col_medians)

        for arr in (X_tr, X_va, X_te):
            nan_mask = np.isnan(arr)
            arr[nan_mask] = np.take(col_medians, np.where(nan_mask)[1])

        max_components = min(X_tr.shape[0], X_tr.shape[1])
        effective_pca_dim = min(pca_dim, max_components)
        if effective_pca_dim < pca_dim:
            logger.warning(
                f"pca_dim={pca_dim} clamped to {effective_pca_dim} "
                f"(min(n_samples={X_tr.shape[0]}, n_features={X_tr.shape[1]}))"
            )
        logger.info(f"Applying PCA → {effective_pca_dim} dims")
        pca = PCA(n_components=effective_pca_dim, random_state=seed)
        X_tr = pca.fit_transform(X_tr)
        X_va = pca.transform(X_va)
        X_te = pca.transform(X_te)
        logger.info(
            f"PCA explained variance: {pca.explained_variance_ratio_.sum():.3f}"
        )

    logger.info(f"Feature shape after preprocessing: {X_tr.shape}")
    return X_tr, X_va, X_te, pca, col_medians, all_nan_cols


def main() -> None:
    """Entry point: load data, engineer features, train XGBoost, evaluate, and save artefacts."""
    cfg = load_config()

    data_path = BASE_DIR / cfg["paths"]["dataset"]
    ckpt_dir = BASE_DIR / cfg["paths"]["checkpoints"]["xgb"]
    log_dir = BASE_DIR / cfg["paths"]["logs"]

    class_names = cfg["misc"]["class_names"]
    num_classes = cfg["model"]["num_classes"]
    seed = cfg["misc"]["seed"]
    use_pca = cfg["features"]["use_pca"]
    pca_dim = cfg["features"]["pca_dim"]
    actor_threshold = cfg["misc"]["actor_id_threshold"]
    normalize_confusion = cfg["misc"].get("normalize_confusion", True)
    importance_type = cfg["xgb"].get("importance_type", "gain")
    importance_top_n = cfg["xgb"].get("importance_top_n", 30)
    xgb_verbose = cfg["xgb"].get("verbose", 10)

    xgb_cfg = {k: v for k, v in cfg["xgb"].items()}
    early_stopping_rounds = xgb_cfg.pop("early_stopping_rounds", 150)
    for key in ("verbose", "importance_type", "importance_top_n"):
        xgb_cfg.pop(key, None)

    logger = setup_logging(str(log_dir), "train_xgb.log")

    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    logger.info(f"Loading dataset from {data_path}")
    data = np.load(data_path)

    Xf_tr, Xa_tr = data["X_face_train"], data["X_audio_train"]
    fm_tr, am_tr = data["face_mask_train"], data["audio_mask_train"]
    y_tr, act_tr = data["y_train"], data["actor_train"]
    mod_tr = data["modality_train"]

    Xf_va, Xa_va = data["X_face_val"], data["X_audio_val"]
    fm_va, am_va = data["face_mask_val"], data["audio_mask_val"]
    y_va = data["y_val"]
    mod_va = data["modality_val"]

    Xf_te, Xa_te = data["X_face_test"], data["X_audio_test"]
    fm_te, am_te = data["face_mask_test"], data["audio_mask_test"]
    y_te, act_te = data["y_test"], data["actor_test"]
    mod_te = data["modality_test"]

    logger.info(f"Loaded — train: {len(y_tr)}  val: {len(y_va)}  test: {len(y_te)}")
    logger.info(
        f"Data mix — RAVDESS: {(act_tr < actor_threshold).mean():.1%}"
        f"  CREMA-D: {(act_tr >= actor_threshold).mean():.1%}"
    )
    train_counts = np.bincount(y_tr, minlength=num_classes)
    logger.info(
        "Train-split class counts: "
        + "  ".join(f"{n}={c}" for n, c in zip(class_names, train_counts))
    )

    logger.info("Building features...")
    X_tr = build_features(Xf_tr, Xa_tr, fm_tr, am_tr, mod_tr)
    X_va = build_features(Xf_va, Xa_va, fm_va, am_va, mod_va)
    X_te = build_features(Xf_te, Xa_te, fm_te, am_te, mod_te)
    logger.info(f"Raw feature shape: {X_tr.shape}")

    X_tr, X_va, X_te, pca, col_medians, _ = preprocess_features(
        X_tr, X_va, X_te, use_pca, pca_dim, seed, logger
    )

    weights = compute_sample_weights(y_tr, mod_tr, num_classes)

    model = xgb.XGBClassifier(
        **xgb_cfg,
        objective="multi:softprob",
        num_class=num_classes,
        eval_metric="mlogloss",
        random_state=seed,
        missing=np.nan,
    )

    logger.info(
        f"Training XGBoost | n_estimators={xgb_cfg['n_estimators']} "
        f"| early_stopping={early_stopping_rounds} | seed={seed}"
    )
    model.fit(
        X_tr,
        y_tr,
        sample_weight=weights,
        eval_set=[(X_va, y_va)],
        early_stopping_rounds=early_stopping_rounds,
        verbose=xgb_verbose,
    )
    logger.info(
        f"Best iteration: {model.best_iteration}  "
        f"best val mlogloss: {model.best_score:.4f}"
    )

    preds_te = model.predict(X_te)
    acc = (preds_te == y_te).mean()
    logger.info(f"\n{'=' * 20} TEST RESULTS {'=' * 20}")
    logger.info(f"OVERALL TEST ACC: {acc:.4f}")
    logger.info("\n" + classification_report(y_te, preds_te, target_names=class_names))
    logger.info(f"\nConfusion Matrix:\n{confusion_matrix(y_te, preds_te)}")

    for name, idx in [
        ("RAVDESS", act_te < actor_threshold),
        ("CREMA-D", act_te >= actor_threshold),
    ]:
        if idx.sum() == 0:
            continue
        logger.info(
            f"\n{name} test acc ({idx.sum()} samples): "
            f"{(preds_te[idx] == y_te[idx]).mean():.4f}"
        )
        logger.info(
            "\n"
            + classification_report(
                y_te[idx], preds_te[idx], target_names=class_names, zero_division=0
            )
        )

    logger.info(f"\n{'=' * 20} PER-MODALITY TEST RESULTS {'=' * 20}")
    for mod_val, mod_name in [
        (MODALITY_AUDIO_ONLY, "audio_only"),
        (MODALITY_VIDEO_ONLY, "video_only"),
        (MODALITY_BOTH, "both"),
    ]:
        idx = mod_te == mod_val
        if idx.sum() == 0:
            continue
        logger.info(
            f"{mod_name} ({idx.sum()} samples): "
            f"acc={(preds_te[idx] == y_te[idx]).mean():.4f}"
        )
        logger.info(
            "\n"
            + classification_report(
                y_te[idx], preds_te[idx], target_names=class_names, zero_division=0
            )
        )

    ckpt_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, ckpt_dir / "xgb_model.joblib")
    logger.info(f"Saved model → {ckpt_dir / 'xgb_model.joblib'}")

    if pca is not None:
        joblib.dump(pca, ckpt_dir / "pca.joblib")
        np.save(ckpt_dir / "col_medians.npy", col_medians)
        logger.info(
            f"Saved pca.joblib + col_medians.npy ({col_medians.shape[0]} dims) → {ckpt_dir}"
        )

    log_dir_path = Path(log_dir)
    plot_confusion(
        y_te,
        preds_te,
        class_names,
        log_dir_path / "confusion_xgb.png",
        normalize=normalize_confusion,
    )
    plot_importance(
        model,
        log_dir_path / "feature_importance_xgb.png",
        importance_type=importance_type,
        top_n=importance_top_n,
        logger=logger,
    )

    logger.info("DONE — train_xgb complete.")


if __name__ == "__main__":
    main()
