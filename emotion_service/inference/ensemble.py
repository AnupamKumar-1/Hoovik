
import json
import time
import warnings
from pathlib import Path
import numpy as np
import torch
import joblib

BASE_DIR = Path(__file__).resolve().parents[1]


def load_config():
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


cfg = load_config()

DEVICE = "cpu"

# NORMALIZATION

def load_face_norm():
    mean = np.load(BASE_DIR / cfg["paths"]["norm_dir"] / "face_mean.npy")
    std = np.load(BASE_DIR / cfg["paths"]["norm_dir"] / "face_std.npy")
    return mean, std


FACE_MEAN, FACE_STD = load_face_norm()


def apply_face_norm(x):
    return (x - FACE_MEAN) / FACE_STD


# MODEL LOAD


def load_modal():
    from training.train_modal import EmotionTransformer, build_train_config

    model = EmotionTransformer(build_train_config(cfg)).to(DEVICE)
    model.load_state_dict(
        torch.load(BASE_DIR / cfg["paths"]["models"]["modal"], map_location=DEVICE)
    )
    model.eval()
    return model


def load_xgb():
    model = joblib.load(BASE_DIR / cfg["paths"]["models"]["xgb"])
    scaler = joblib.load(BASE_DIR / cfg["paths"]["models"]["scaler"])

    # pca_path = BASE_DIR / cfg["paths"]["models"]["pca"]
    # pca = joblib.load(pca_path) if pca_path.exists() else None
    pca = None
    return model, scaler, pca


# FEATURE BUILD


def _aggregate(X, m):
    if m.sum() == 0:
        return np.zeros(X.shape[1] * 4, dtype=np.float32)

    valid = X[m == 1]

    return np.concatenate(
        [
            valid.mean(0),
            valid.std(0) if len(valid) > 1 else np.zeros(X.shape[1], dtype=np.float32),
            valid.min(0),
            valid.max(0),
        ]
    ).astype(np.float32)


def _temporal_delta(X, m):
    idx = np.where(m == 1)[0]
    if len(idx) >= 2:
        return (X[idx[-1]] - X[idx[0]]).astype(np.float32)
    return np.zeros(X.shape[1], dtype=np.float32)


def build_features(Xf, Xa, fm, am):
    f = _aggregate(Xf, fm)
    a = _aggregate(Xa, am)

    # Explicit modality flags (float32)
    has_face = fm.sum() > 0
    has_audio = am.sum() > 0

    modality_flags = np.array(
        [
            has_face,
            has_audio,
            has_face & has_audio,
        ],
        dtype=np.float32,
    )

    return np.concatenate(
        [
            f.astype(np.float32),
            a.astype(np.float32),
            _temporal_delta(Xf, fm).astype(np.float32),
            _temporal_delta(Xa, am).astype(np.float32),
            modality_flags,
        ],
        axis=0,
    ).reshape(1, -1)


# ENSEMBLE


class EmotionEnsemble:
    def __init__(self):
        self.modal = load_modal()
        self.xgb, self.scaler, self.pca = load_xgb()
        self.class_names = cfg["misc"]["class_names"]
        self.w_modal, self.w_xgb = self._load_weights()

    def _load_weights(self):
        path = BASE_DIR / "models" / "ensemble" / "weights.json"

        if path.exists():
            w = json.load(open(path))
            return w["w_modal"], w["w_xgb"]

        warnings.warn(
            "Using uncalibrated ensemble weights. Run calibrate_ensemble.py for best performance."
        )
        return 0.5, 0.5  # neutral fallback

    # PREDICT

    def predict(self, xf, xa, fm, am):
        start = time.perf_counter()

        # Normalize ONCE
        xf_n = apply_face_norm(xf)

        # Modal
        with torch.no_grad():
            p_modal = (
                torch.softmax(
                    self.modal(
                        torch.tensor(xf_n, dtype=torch.float32).unsqueeze(0).to(DEVICE),
                        torch.tensor(xa, dtype=torch.float32).unsqueeze(0).to(DEVICE),
                        torch.tensor(fm, dtype=torch.float32).unsqueeze(0).to(DEVICE),
                        torch.tensor(am, dtype=torch.float32).unsqueeze(0).to(DEVICE),
                    ),
                    dim=-1,
                )
                .cpu()
                .numpy()[0]
            )

        # XGB
        X = build_features(xf_n, xa, fm, am)
        X = self.scaler.transform(X)

        #if self.pca is not None:
            #X = self.pca.transform(X)

        p_xgb = self.xgb.predict_proba(X)[0]

        # Fusion
        has_face = fm.sum() > 0
        has_audio = am.sum() > 0


        # Only "both modality" case is calibrated.
        # Single modality weights are heuristic (not calibrated separately).
        if has_face and has_audio:
            w_m, w_x = self.w_modal, self.w_xgb
        elif has_audio:
            w_m, w_x = 0.2, 0.8
        elif has_face:
            w_m, w_x = 0.8, 0.2
        else:
            w_m, w_x = 0.5, 0.5

        probs = w_m * p_modal + w_x * p_xgb
        idx = int(np.argmax(probs))

        latency = (time.perf_counter() - start) * 1000

        return {
            "label": self.class_names[idx],
            "confidence": float(probs[idx]),
            "probs": {
                name: float(round(probs[i], 4))
                for i, name in enumerate(self.class_names)
            },
            "latency_ms": round(latency, 2),
        }
