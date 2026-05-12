from __future__ import annotations

import json
import logging
import threading
import time
import warnings
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
import torch

BASE_DIR = Path(__file__).resolve().parents[1]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def _load_config() -> dict:
    """Load and return the project configuration from config.json.

    Returns:
        dict: Parsed configuration dictionary.
    """
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


cfg = _load_config()

DEVICE: str = (
    "mps"
    if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available() else "cpu"
)

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2


def _import_xgb_builders():
    """Lazily import the batch feature builder from the training module.

    Deferred to avoid requiring training dependencies at module import time,
    allowing ensemble.py to be used from inference entry points.

    Returns:
        Callable: ``training.train_xgb.build_features`` batch function.
    """
    from training.train_xgb import build_features as _build_features_batch

    return _build_features_batch


def build_features_batch(
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    mod: np.ndarray,
) -> np.ndarray:
    """Build the XGBoost feature matrix for a batch of samples.

    Delegates to ``training.train_xgb.build_features`` to guarantee an
    identical feature layout to what the model was trained on.

    Args:
        Xf: Face feature sequences of shape (N, T, face_dim).
        Xa: Audio feature sequences of shape (N, T, audio_dim).
        fm: Binary face masks of shape (N, T).
        am: Binary audio masks of shape (N, T).
        mod: Modality flags of shape (N,) with values from
            ``MODALITY_AUDIO_ONLY``, ``MODALITY_VIDEO_ONLY``, or ``MODALITY_BOTH``.

    Returns:
        np.ndarray: Feature matrix of shape (N, n_features).
    """
    return _import_xgb_builders()(Xf, Xa, fm, am, mod)


def build_features_single(
    xf: np.ndarray,
    xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    mod_flag: int,
) -> np.ndarray:
    """Build the XGBoost feature vector for a single sample.

    Args:
        xf: Face feature sequence of shape (T, face_dim).
        xa: Audio feature sequence of shape (T, audio_dim).
        fm: Binary face mask of shape (T,).
        am: Binary audio mask of shape (T,).
        mod_flag: Modality constant — one of ``MODALITY_AUDIO_ONLY``,
            ``MODALITY_VIDEO_ONLY``, or ``MODALITY_BOTH``.

    Returns:
        np.ndarray: Feature matrix of shape (1, n_features).
    """
    mod = np.array([mod_flag], dtype=np.int32)
    return build_features_batch(
        xf[np.newaxis],
        xa[np.newaxis],
        fm[np.newaxis],
        am[np.newaxis],
        mod,
    )


def _infer_modality_flag(fm: np.ndarray, am: np.ndarray) -> int:
    """Derive the modality integer from mask arrays for a single sample.

    Args:
        fm: Binary face mask of shape (T,).
        am: Binary audio mask of shape (T,).

    Returns:
        int: One of ``MODALITY_BOTH``, ``MODALITY_AUDIO_ONLY``, or
            ``MODALITY_VIDEO_ONLY``.
    """
    has_face = bool(fm.sum() > 0)
    has_audio = bool(am.sum() > 0)
    if has_face and has_audio:
        return MODALITY_BOTH
    if has_audio:
        return MODALITY_AUDIO_ONLY
    return MODALITY_VIDEO_ONLY


def _infer_modality_flags(fm: np.ndarray, am: np.ndarray) -> np.ndarray:
    """Derive modality integer flags from batch mask arrays.

    Args:
        fm: Binary face masks of shape (N, T).
        am: Binary audio masks of shape (N, T).

    Returns:
        np.ndarray: Modality flags of shape (N,) with dtype int32.
    """
    has_face = fm.sum(axis=1) > 0
    has_audio = am.sum(axis=1) > 0
    mod = np.where(
        has_face & has_audio,
        MODALITY_BOTH,
        np.where(has_audio, MODALITY_AUDIO_ONLY, MODALITY_VIDEO_ONLY),
    ).astype(np.int32)
    return mod


_MODAL_SINGLETON: Optional[torch.nn.Module] = None
_XGB_SINGLETON = None
_PCA_SINGLETON = None
_COL_MEDIANS_SINGLETON: Optional[np.ndarray] = None
_SINGLETON_LOCK = threading.Lock()


def _get_modal() -> torch.nn.Module:
    """Load and cache the EmotionTransformer model as a process-level singleton.

    Returns:
        torch.nn.Module: Loaded model in eval mode on ``DEVICE``.
    """
    global _MODAL_SINGLETON
    if _MODAL_SINGLETON is None:
        with _SINGLETON_LOCK:
            if _MODAL_SINGLETON is None:
                from training.train_modal import EmotionTransformer, build_train_config

                model = EmotionTransformer(build_train_config(cfg)).to(DEVICE)
                model.load_state_dict(
                    torch.load(
                        BASE_DIR / cfg["paths"]["models"]["modal"],
                        map_location=DEVICE,
                    )
                )
                model.eval()
                _MODAL_SINGLETON = model
                logger.info("Modal model loaded (singleton) on %s", DEVICE)
    return _MODAL_SINGLETON


def _get_xgb():
    """Load and cache the XGBoost model, PCA transformer, and column medians.

    PCA and column medians are loaded only when the corresponding artifacts
    exist on disk. Column medians are required whenever PCA is present.

    Returns:
        tuple: ``(xgb_model, pca, col_medians)`` where ``pca`` and
            ``col_medians`` may be ``None`` if PCA is disabled.

    Raises:
        FileNotFoundError: If PCA is present but ``col_medians.npy`` is missing.
    """
    global _XGB_SINGLETON, _PCA_SINGLETON, _COL_MEDIANS_SINGLETON
    if _XGB_SINGLETON is None:
        with _SINGLETON_LOCK:
            if _XGB_SINGLETON is None:
                _XGB_SINGLETON = joblib.load(BASE_DIR / cfg["paths"]["models"]["xgb"])

                pca_path = BASE_DIR / cfg["paths"]["models"]["pca"]
                _PCA_SINGLETON = joblib.load(pca_path) if pca_path.exists() else None

                if _PCA_SINGLETON is not None:
                    xgb_dir = BASE_DIR / cfg["paths"]["checkpoints"]["xgb"]
                    medians_path = xgb_dir / "col_medians.npy"
                    if not medians_path.exists():
                        raise FileNotFoundError(
                            f"PCA is present but col_medians.npy not found at "
                            f"{medians_path}. Re-run train_xgb.py to regenerate it."
                        )
                    _COL_MEDIANS_SINGLETON = np.load(medians_path)

                logger.info(
                    "XGB loaded (singleton) — PCA: %s  col_medians: %s",
                    "yes" if _PCA_SINGLETON is not None else "no",
                    "yes" if _COL_MEDIANS_SINGLETON is not None else "no",
                )
    return _XGB_SINGLETON, _PCA_SINGLETON, _COL_MEDIANS_SINGLETON


def _temperature_scale(logits: torch.Tensor, T: float) -> np.ndarray:
    """Apply temperature scaling and convert logits to a probability array.

    Args:
        logits: Raw model output tensor of shape (N, num_classes).
        T: Temperature scalar; values > 1 soften the distribution.

    Returns:
        np.ndarray: Probability array of shape (N, num_classes), dtype float32.
    """
    return torch.softmax(logits / T, dim=-1).cpu().numpy().astype(np.float32)


def _check_no_nan(arr: np.ndarray, tag: str) -> None:
    """Raise if any NaN values are present in a probability array.

    Args:
        arr: Array to validate.
        tag: Descriptive label used in the error message.

    Raises:
        RuntimeError: If ``arr`` contains any NaN values.
    """
    if np.isnan(arr).any():
        raise RuntimeError(f"NaN detected in {tag} probabilities")


def _select_weights(
    has_face: bool,
    has_audio: bool,
    w_modal: float,
    w_xgb: float,
) -> tuple[float, float]:
    """Return per-modality ensemble weights based on available input streams.

    Falls back to unimodal weights when only one stream is present, and to
    equal weights when neither stream is available.

    Args:
        has_face: Whether face features are present for this sample.
        has_audio: Whether audio features are present for this sample.
        w_modal: Calibrated transformer weight for the bimodal case.
        w_xgb: Calibrated XGBoost weight for the bimodal case.

    Returns:
        tuple[float, float]: ``(w_modal, w_xgb)`` weights that sum to 1.
    """
    if has_face and has_audio:
        return w_modal, w_xgb
    if has_audio:
        return 0.0, 1.0
    if has_face:
        return 1.0, 0.0
    return 0.5, 0.5


def _sync_now() -> float:
    """Synchronise the CUDA stream if applicable and return the current time.

    Returns:
        float: Wall-clock time from ``time.perf_counter()``.
    """
    if DEVICE == "cuda":
        torch.cuda.synchronize()
    return time.perf_counter()


def _on_prediction(label: str, confidence: float, latency_ms: float) -> None:
    """Emit a debug-level log entry for a completed prediction.

    Args:
        label: Predicted emotion class name.
        confidence: Probability of the predicted class.
        latency_ms: End-to-end inference latency in milliseconds.
    """
    logger.debug(
        "prediction | label=%-14s confidence=%.4f  latency_ms=%.2f",
        label,
        confidence,
        latency_ms,
    )


class EmotionEnsemble:
    """Thread-safe ensemble of EmotionTransformer and XGBoost classifiers.

    Combines transformer and gradient-boosted tree predictions via a weighted
    average. Weights and temperature are loaded from a calibration file
    produced by ``calibrate_ensemble.py``. All public methods are safe to
    call from multiple threads concurrently.

    Args:
        warmup: If ``True``, run a dummy forward pass on init to pre-compile
            kernels and avoid cold-start latency on the first real call.
    """

    def __init__(self, warmup: bool = True) -> None:
        self.modal = _get_modal()
        self.xgb, self.pca, self.col_medians = _get_xgb()
        self.class_names: list[str] = cfg["misc"]["class_names"]
        self.w_modal, self.w_xgb, self.temperature = self._load_weights()
        self._lock = threading.Lock()
        if warmup:
            self._warmup()

    def _load_weights(self) -> tuple[float, float, float]:
        """Load calibrated ensemble weights from disk.

        Returns:
            tuple[float, float, float]: ``(w_modal, w_xgb, temperature)``.

        Raises:
            RuntimeError: If ``weights.json`` exists but is missing required keys.
        """
        path = BASE_DIR / cfg["paths"]["checkpoints"]["ensemble"] / "weights.json"
        if path.exists():
            w = json.loads(path.read_text())
            for k in ("w_modal", "w_xgb", "temperature"):
                if k not in w:
                    raise RuntimeError(
                        f"Missing key in weights.json: '{k}'. Re-run calibrate_ensemble.py."
                    )
            logger.info(
                "Ensemble weights loaded: modal=%.2f  xgb=%.2f  T=%.3f",
                w["w_modal"],
                w["w_xgb"],
                w["temperature"],
            )
            return float(w["w_modal"]), float(w["w_xgb"]), float(w["temperature"])

        warnings.warn(
            "Ensemble weights not found — using defaults (0.5/0.5, T=1.0). "
            "Run calibrate_ensemble.py first.",
            RuntimeWarning,
            stacklevel=2,
        )
        return 0.5, 0.5, 1.0

    def _warmup(self) -> None:
        """Run a dummy inference pass to pre-compile kernels and reduce cold-start latency."""
        seq = cfg["processing"]["seq_len"]
        fd = cfg["processing"]["face_dim"]
        ad = cfg["processing"]["audio_dim"]
        logger.info("Warming up ensemble …")
        self.predict(
            np.zeros((seq, fd), dtype=np.float32),
            np.zeros((seq, ad), dtype=np.float32),
            np.ones(seq, dtype=np.float32),
            np.ones(seq, dtype=np.float32),
        )
        logger.info("Warmup complete")

    def _forward_modal(
        self,
        xf_t: torch.Tensor,
        xa_t: torch.Tensor,
        fm_t: torch.Tensor,
        am_t: torch.Tensor,
    ) -> torch.Tensor:
        """Run a thread-safe forward pass through the EmotionTransformer.

        Args:
            xf_t: Face feature tensor of shape (N, T, face_dim) on ``DEVICE``.
            xa_t: Audio feature tensor of shape (N, T, audio_dim) on ``DEVICE``.
            fm_t: Face mask tensor of shape (N, T) on ``DEVICE``.
            am_t: Audio mask tensor of shape (N, T) on ``DEVICE``.

        Returns:
            torch.Tensor: Fusion logits of shape (N, num_classes).
        """
        with self._lock:
            with torch.no_grad():
                fusion_logits, _, _, _, _, _ = self.modal(xf_t, xa_t, fm_t, am_t)
        return fusion_logits

    def _xgb_probs(self, X: np.ndarray) -> np.ndarray:
        """Apply optional PCA preprocessing and return XGBoost class probabilities.

        When PCA is enabled, NaN values in ``X`` are imputed with training
        column medians before the PCA transform is applied.

        Args:
            X: Feature matrix of shape (N, n_features).

        Returns:
            np.ndarray: Class probability matrix of shape (N, num_classes), dtype float32.
        """
        if self.pca is not None:
            nan_mask = np.isnan(X)
            if nan_mask.any():
                X = X.copy()
                X[nan_mask] = np.take(self.col_medians, np.where(nan_mask)[1])
            X = self.pca.transform(X)
        return self.xgb.predict_proba(X).astype(np.float32)

    def predict(
        self,
        xf: np.ndarray,
        xa: np.ndarray,
        fm: np.ndarray,
        am: np.ndarray,
    ) -> dict:
        """Run ensemble inference on a single sample.

        Args:
            xf: Normalised face features of shape (T, face_dim).
            xa: Normalised audio features of shape (T, audio_dim).
            fm: Binary face mask of shape (T,).
            am: Binary audio mask of shape (T,).

        Returns:
            dict: Keys are ``label`` (str), ``confidence`` (float),
                ``probs`` (dict mapping class name to probability), and
                ``latency_ms`` (float). On failure, returns ``error`` (str)
                with ``label`` and ``confidence`` set to ``None``.
        """
        try:
            xf = xf.astype(np.float32)
            xa = xa.astype(np.float32)
            fm = fm.astype(np.float32)
            am = am.astype(np.float32)

            t0 = _sync_now()

            logits = self._forward_modal(
                torch.from_numpy(xf).float().unsqueeze(0).to(DEVICE),
                torch.from_numpy(xa).float().unsqueeze(0).to(DEVICE),
                torch.from_numpy(fm).unsqueeze(0).to(DEVICE),
                torch.from_numpy(am).unsqueeze(0).to(DEVICE),
            )
            p_modal = _temperature_scale(logits, self.temperature)[0]
            _check_no_nan(p_modal, "modal")

            mod_flag = _infer_modality_flag(fm, am)
            X = build_features_single(xf, xa, fm, am, mod_flag)
            p_xgb = self._xgb_probs(X)[0]
            _check_no_nan(p_xgb, "xgb")

            w_m, w_x = _select_weights(
                bool(fm.sum() > 0), bool(am.sum() > 0), self.w_modal, self.w_xgb
            )
            probs = w_m * p_modal + w_x * p_xgb
            _check_no_nan(probs, "ensemble")

            idx = int(np.argmax(probs))
            latency_ms = (_sync_now() - t0) * 1_000

            result = {
                "label": self.class_names[idx],
                "confidence": float(probs[idx]),
                "probs": {
                    name: float(round(float(probs[i]), 4))
                    for i, name in enumerate(self.class_names)
                },
                "latency_ms": round(latency_ms, 2),
            }
            _on_prediction(result["label"], result["confidence"], latency_ms)
            return result

        except Exception as exc:
            logger.exception("predict() failed: %s", exc)
            return {"error": str(exc), "label": None, "confidence": None}

    def predict_batch(
        self,
        Xf: np.ndarray,
        Xa: np.ndarray,
        fm: np.ndarray,
        am: np.ndarray,
        batch_size: Optional[int] = None,
    ) -> list[dict]:
        """Run ensemble inference on a batch of samples.

        XGBoost features are computed in a single vectorised call. Transformer
        inference is chunked into mini-batches to respect GPU memory limits.

        Args:
            Xf: Normalised face features of shape (N, T, face_dim).
            Xa: Normalised audio features of shape (N, T, audio_dim).
            fm: Binary face masks of shape (N, T).
            am: Binary audio masks of shape (N, T).
            batch_size: Transformer mini-batch size. Defaults to
                ``config["training"]["batch_size"]`` when ``None``.

        Returns:
            list[dict]: One result dict per sample with the same keys as
                :meth:`predict`. Failed samples contain ``error``, ``label=None``,
                and ``confidence=None``.
        """
        bs = batch_size or cfg["training"]["batch_size"]
        N = len(Xf)

        Xf = Xf.astype(np.float32)
        Xa = Xa.astype(np.float32)
        fm = fm.astype(np.float32)
        am = am.astype(np.float32)

        mod = _infer_modality_flags(fm, am)

        X_all = build_features_batch(Xf, Xa, fm, am, mod)
        p_xgb_all = self._xgb_probs(X_all)

        p_modal_all = np.zeros((N, len(self.class_names)), dtype=np.float32)
        for start in range(0, N, bs):
            end = min(start + bs, N)
            logits = self._forward_modal(
                torch.from_numpy(Xf[start:end]).to(DEVICE),
                torch.from_numpy(Xa[start:end]).to(DEVICE),
                torch.from_numpy(fm[start:end]).to(DEVICE),
                torch.from_numpy(am[start:end]).to(DEVICE),
            )
            p_modal_all[start:end] = _temperature_scale(logits, self.temperature)

        results: list[dict] = []
        for i in range(N):
            try:
                p_m = p_modal_all[i]
                p_x = p_xgb_all[i]
                _check_no_nan(p_m, f"modal[{i}]")
                _check_no_nan(p_x, f"xgb[{i}]")

                w_m, w_x = _select_weights(
                    bool(fm[i].sum() > 0),
                    bool(am[i].sum() > 0),
                    self.w_modal,
                    self.w_xgb,
                )
                probs = w_m * p_m + w_x * p_x
                _check_no_nan(probs, f"ensemble[{i}]")

                idx = int(np.argmax(probs))
                results.append(
                    {
                        "label": self.class_names[idx],
                        "confidence": float(probs[idx]),
                        "probs": {
                            name: float(round(float(probs[j]), 4))
                            for j, name in enumerate(self.class_names)
                        },
                    }
                )
            except Exception as exc:
                logger.exception("predict_batch() failed at index %d: %s", i, exc)
                results.append({"error": str(exc), "label": None, "confidence": None})

        return results
