from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from inference.ensemble import EmotionEnsemble
import anomaly.train_anomaly as ta

sys.modules["__main__"].ModalityAnomalyModel = ta.ModalityAnomalyModel


def setup_logging() -> None:
    """Configure root logger to stream INFO-level output with a timestamped format."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        handlers=[logging.StreamHandler()],
    )


logger = logging.getLogger(__name__)


def load_config() -> dict:
    """Load and return the project configuration from config.json.

    Returns:
        dict: Parsed configuration dictionary.

    Raises:
        FileNotFoundError: If config.json does not exist at the expected path.
    """
    path = ROOT / "config" / "config.json"
    if not path.exists():
        raise FileNotFoundError(f"config.json missing at {path}")
    with open(path) as f:
        return json.load(f)


cfg = load_config()

SEQ_LEN: int = cfg["processing"]["seq_len"]
FACE_DIM: int = cfg["processing"]["face_dim"]
AUDIO_DIM: int = cfg["processing"]["audio_dim"]


class InputValidationError(ValueError):
    pass


def validate_inputs(
    xf: np.ndarray,
    xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
) -> None:
    """Validate shapes, binary masks, coverage, and finite values of input arrays.

    Args:
        xf: Face feature array of shape (T, face_dim).
        xa: Audio feature array of shape (T, audio_dim).
        fm: Binary face mask of shape (T,).
        am: Binary audio mask of shape (T,).

    Raises:
        InputValidationError: If any shape, value, or coverage constraint is violated.
    """
    expected = {
        "xf": (SEQ_LEN, FACE_DIM),
        "xa": (SEQ_LEN, AUDIO_DIM),
        "fm": (SEQ_LEN,),
        "am": (SEQ_LEN,),
    }
    actual = {"xf": xf.shape, "xa": xa.shape, "fm": fm.shape, "am": am.shape}
    for k in expected:
        if expected[k] != actual[k]:
            raise InputValidationError(
                f"{k} shape mismatch: expected {expected[k]}, got {actual[k]}"
            )

    for name, mask in [("fm", fm), ("am", am)]:
        vals = set(np.unique(mask.astype(np.float32)))
        if not vals.issubset({0.0, 1.0}):
            raise InputValidationError(
                f"{name} must be binary (0/1), got unique values: {vals}"
            )

    if fm.sum() == 0 and am.sum() == 0:
        raise InputValidationError("No valid frames: both fm and am are all-zero")

    if np.isnan(xf).any() or np.isnan(xa).any():
        raise InputValidationError("NaN detected in input features")

    if np.isinf(xf).any() or np.isinf(xa).any():
        raise InputValidationError("Inf detected in input features")


def coerce(
    xf: np.ndarray,
    xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Cast all input arrays to float32.

    Args:
        xf: Face feature array of shape (T, face_dim).
        xa: Audio feature array of shape (T, audio_dim).
        fm: Face mask array of shape (T,).
        am: Audio mask array of shape (T,).

    Returns:
        tuple[np.ndarray, ...]: ``(xf, xa, fm, am)`` all cast to float32.
    """
    return (
        xf.astype(np.float32),
        xa.astype(np.float32),
        fm.astype(np.float32),
        am.astype(np.float32),
    )


from anomaly.train_anomaly import (  # noqa: E402
    build_anomaly_features as _build_anomaly_features_batch,
    MODALITY_AUDIO_ONLY,
    MODALITY_VIDEO_ONLY,
    MODALITY_BOTH,
)


def build_anomaly_features(
    xf: np.ndarray,
    xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
) -> np.ndarray:
    """Build the anomaly detection feature vector for a single sample.

    Args:
        xf: Face feature array of shape (T, face_dim).
        xa: Audio feature array of shape (T, audio_dim).
        fm: Binary face mask of shape (T,).
        am: Binary audio mask of shape (T,).

    Returns:
        np.ndarray: Feature matrix of shape (1, feature_dim).
    """
    return _build_anomaly_features_batch(
        xf[np.newaxis], xa[np.newaxis], fm[np.newaxis], am[np.newaxis]
    )


def error_response(msg: str) -> dict:
    """Build a standardised error response dict.

    Args:
        msg: Human-readable error description.

    Returns:
        dict: Response with all prediction fields set to ``None``,
            ``status="error"``, and ``error`` set to ``msg``.
    """
    return {
        "emotion": None,
        "confidence": None,
        "modality": None,
        "probs": None,
        "latency_ms": None,
        "anomaly": None,
        "anomaly_score": None,
        "status": "error",
        "error": msg,
    }


def _get_modality(fm: np.ndarray, am: np.ndarray) -> str:
    """Derive a human-readable modality label from mask arrays.

    Args:
        fm: Binary face mask of shape (T,).
        am: Binary audio mask of shape (T,).

    Returns:
        str: One of ``"both"``, ``"audio_only"``, ``"video_only"``, or ``"none"``.
    """
    has_face = fm.sum() > 0
    has_audio = am.sum() > 0
    if has_face and has_audio:
        return "both"
    if has_audio:
        return "audio_only"
    if has_face:
        return "video_only"
    return "none"


class EmotionPredictor:
    """Inference wrapper combining EmotionEnsemble with modality-stratified anomaly detection.

    Anomaly detection uses one IsolationForest per modality group (both,
    audio_only, video_only), each with its own threshold and optional PCA.
    A global fallback model handles cases where no per-modality model exists.
    Input features must be pre-normalised as produced by
    ``extract_embeddings_data.py``; no additional normalisation is applied.
    """

    def __init__(self) -> None:
        import joblib
        from anomaly.train_anomaly import (
            MODALITY_AUDIO_ONLY,
            MODALITY_VIDEO_ONLY,
            MODALITY_BOTH,
        )

        logger.info("Loading models …")
        t0 = time.perf_counter()

        self.ensemble = EmotionEnsemble()

        anomaly_dir = ROOT / cfg["paths"]["checkpoints"]["anomaly"]

        with open(anomaly_dir / "meta.json") as f:
            meta = json.load(f)

        from anomaly.train_anomaly import feature_dim_for, feature_version_hash

        expected_dim = feature_dim_for(FACE_DIM, AUDIO_DIM)
        if meta["feature_dim"] != expected_dim:
            raise RuntimeError(
                f"Anomaly meta.json feature_dim={meta['feature_dim']} but current "
                f"pipeline produces {expected_dim}. Re-run train_anomaly.py."
            )
        saved_hash = meta.get("feature_version_hash", "")
        current_hash = feature_version_hash(FACE_DIM, AUDIO_DIM)
        if saved_hash and saved_hash != current_hash:
            raise RuntimeError(
                f"Anomaly feature layout mismatch (saved={saved_hash}, "
                f"current={current_hash}). Re-run train_anomaly.py."
            )

        modality_name_map = {
            MODALITY_BOTH: "both",
            MODALITY_AUDIO_ONLY: "audio_only",
            MODALITY_VIDEO_ONLY: "video_only",
        }
        self._anomaly_models: dict = {}
        for mod_flag, mod_name in modality_name_map.items():
            model_path = anomaly_dir / f"iso_{mod_name}.joblib"
            if model_path.exists():
                self._anomaly_models[mod_flag] = joblib.load(model_path)

        fallback_path = anomaly_dir / "iso_global_fallback.joblib"
        self._anomaly_fallback = joblib.load(fallback_path)

        self._meta = meta
        logger.info(
            "Anomaly models loaded: %s + global_fallback",
            list(self._anomaly_models.keys()),
        )
        logger.info("All models loaded in %.1f ms", (time.perf_counter() - t0) * 1_000)

    def _get_anomaly_model(self, fm: np.ndarray, am: np.ndarray):
        """Return the per-modality anomaly model, falling back to the global model.

        Args:
            fm: Binary face mask of shape (T,).
            am: Binary audio mask of shape (T,).

        Returns:
            Anomaly model with ``score`` and ``is_anomaly`` methods.
        """
        has_face = bool(fm.sum() > 0)
        has_audio = bool(am.sum() > 0)
        if has_face and has_audio:
            mod_flag = MODALITY_BOTH
        elif has_audio:
            mod_flag = MODALITY_AUDIO_ONLY
        else:
            mod_flag = MODALITY_VIDEO_ONLY
        return self._anomaly_models.get(mod_flag, self._anomaly_fallback)

    def predict(
        self,
        xf: np.ndarray,
        xa: np.ndarray,
        fm: np.ndarray,
        am: np.ndarray,
    ) -> dict:
        """Run anomaly detection and ensemble emotion inference on a single sample.

        Args:
            xf: Normalised face features of shape (T, face_dim).
            xa: Normalised audio features of shape (T, audio_dim).
            fm: Binary face mask of shape (T,).
            am: Binary audio mask of shape (T,).

        Returns:
            dict: Keys are ``emotion``, ``confidence``, ``modality``, ``probs``,
                ``latency_ms``, ``anomaly``, ``anomaly_score``, ``status``,
                and ``error``. On failure, delegates to :func:`error_response`.
        """
        t0 = time.perf_counter()

        try:
            xf, xa, fm, am = coerce(xf, xa, fm, am)
            validate_inputs(xf, xa, fm, am)

            X_anom = build_anomaly_features(xf, xa, fm, am)
            anomaly_model = self._get_anomaly_model(fm, am)
            score = float(anomaly_model.score(X_anom)[0])
            is_anomaly = bool(anomaly_model.is_anomaly(X_anom)[0])

            if is_anomaly:
                logger.warning(
                    "Anomaly detected (score=%.4f, threshold=%.4f) — continuing inference",
                    score,
                    anomaly_model.threshold,
                )

            result = self.ensemble.predict(xf, xa, fm, am)

            return {
                "emotion": result.get("label"),
                "confidence": result.get("confidence"),
                "modality": _get_modality(fm, am),
                "probs": result.get("probs"),
                "latency_ms": round((time.perf_counter() - t0) * 1_000, 2),
                "anomaly": is_anomaly,
                "anomaly_score": round(score, 6),
                "status": "ok",
                "error": result.get("error"),
            }

        except InputValidationError as exc:
            logger.error("Validation error: %s", exc)
            return error_response(str(exc))

        except Exception as exc:
            logger.error("Inference error: %s", exc, exc_info=True)
            return error_response(str(exc))


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments for the prediction script.

    Returns:
        argparse.Namespace: Parsed argument values.
    """
    p = argparse.ArgumentParser(
        description="Run emotion prediction on pre-extracted .npy features."
    )
    p.add_argument(
        "--face", required=True, help="Path to face features .npy  (T, face_dim)"
    )
    p.add_argument(
        "--audio", required=True, help="Path to audio features .npy (T, audio_dim)"
    )
    p.add_argument("--face_mask", required=True, help="Path to face mask .npy  (T,)")
    p.add_argument("--audio_mask", required=True, help="Path to audio mask .npy (T,)")
    p.add_argument(
        "--json",
        action="store_true",
        help="Print result as JSON instead of human-readable output",
    )
    return p.parse_args()


def load_npy(path: str) -> np.ndarray:
    """Load a NumPy array from disk.

    Args:
        path: Path to the ``.npy`` file.

    Returns:
        np.ndarray: Loaded array.

    Raises:
        FileNotFoundError: If the file does not exist.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return np.load(p)


def pretty_print(res: dict) -> None:
    """Print a human-readable summary of a prediction result to stdout.

    Args:
        res: Result dict as returned by :meth:`EmotionPredictor.predict`.
    """
    if res["status"] == "error":
        print(f"\n  ERROR: {res['error']}\n")
        return

    anom_flag = "⚠  ANOMALY" if res.get("anomaly") else "ok"
    print("\n══════════════════════════════")
    print(f"  Emotion    : {res['emotion']}")
    print(f"  Confidence : {res['confidence']:.2%}")
    print(f"  Modality   : {res['modality']}")
    print(f"  Latency    : {res['latency_ms']} ms")
    print(f"  Anomaly    : {anom_flag}  (score={res['anomaly_score']:.4f})")
    print("──────────────────────────────")
    if res["probs"]:
        for k, v in sorted(res["probs"].items(), key=lambda x: -x[1]):
            bar = "█" * int(v * 24)
            print(f"  {k:<15} {v:.3f}  {bar}")
    print("══════════════════════════════\n")


def main() -> None:
    """Entry point: load features from disk, run prediction, and print results."""
    setup_logging()
    args = parse_args()

    xf = load_npy(args.face)
    xa = load_npy(args.audio)
    fm = load_npy(args.face_mask)
    am = load_npy(args.audio_mask)

    predictor = EmotionPredictor()
    res = predictor.predict(xf, xa, fm, am)

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        pretty_print(res)


if __name__ == "__main__":
    main()
