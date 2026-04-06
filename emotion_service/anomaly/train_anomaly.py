
import json
import logging
from pathlib import Path

import numpy as np
import joblib
import matplotlib.pyplot as plt
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

BASE_DIR = Path(__file__).resolve().parents[1]


def load_config():
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


def setup_logging(log_dir):
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(str(Path(log_dir) / "train_anomaly.log")),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)



def load_face_norm(norm_dir):
    return (
        np.load(norm_dir / "face_mean.npy"),
        np.load(norm_dir / "face_std.npy"),
    )


def apply_face_norm(X, mean, std):
    return (X - mean) / std



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
    """
    IMPORTANT:
    No modality flags — only behavioral features
    """
    return np.concatenate(
        [
            aggregate_sequence(Xf, fm),
            aggregate_sequence(Xa, am),
            temporal_delta(Xf, fm),
            temporal_delta(Xa, am),
        ],
        axis=1,
    ).astype(np.float32)



def tune_threshold(scores_val, target_fpr, logger):
    threshold = float(np.percentile(scores_val, target_fpr * 100))
    flagged = (scores_val < threshold).mean()

    logger.info(
        f"Threshold @ FPR={target_fpr:.0%} → "
        f"{threshold:.5f} | overall flagged={flagged:.2%}"
    )

    return threshold


def plot_scores(train, val, thr, path):
    plt.figure(figsize=(8, 4))
    plt.hist(train, bins=60, alpha=0.5, label="train", density=True)
    plt.hist(val, bins=60, alpha=0.5, label="val", density=True)
    plt.axvline(thr, color="red", linestyle="--")
    plt.legend()
    plt.title("Anomaly Score Distribution")
    plt.savefig(path)
    plt.close()



def main():
    cfg = load_config()

    log_dir = BASE_DIR / cfg["paths"]["logs"]
    logger = setup_logging(log_dir)

    data_path = BASE_DIR / cfg["paths"]["dataset"]
    norm_dir = BASE_DIR / cfg["paths"]["norm_dir"]

    logger.info(f"Loading dataset from {data_path}")
    data = np.load(data_path)

    # splits
    Xf_tr, Xa_tr = data["X_face_train"], data["X_audio_train"]
    fm_tr, am_tr = data["face_mask_train"], data["audio_mask_train"]

    Xf_va, Xa_va = data["X_face_val"], data["X_audio_val"]
    fm_va, am_va = data["face_mask_val"], data["audio_mask_val"]

    # face normalization
    mean, std = load_face_norm(norm_dir)
    Xf_tr = apply_face_norm(Xf_tr, mean, std)
    Xf_va = apply_face_norm(Xf_va, mean, std)

    # features
    logger.info("Building features...")
    X_tr = build_features(Xf_tr, Xa_tr, fm_tr, am_tr)
    X_va = build_features(Xf_va, Xa_va, fm_va, am_va)

    logger.info(f"Feature dim: {X_tr.shape[1]}")

    # scaler
    logger.info("Fitting anomaly scaler...")
    scaler = StandardScaler()

    X_tr = scaler.fit_transform(X_tr)
    X_va = scaler.transform(X_va)

    # train
    logger.info("Training IsolationForest...")
    iso = IsolationForest(
        n_estimators=200,
        contamination="auto",
        random_state=cfg["misc"]["seed"],
        n_jobs=-1,
    )
    iso.fit(X_tr)

    scores_tr = iso.decision_function(X_tr)
    scores_va = iso.decision_function(X_va)

    logger.info(
        f"Val score stats → mean={scores_va.mean():.4f}, std={scores_va.std():.4f}"
    )

    # threshold
    TARGET_FPR = 0.10
    threshold = tune_threshold(scores_va, TARGET_FPR, logger)

    # modality analysis
    logger.info("Val anomaly rates by modality:")

    has_face = fm_va.sum(1) > 0
    has_audio = am_va.sum(1) > 0

    groups = {
        "audio_only": (~has_face & has_audio),
        "video_only": (has_face & ~has_audio),
        "both": (has_face & has_audio),
    }

    for name, mask in groups.items():
        if mask.sum() == 0:
            continue

        flagged = (scores_va[mask] < threshold).mean()
        logger.info(f"  [{name:<12}] n={mask.sum():4d} | flagged={flagged:.2%}")

    save_dir = BASE_DIR / "models" / "anomaly"
    save_dir.mkdir(parents=True, exist_ok=True)

    joblib.dump(iso, save_dir / "iso_forest.joblib")
    joblib.dump(scaler, save_dir / "scaler.joblib")

    meta = {
        "threshold": threshold,
        "target_fpr": TARGET_FPR,
        "feature_dim": int(X_tr.shape[1]),
        "train_samples": int(len(X_tr)),
        "val_samples": int(len(X_va)),
        "score_stats": {
            "val_mean": float(scores_va.mean()),
            "val_std": float(scores_va.std()),
        },
    }

    with open(save_dir / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    plot_scores(
        scores_tr,
        scores_va,
        threshold,
        log_dir / "anomaly_scores.png",
    )

    logger.info("Anomaly detector ready")


if __name__ == "__main__":
    main()
