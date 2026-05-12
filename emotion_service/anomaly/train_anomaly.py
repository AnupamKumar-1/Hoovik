"""Modality-stratified anomaly detector for the emotion pipeline."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import matplotlib.pyplot as plt
import numpy as np
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

BASE_DIR = Path(__file__).resolve().parents[1]

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2

MODALITY_NAMES: Dict[int, str] = {
    MODALITY_AUDIO_ONLY: "audio_only",
    MODALITY_VIDEO_ONLY: "video_only",
    MODALITY_BOTH: "both",
}

FEATURE_VERSION = "v2.0-iqr-ratio-jitter"


def _agg_block(X: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Compute per-dimension aggregate statistics over valid frames.

    Args:
        X: Frame embeddings of shape (T, D).
        mask: Binary validity mask of shape (T,).

    Returns:
        1-D float32 vector of length D*6 + 1 containing
        mean | std | min | max | iqr (each D-dim), valid_ratio (scalar),
        and temporal_jitter (D-dim).
    """
    T, D = X.shape
    valid_idx = np.where(mask == 1)[0]
    n_valid = len(valid_idx)

    if n_valid == 0:
        return np.zeros(D * 6 + 1, dtype=np.float32)

    valid = X[valid_idx]

    mean_ = valid.mean(0)
    std_ = valid.std(0) if n_valid > 1 else np.zeros(D, dtype=np.float32)
    min_ = valid.min(0)
    max_ = valid.max(0)

    if n_valid >= 3:
        q75 = np.percentile(valid, 75, axis=0)
        q25 = np.percentile(valid, 25, axis=0)
        iqr_ = (q75 - q25).astype(np.float32)
    else:
        iqr_ = np.zeros(D, dtype=np.float32)

    ratio_ = np.float32(n_valid / T)

    if n_valid >= 3:
        diffs = np.diff(valid, axis=0)
        jitter_ = diffs.std(0).astype(np.float32)
    else:
        jitter_ = np.zeros(D, dtype=np.float32)

    return np.concatenate([mean_, std_, min_, max_, iqr_, [ratio_], jitter_]).astype(
        np.float32
    )


def _delta_block(X: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Compute first-to-last valid frame difference for a single sample.

    Args:
        X: Frame embeddings of shape (T, D).
        mask: Binary validity mask of shape (T,).

    Returns:
        1-D float32 vector of length D.
    """
    T, D = X.shape
    valid_idx = np.where(mask == 1)[0]
    if len(valid_idx) >= 2:
        return (X[valid_idx[-1]] - X[valid_idx[0]]).astype(np.float32)
    return np.zeros(D, dtype=np.float32)


def build_anomaly_features(
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
) -> np.ndarray:
    """Build anomaly feature matrix for a batch of samples.

    Feature layout per sample:
        face_agg   (D_face*6 + 1): mean|std|min|max|iqr|ratio|jitter
        audio_agg  (D_audio*6 + 1): mean|std|min|max|iqr|ratio|jitter
        face_delta  (D_face): first-to-last frame difference
        audio_delta (D_audio): first-to-last frame difference

    Total feature dim = (D_face + D_audio) * 7 + 2.

    Args:
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
        fm: Face validity masks of shape (N, T).
        am: Audio validity masks of shape (N, T).

    Returns:
        Float32 array of shape (N, feature_dim).
    """
    N = len(Xf)
    if N == 0:
        feat_dim = feature_dim_for(Xf.shape[-1], Xa.shape[-1])
        return np.empty((0, feat_dim), dtype=np.float32)

    feat_dim = feature_dim_for(Xf.shape[-1], Xa.shape[-1])
    out = np.empty((N, feat_dim), dtype=np.float32)

    for i in range(N):
        out[i] = np.concatenate(
            [
                _agg_block(Xf[i], fm[i]),
                _agg_block(Xa[i], am[i]),
                _delta_block(Xf[i], fm[i]),
                _delta_block(Xa[i], am[i]),
            ]
        )
    return out


def feature_dim_for(face_dim: int, audio_dim: int) -> int:
    """Return the expected feature dimension without running the full builder.

    Args:
        face_dim: Dimensionality of face embeddings.
        audio_dim: Dimensionality of audio embeddings.

    Returns:
        Integer feature dimension.
    """
    return (face_dim * 6 + 1) + (audio_dim * 6 + 1) + face_dim + audio_dim


def feature_version_hash(face_dim: int, audio_dim: int) -> str:
    """Return a short deterministic hash of the feature spec for compatibility checks.

    Args:
        face_dim: Dimensionality of face embeddings.
        audio_dim: Dimensionality of audio embeddings.

    Returns:
        8-character hex string.
    """
    spec = f"{FEATURE_VERSION}|face={face_dim}|audio={audio_dim}"
    return hashlib.md5(spec.encode()).hexdigest()[:8]


def setup_logging(log_dir: Path) -> logging.Logger:
    """Configure file and stream logging handlers.

    Args:
        log_dir: Directory where the log file will be written.

    Returns:
        Configured Logger instance.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(str(log_dir / "train_anomaly.log")),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)


def load_config() -> dict:
    """Load the project configuration file.

    Returns:
        Parsed config as a dictionary.
    """
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


class ModalityAnomalyModel:
    """IsolationForest anomaly detector with optional PCA, scoped to one modality group.

    Applies per-source (RAVDESS / CREMA-D) StandardScaler during training to
    remove systematic distribution gaps between datasets, then falls back to a
    global scaler at inference when actor IDs are unavailable.

    Args:
        name: Modality group identifier (e.g. ``"both"``).
        n_components: Number of PCA components. ``None`` skips PCA.
        seed: Random seed for reproducibility.
        target_fpr: Val-set false-positive rate used to set the anomaly threshold.
        n_estimators: Number of trees in the IsolationForest.
    """

    def __init__(
        self,
        name: str,
        n_components: int | None,
        seed: int,
        target_fpr: float = 0.10,
        n_estimators: int = 200,
    ):
        self.name = name
        self.n_components = n_components
        self.seed = seed
        self.target_fpr = target_fpr
        self.scaler = StandardScaler()
        self.pca: PCA | None = None
        self.iso = IsolationForest(
            n_estimators=n_estimators,
            contamination="auto",
            random_state=seed,
            n_jobs=-1,
        )
        self.threshold: float = float("nan")

    def fit(
        self,
        X_tr: np.ndarray,
        X_va: np.ndarray,
        logger: logging.Logger,
        act_tr: np.ndarray | None = None,
        act_va: np.ndarray | None = None,
        actor_id_threshold: int | None = None,
    ) -> None:
        """Fit scaler, optional PCA, and IsolationForest on training data.

        When actor arrays are provided a per-source StandardScaler is fitted
        to neutralise dataset-level distribution differences before the
        IsolationForest sees the data. The global scaler is then fitted on the
        per-source-normalised training data so that inference (no actor IDs)
        produces a compatible distribution.

        Args:
            X_tr: Training feature matrix of shape (N_tr, D).
            X_va: Validation feature matrix of shape (N_va, D).
            logger: Logger for progress and diagnostic output.
            act_tr: Actor IDs for training samples; enables per-source scaling.
            act_va: Actor IDs for validation samples.
            actor_id_threshold: Actor IDs below this value are treated as RAVDESS.
        """
        self._actor_id_threshold = (
            actor_id_threshold if actor_id_threshold is not None else 1000
        )

        if act_tr is not None:
            rav_tr = act_tr < self._actor_id_threshold
            cre_tr = ~rav_tr
            has_rav_tr = rav_tr.sum() > 0
            has_cre_tr = cre_tr.sum() > 0

            self._scaler_rav = StandardScaler() if has_rav_tr else None
            self._scaler_cre = StandardScaler() if has_cre_tr else None

            X_tr_s = np.zeros(X_tr.shape, dtype=np.float32)
            if has_rav_tr:
                X_tr_s[rav_tr] = self._scaler_rav.fit_transform(X_tr[rav_tr])
            if has_cre_tr:
                X_tr_s[cre_tr] = self._scaler_cre.fit_transform(X_tr[cre_tr])

            X_va_s = np.zeros(X_va.shape, dtype=np.float32)
            if act_va is not None and len(X_va) > 0:
                rav_va = act_va < self._actor_id_threshold
                cre_va = ~rav_va
                fallback_scaler = (
                    self._scaler_rav
                    if self._scaler_rav is not None
                    else self._scaler_cre
                )
                for mask_va, scaler in [
                    (rav_va, self._scaler_rav),
                    (cre_va, self._scaler_cre),
                ]:
                    if mask_va.sum() == 0:
                        continue
                    sc = scaler if scaler is not None else fallback_scaler
                    X_va_s[mask_va] = sc.transform(X_va[mask_va])
            else:
                X_va_s = self.scaler.transform(X_va)

            self.scaler.fit(X_tr_s)
            self._per_source_scaled = True
            X_tr_s_final = X_tr_s
            X_va_s_final = X_va_s
        else:
            self._per_source_scaled = False
            self._scaler_rav = None
            self._scaler_cre = None
            X_tr_s_final = self.scaler.fit_transform(X_tr)
            X_va_s_final = self.scaler.transform(X_va)

        n_comp = self.n_components
        if n_comp is not None and n_comp < min(X_tr_s_final.shape):
            self.pca = PCA(n_components=n_comp, random_state=self.seed)
            X_tr_s_final = self.pca.fit_transform(X_tr_s_final)
            X_va_s_final = self.pca.transform(X_va_s_final)
            explained = self.pca.explained_variance_ratio_.sum()
            logger.info(
                "[%s] PCA %d→%d  explained_var=%.3f",
                self.name,
                X_tr.shape[1],
                n_comp,
                explained,
            )
        else:
            logger.info("[%s] PCA skipped (n_components=%s)", self.name, n_comp)

        self.iso.fit(X_tr_s_final)

        scores_va = self.iso.decision_function(X_va_s_final)
        self.threshold = float(np.percentile(scores_va, self.target_fpr * 100))
        flagged = float((scores_va < self.threshold).mean())
        if self.threshold < 0:
            logger.warning(
                "[%s] threshold=%.5f is NEGATIVE — val scores are tightly clustered "
                "near zero; consider increasing PCA components for this modality "
                "or inspecting feature variance.",
                self.name,
                self.threshold,
            )
            logger.warning(
                "[%s] Current pca_components=%d. To fix: raise "
                "anomaly.pca_components.%s in config.json (try doubling it).",
                self.name,
                self.n_components,
                self.name,
            )
        logger.info(
            "[%s] threshold=%.5f | val flagged=%.2f%%  (n_tr=%d n_va=%d)",
            self.name,
            self.threshold,
            flagged * 100,
            len(X_tr),
            len(X_va),
        )

    def transform(self, X: np.ndarray, actors: np.ndarray | None = None) -> np.ndarray:
        """Apply scaler and optional PCA to feature matrix.

        When actor IDs are provided, per-source scalers are used to reproduce
        the exact distribution seen during training. Without actor IDs the
        global scaler is applied as the best available approximation.

        Args:
            X: Feature matrix of shape (N, D).
            actors: Optional actor ID array of shape (N,).

        Returns:
            Transformed feature matrix of shape (N, n_components or D).
        """
        if self._per_source_scaled and actors is not None:
            X_s = np.zeros(X.shape, dtype=np.float32)
            rav_mask = actors < self._actor_id_threshold
            cre_mask = ~rav_mask
            fallback = (
                self._scaler_rav if self._scaler_rav is not None else self._scaler_cre
            )
            for mask, scaler in [
                (rav_mask, self._scaler_rav),
                (cre_mask, self._scaler_cre),
            ]:
                if mask.sum() == 0:
                    continue
                sc = scaler if scaler is not None else fallback
                X_s[mask] = sc.transform(X[mask])
        else:
            X_s = self.scaler.transform(X)
        if self.pca is not None:
            X_s = self.pca.transform(X_s)
        return X_s

    def score(self, X: np.ndarray, actors: np.ndarray | None = None) -> np.ndarray:
        """Return IsolationForest decision function scores (higher = more normal).

        Args:
            X: Feature matrix of shape (N, D).
            actors: Optional actor ID array of shape (N,).

        Returns:
            Score array of shape (N,).
        """
        return self.iso.decision_function(self.transform(X, actors=actors))

    def is_anomaly(self, X: np.ndarray, actors: np.ndarray | None = None) -> np.ndarray:
        """Return boolean anomaly flags based on the fitted threshold.

        Args:
            X: Feature matrix of shape (N, D).
            actors: Optional actor ID array of shape (N,).

        Returns:
            Boolean array of shape (N,).
        """
        return self.score(X, actors=actors) < self.threshold


def log_class_breakdown(
    scores: np.ndarray,
    labels: np.ndarray,
    threshold: float,
    class_names: List[str],
    logger: logging.Logger,
    tag: str,
) -> None:
    """Log per-class anomaly flagging rates.

    Args:
        scores: Anomaly scores of shape (N,).
        labels: Integer class labels of shape (N,).
        threshold: Score threshold below which a sample is flagged.
        class_names: Ordered list of class name strings.
        logger: Logger instance.
        tag: Prefix label used in log output.
    """
    logger.info("%s anomaly rates by class:", tag)
    for cls_idx, name in enumerate(class_names):
        mask = labels == cls_idx
        if mask.sum() == 0:
            continue
        flagged = (scores[mask] < threshold).mean()
        logger.info("  [%-16s] n=%4d | flagged=%.2f%%", name, mask.sum(), flagged * 100)


def log_source_breakdown(
    scores: np.ndarray,
    actors: np.ndarray,
    threshold: float,
    actor_id_threshold: int,
    logger: logging.Logger,
    tag: str,
) -> None:
    """Log per-source-dataset (RAVDESS / CREMA-D) anomaly flagging rates.

    Args:
        scores: Anomaly scores of shape (N,).
        actors: Actor ID array of shape (N,).
        threshold: Score threshold below which a sample is flagged.
        actor_id_threshold: Actor IDs below this value are treated as RAVDESS.
        logger: Logger instance.
        tag: Prefix label used in log output.
    """
    logger.info("%s anomaly rates by source dataset:", tag)
    for source, mask in [
        ("RAVDESS", actors < actor_id_threshold),
        ("CREMA-D", actors >= actor_id_threshold),
    ]:
        if mask.sum() == 0:
            continue
        flagged = (scores[mask] < threshold).mean()
        logger.info(
            "  [%-10s] n=%4d | flagged=%.2f%%", source, mask.sum(), flagged * 100
        )


def plot_scores_by_modality(
    groups: Dict[str, Tuple[np.ndarray, np.ndarray, float]],
    log_dir: Path,
) -> None:
    """Save score-distribution histogram and boxplot figures, one subplot per modality.

    Args:
        groups: Mapping from modality name to (train_scores, val_scores, threshold).
        log_dir: Directory where PNG files will be written.
    """
    active = {k: v for k, v in groups.items() if len(v[0]) > 0}
    if not active:
        return

    n = len(active)
    fig, axes = plt.subplots(1, n, figsize=(5 * n, 4), sharey=False)
    if n == 1:
        axes = [axes]

    for ax, (name, (scores_tr, scores_va, thr)) in zip(axes, active.items()):
        ax.hist(scores_tr, bins=50, alpha=0.5, label="train", density=True)
        ax.hist(scores_va, bins=50, alpha=0.5, label="val", density=True)
        ax.axvline(thr, color="red", linestyle="--", label=f"thr={thr:.4f}")
        ax.set_title(f"Anomaly scores — {name}")
        ax.set_xlabel("Score (higher = more normal)")
        ax.set_ylabel("Density")
        ax.legend(fontsize=8)

    plt.tight_layout()
    plt.savefig(log_dir / "anomaly_scores_by_modality.png", dpi=120)
    plt.close()

    fig2, axes2 = plt.subplots(1, n, figsize=(4 * n, 3))
    if n == 1:
        axes2 = [axes2]
    for ax, (name, (scores_tr, scores_va, thr)) in zip(axes2, active.items()):
        ax.boxplot([scores_tr, scores_va], tick_labels=["train", "val"], vert=False)
        ax.axvline(thr, color="red", linestyle="--", label=f"thr={thr:.4f}")
        ax.set_title(name)
        ax.legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(log_dir / "anomaly_scores_boxplot_by_modality.png", dpi=120)
    plt.close()


def main() -> None:
    """Train per-modality anomaly detectors and persist models and metadata."""
    cfg = load_config()
    log_dir = BASE_DIR / cfg["paths"]["logs"]
    logger = setup_logging(log_dir)

    seed: int = cfg["misc"]["seed"]
    class_names: List[str] = cfg["misc"]["class_names"]
    actor_id_threshold: int = cfg["misc"]["actor_id_threshold"]

    anomaly_cfg = cfg["anomaly"]
    target_fpr: float = anomaly_cfg["target_fpr"]
    pca_components: Dict[str, int] = anomaly_cfg["pca_components"]
    n_estimators: int = anomaly_cfg["n_estimators"]
    min_train_samples: int = anomaly_cfg["min_train_samples"]
    min_val_samples: int = anomaly_cfg["min_val_samples"]

    data_path = BASE_DIR / cfg["paths"]["dataset"]
    logger.info("Loading dataset from %s", data_path)
    data = np.load(data_path)

    Xf_tr = data["X_face_train"]
    Xa_tr = data["X_audio_train"]
    fm_tr = data["face_mask_train"]
    am_tr = data["audio_mask_train"]
    y_tr = data["y_train"]
    act_tr = data["actor_train"]
    mod_tr = data["modality_train"]

    Xf_va = data["X_face_val"]
    Xa_va = data["X_audio_val"]
    fm_va = data["face_mask_val"]
    am_va = data["audio_mask_val"]
    y_va = data["y_val"]
    act_va = data["actor_val"]
    mod_va = data["modality_val"]

    logger.info("Building anomaly features …")
    F_tr = build_anomaly_features(Xf_tr, Xa_tr, fm_tr, am_tr)
    F_va = build_anomaly_features(Xf_va, Xa_va, fm_va, am_va)

    face_dim = Xf_tr.shape[-1]
    audio_dim = Xa_tr.shape[-1]
    feat_dim = F_tr.shape[1]
    expected_dim = feature_dim_for(face_dim, audio_dim)
    assert (
        feat_dim == expected_dim
    ), f"Feature dim mismatch: builder returned {feat_dim}, formula gives {expected_dim}"

    logger.info(
        "Feature dim: %d  (face_dim=%d audio_dim=%d)  |  train=%d  val=%d",
        feat_dim,
        face_dim,
        audio_dim,
        len(F_tr),
        len(F_va),
    )

    modality_flags = [MODALITY_BOTH, MODALITY_AUDIO_ONLY, MODALITY_VIDEO_ONLY]

    fitted_models: Dict[int, ModalityAnomalyModel] = {}
    score_groups: Dict[str, Tuple[np.ndarray, np.ndarray, float]] = {}

    global_model = ModalityAnomalyModel(
        "global_fallback",
        pca_components["global_fallback"],
        seed,
        target_fpr=target_fpr,
        n_estimators=n_estimators,
    )
    global_model.fit(
        F_tr,
        F_va,
        logger,
        act_tr=act_tr,
        act_va=act_va,
        actor_id_threshold=actor_id_threshold,
    )
    _global_scores_tr = global_model.score(F_tr, actors=act_tr)
    _global_scores_va = global_model.score(F_va, actors=act_va)

    for mod_flag in modality_flags:
        name = MODALITY_NAMES[mod_flag]
        tr_mask = mod_tr == mod_flag
        va_mask = mod_va == mod_flag

        n_tr = int(tr_mask.sum())
        n_va = int(va_mask.sum())

        if n_tr < min_train_samples or n_va < min_val_samples:
            logger.warning(
                "[%s] Too few samples (train=%d val=%d) — will use global_fallback at inference",
                name,
                n_tr,
                n_va,
            )
            score_groups[name] = (np.array([]), np.array([]), float("nan"))
            continue

        logger.info("─- Modality: %s | train=%d val=%d ────", name, n_tr, n_va)

        model = ModalityAnomalyModel(
            name=name,
            n_components=pca_components[name],
            seed=seed,
            target_fpr=target_fpr,
            n_estimators=n_estimators,
        )
        model.fit(
            F_tr[tr_mask],
            F_va[va_mask],
            logger,
            act_tr=act_tr[tr_mask],
            act_va=act_va[va_mask],
            actor_id_threshold=actor_id_threshold,
        )
        fitted_models[mod_flag] = model

        scores_tr = model.score(F_tr[tr_mask], actors=act_tr[tr_mask])
        scores_va = model.score(F_va[va_mask], actors=act_va[va_mask])
        score_groups[name] = (scores_tr, scores_va, model.threshold)

        log_class_breakdown(
            scores_va, y_va[va_mask], model.threshold, class_names, logger, name
        )
        log_source_breakdown(
            scores_va,
            act_va[va_mask],
            model.threshold,
            actor_id_threshold,
            logger,
            name,
        )

    plot_scores_by_modality(score_groups, log_dir)

    save_dir = BASE_DIR / cfg["paths"]["checkpoints"]["anomaly"]
    save_dir.mkdir(parents=True, exist_ok=True)

    per_modality_meta: Dict[str, dict] = {}
    for mod_flag, model in fitted_models.items():
        name = MODALITY_NAMES[mod_flag]
        model_path = save_dir / f"iso_{name}.joblib"
        joblib.dump(model, model_path)
        logger.info("Saved %s → %s", name, model_path)

        scores_tr, scores_va, thr = score_groups[name]
        per_modality_meta[name] = {
            "threshold": float(thr),
            "pca_components": model.n_components,
            "n_train": int((mod_tr == mod_flag).sum()),
            "n_val": int((mod_va == mod_flag).sum()),
            "score_stats": {
                "train_mean": float(scores_tr.mean()),
                "train_std": float(scores_tr.std()),
                "val_mean": float(scores_va.mean()),
                "val_std": float(scores_va.std()),
            },
        }

    joblib.dump(global_model, save_dir / "iso_global_fallback.joblib")

    fv_hash = feature_version_hash(face_dim, audio_dim)
    meta = {
        "feature_version": FEATURE_VERSION,
        "feature_version_hash": fv_hash,
        "feature_dim": feat_dim,
        "face_dim": face_dim,
        "audio_dim": audio_dim,
        "pca_components": pca_components,
        "target_fpr": target_fpr,
        "modality_models": [str(k) for k in fitted_models.keys()],
        "modality_names": {str(k): MODALITY_NAMES[k] for k in fitted_models},
        "per_modality": per_modality_meta,
        "global_fallback": {
            "threshold": global_model.threshold,
            "score_stats": {
                "train_mean": float(_global_scores_tr.mean()),
                "val_mean": float(_global_scores_va.mean()),
            },
        },
        "train_samples": int(len(F_tr)),
        "val_samples": int(len(F_va)),
        "seed": seed,
    }

    meta_path = save_dir / "meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    logger.info("Anomaly detector saved to %s", save_dir)
    logger.info("  feature_version : %s", FEATURE_VERSION)
    logger.info("  feature_dim     : %d", feat_dim)
    logger.info("  feature_hash    : %s", fv_hash)
    logger.info("  modality models : %s", list(fitted_models.keys()))
    logger.info("DONE")


if __name__ == "__main__":
    main()
