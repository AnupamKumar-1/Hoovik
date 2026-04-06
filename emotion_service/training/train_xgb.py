
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
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA


BASE_DIR = Path(__file__).resolve().parents[1]


def load_config():
    config_path = BASE_DIR / "config" / "config.json"
    with open(config_path) as f:
        return json.load(f)



def setup_logging(log_dir):
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(f"{log_dir}/train_xgb.log"),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)


# NORMALIZATION


def load_or_compute_face_norm(X, mask, norm_dir):
    mean_path = Path(norm_dir) / "face_mean.npy"
    std_path = Path(norm_dir) / "face_std.npy"

    if mean_path.exists() and std_path.exists():
        return np.load(mean_path), np.load(std_path)

    Path(norm_dir).mkdir(parents=True, exist_ok=True)

    valid = mask.reshape(-1) == 1
    flat = X.reshape(-1, X.shape[-1])

    mean = flat[valid].mean(0)
    std = flat[valid].std(0) + 1e-6

    np.save(mean_path, mean)
    np.save(std_path, std)

    return mean, std


def apply_face_norm(X, mean, std):
    return (X - mean) / std


# FEATURE


def aggregate_sequence(X, mask):
    N, T, D = X.shape
    feats = np.zeros((N, D * 4), dtype=np.float32)

    for i in range(N):
        valid = X[i][mask[i] == 1]
        if len(valid) == 0:
            continue

        feats[i, :D] = valid.mean(0)
        feats[i, D : 2 * D] = valid.std(0)
        feats[i, 2 * D : 3 * D] = valid.min(0)
        feats[i, 3 * D :] = valid.max(0)

    return feats


def temporal_delta(X, mask):
    N, T, D = X.shape
    delta = np.zeros((N, D), dtype=np.float32)

    for i in range(N):
        idx = np.where(mask[i] == 1)[0]
        if len(idx) >= 2:
            delta[i] = X[i, idx[-1]] - X[i, idx[0]]

    return delta


def build_features(Xf, Xa, fm, am):
    face_agg = aggregate_sequence(Xf, fm)
    audio_agg = aggregate_sequence(Xa, am)

    face_delta = temporal_delta(Xf, fm)
    audio_delta = temporal_delta(Xa, am)

    has_face = (fm.sum(1) > 0).astype(np.float32).reshape(-1, 1)
    has_audio = (am.sum(1) > 0).astype(np.float32).reshape(-1, 1)
    has_both = has_face * has_audio

    return np.concatenate(
        [
            face_agg,
            audio_agg,
            face_delta,
            audio_delta,
            has_face,
            has_audio,
            has_both,
        ],
        axis=1,
    )


# CLASS WEIGHTS


def compute_sample_weights(y, counts):
    counts = np.array(counts, dtype=np.float32)
    weights = 1.0 / counts
    weights = weights / weights.mean()
    return weights[y]



def plot_confusion(y, p, names, path):
    cm = confusion_matrix(y, p)
    cm = cm / cm.sum(axis=1, keepdims=True)

    disp = ConfusionMatrixDisplay(cm, display_labels=names)
    disp.plot(cmap="Blues")
    plt.savefig(path)
    plt.close()


def plot_importance(model, path):
    scores = model.get_booster().get_score(importance_type="gain")
    if not scores:
        return

    items = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:30]
    k, v = zip(*items)

    plt.barh(k[::-1], v[::-1])
    plt.savefig(path)
    plt.close()



def main():
    cfg = load_config()

    # Paths
    data_path = BASE_DIR / cfg["paths"]["dataset"]
    norm_dir = BASE_DIR / cfg["paths"]["norm_dir"]
    ckpt_dir = BASE_DIR / cfg["paths"]["checkpoints"]["xgb"]
    log_dir = BASE_DIR / cfg["paths"]["logs"]

    # Config values
    class_counts = cfg["misc"]["class_counts"]
    class_names = cfg["misc"]["class_names"]
    num_classes = cfg["model"]["num_classes"]

    xgb_cfg = cfg["xgb"]
    use_pca = cfg["features"]["use_pca"]
    pca_dim = cfg["features"]["pca_dim"]

    logger = setup_logging(log_dir)

    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    logger.info(f"Loading dataset from: {data_path}")
    data = np.load(data_path)

    # Load splits
    Xf_tr, Xa_tr = data["X_face_train"], data["X_audio_train"]
    fm_tr, am_tr, y_tr = (
        data["face_mask_train"],
        data["audio_mask_train"],
        data["y_train"],
    )

    Xf_va, Xa_va = data["X_face_val"], data["X_audio_val"]
    fm_va, am_va, y_va = data["face_mask_val"], data["audio_mask_val"], data["y_val"]

    Xf_te, Xa_te = data["X_face_test"], data["X_audio_test"]
    fm_te, am_te, y_te = data["face_mask_test"], data["audio_mask_test"], data["y_test"]

    # Normalize face
    mean, std = load_or_compute_face_norm(Xf_tr, fm_tr, norm_dir)
    Xf_tr = apply_face_norm(Xf_tr, mean, std)
    Xf_va = apply_face_norm(Xf_va, mean, std)
    Xf_te = apply_face_norm(Xf_te, mean, std)

    # Build features
    logger.info("Building features...")
    X_tr = build_features(Xf_tr, Xa_tr, fm_tr, am_tr)
    X_va = build_features(Xf_va, Xa_va, fm_va, am_va)
    X_te = build_features(Xf_te, Xa_te, fm_te, am_te)

    # Scaling FIRST
    scaler = StandardScaler()
    X_tr = scaler.fit_transform(X_tr)
    X_va = scaler.transform(X_va)
    X_te = scaler.transform(X_te)

    # PCA AFTER scaling
    if use_pca:
        logger.info("Applying PCA...")
        pca = PCA(pca_dim)

        X_tr = pca.fit_transform(X_tr)
        X_va = pca.transform(X_va)
        X_te = pca.transform(X_te)

        logger.info(
            f"PCA explained variance: {pca.explained_variance_ratio_.sum():.3f}"
        )
    else:
        pca = None

    # Weights
    weights = compute_sample_weights(y_tr, class_counts)

    # Clean XGB params
    xgb_params = {k: v for k, v in xgb_cfg.items() if k != "early_stopping_rounds"}
    early_stopping_rounds = xgb_cfg.get("early_stopping_rounds", 30)

    # Model
    model = xgb.XGBClassifier(
        **xgb_params,
        objective="multi:softprob",
        num_class=num_classes,
    )

    logger.info("Training XGBoost...")
    model.fit(
        X_tr,
        y_tr,
        sample_weight=weights,
        eval_set=[(X_va, y_va)],
        early_stopping_rounds=early_stopping_rounds,
        verbose=10,
    )

    # Evaluation
    preds = model.predict(X_te)
    acc = (preds == y_te).mean()

    logger.info(f" TEST ACC: {acc:.4f}")
    logger.info("\n" + classification_report(y_te, preds, target_names=class_names))

    # Save
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    joblib.dump(model, ckpt_dir / "xgb_model.joblib")
    joblib.dump(scaler, ckpt_dir / "scaler.joblib")
    if pca:
        joblib.dump(pca, ckpt_dir / "pca.joblib")

    # Plots
    plot_confusion(y_te, preds, class_names, log_dir / "confusion_xgb.png")
    plot_importance(model, log_dir / "feature_importance_xgb.png")

    logger.info("DONE")


if __name__ == "__main__":
    main()
