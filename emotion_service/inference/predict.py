
import argparse
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np
import joblib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from inference.ensemble import EmotionEnsemble



def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        handlers=[logging.StreamHandler()],
    )

logger = logging.getLogger(__name__)



def load_config():
    path = ROOT / "config" / "config.json"
    if not path.exists():
        raise FileNotFoundError(f"config.json missing at {path}")
    with open(path) as f:
        return json.load(f)


cfg = load_config()

SEQ_LEN = cfg["model"]["seq_len"]
FACE_DIM = cfg["model"]["face_dim"]
AUDIO_DIM = cfg["model"]["audio_dim"]

class InputValidationError(ValueError):
    pass


def validate_inputs(xf, xa, fm, am):
    expected = {
        "xf": (SEQ_LEN, FACE_DIM),
        "xa": (SEQ_LEN, AUDIO_DIM),
        "fm": (SEQ_LEN,),
        "am": (SEQ_LEN,),
    }

    actual = {
        "xf": xf.shape,
        "xa": xa.shape,
        "fm": fm.shape,
        "am": am.shape,
    }

    for k in expected:
        if expected[k] != actual[k]:
            raise InputValidationError(
                f"{k} shape mismatch: expected {expected[k]}, got {actual[k]}"
            )

    for name, mask in [("fm", fm), ("am", am)]:
        vals = set(np.unique(mask))
        if not vals.issubset({0.0, 1.0}):
            raise InputValidationError(f"{name} must be binary")

    if fm.sum() == 0 and am.sum() == 0:
        raise InputValidationError("No valid frames")

    if np.isnan(xf).any() or np.isnan(xa).any():
        raise InputValidationError("NaN detected")

    if np.isinf(xf).any() or np.isinf(xa).any():
        raise InputValidationError("Inf detected")


def coerce(xf, xa, fm, am):
    return (
        xf.astype(np.float32),
        xa.astype(np.float32),
        fm.astype(np.float32),
        am.astype(np.float32),
    )


# ANOMALY FEATURES

def build_anomaly_features(xf, xa, fm, am):

    def _aggregate(X, m):
        if m.sum() == 0:
            return np.zeros(X.shape[1] * 4, dtype=np.float32)

        valid = X[m == 1]

        return np.concatenate(
            [
                valid.mean(0),
                valid.std(0) if len(valid) > 1 else np.zeros(X.shape[1]),
                valid.min(0),
                valid.max(0),
            ]
        ).astype(np.float32)

    def _temporal_delta(X, m):
        idx = np.where(m == 1)[0]
        if len(idx) >= 2:
            return (X[idx[-1]] - X[idx[0]]).astype(np.float32)
        return np.zeros(X.shape[1], dtype=np.float32)

    return np.concatenate(
        [
            _aggregate(xf, fm),
            _aggregate(xa, am),
            _temporal_delta(xf, fm),
            _temporal_delta(xa, am),
        ],
        axis=0,
    ).reshape(1, -1)


def error_response(msg):
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


class EmotionPredictor:
    def __init__(self):
        logger.info("Loading models...")

        t0 = time.perf_counter()

        self.ensemble = EmotionEnsemble()

        anomaly_dir = ROOT / "models" / "anomaly"

        self.iso = joblib.load(anomaly_dir / "iso_forest.joblib")
        self.anomaly_scaler = joblib.load(anomaly_dir / "scaler.joblib")

        with open(anomaly_dir / "meta.json") as f:
            meta = json.load(f)

        self.threshold = meta["threshold"]

        elapsed = (time.perf_counter() - t0) * 1000
        logger.info(f"Loaded in {elapsed:.1f} ms")

    def _get_modality(self, fm, am):
        has_face = fm.sum() > 0
        has_audio = am.sum() > 0

        if has_face and has_audio:
            return "both"
        if has_audio:
            return "audio_only"
        if has_face:
            return "video_only"
        return "none"

    def predict(self, xf, xa, fm, am):
        t0 = time.perf_counter()

        try:
            xf, xa, fm, am = coerce(xf, xa, fm, am)
            validate_inputs(xf, xa, fm, am)

            # ANOMALY FIRST 
            X = build_anomaly_features(xf, xa, fm, am)
            X = self.anomaly_scaler.transform(X)

            score = float(self.iso.decision_function(X)[0])
            is_anomaly = score < self.threshold

            if is_anomaly:
                logger.warning(
                    f"Anomaly detected (score={score:.4f}) — continuing inference"
                )

            result = self.ensemble.predict(xf, xa, fm, am)

            return {
                "emotion": result["label"],
                "confidence": result["confidence"],
                "modality": self._get_modality(fm, am),
                "probs": result["probs"],
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                "anomaly": is_anomaly,
                "anomaly_score": score,
                "status": "ok",
                "error": None,
            }

        except Exception as e:
            logger.error(f"Inference error: {e}", exc_info=True)
            return error_response(str(e))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--face", required=True)
    p.add_argument("--audio", required=True)
    p.add_argument("--face_mask", required=True)
    p.add_argument("--audio_mask", required=True)
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def load_npy(path):
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    return np.load(p)


def pretty_print(res):
    if res["status"] == "error":
        print(f"\n ERROR: {res['error']}\n")
        return

    if res["status"] == "anomaly":
        print("\n ANOMALY DETECTED")
        print(f"Score: {res['anomaly_score']:.4f}")
        print(f"Modality: {res['modality']}")
        print(f"Latency: {res['latency_ms']} ms\n")
        return

    print("\n======")
    print(f"Emotion    : {res['emotion']}")
    print(f"Confidence : {res['confidence']:.2%}")
    print(f"Modality   : {res['modality']}")
    print(f"Latency    : {res['latency_ms']} ms")
    print("-----")

    for k, v in sorted(res["probs"].items(), key=lambda x: -x[1]):
        print(f"{k:<15} {v:.3f}")

    print("=====\n")


def main():
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
