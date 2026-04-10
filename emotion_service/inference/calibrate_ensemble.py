
import json
import sys
from pathlib import Path
from pathlib import Path
import numpy as np
import torch
import joblib
from tqdm import tqdm

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

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


# DATA

def load_val_data():
    data = np.load(BASE_DIR / cfg["paths"]["dataset"])
    return (
        data["X_face_val"],
        data["X_audio_val"],
        data["face_mask_val"],
        data["audio_mask_val"],
        data["y_val"],
    )


def load_modal():
    from training.train_modal import EmotionTransformer, build_train_config

    train_cfg = build_train_config(cfg)
    model = EmotionTransformer(train_cfg).to(DEVICE)

    ckpt = BASE_DIR / cfg["paths"]["models"]["modal"]
    model.load_state_dict(torch.load(ckpt, map_location=DEVICE))
    model.eval()
    return model


def load_xgb():
    model = joblib.load(BASE_DIR / cfg["paths"]["models"]["xgb"])
    scaler = joblib.load(BASE_DIR / cfg["paths"]["models"]["scaler"])
    return model, scaler, None


# FEATURES


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
    return np.concatenate(
        [
            aggregate_sequence(Xf, fm),
            aggregate_sequence(Xa, am),
            temporal_delta(Xf, fm),
            temporal_delta(Xa, am),
            (fm.sum(1) > 0).astype(np.float32).reshape(-1, 1),
            (am.sum(1) > 0).astype(np.float32).reshape(-1, 1),
            ((fm.sum(1) > 0) & (am.sum(1) > 0)).astype(np.float32).reshape(-1, 1),
        ],
        axis=1,
    )


# FAST MODAL INFERENCE


def get_modal_probs(model, Xf, Xa, fm, am, batch_size=64):
    all_probs = []

    for start in tqdm(range(0, len(Xf), batch_size), desc="Modal"):
        end = min(start + batch_size, len(Xf))

        xf_n = apply_face_norm(Xf[start:end])

        xf_t = torch.tensor(xf_n, dtype=torch.float32).to(DEVICE)
        xa_t = torch.tensor(Xa[start:end], dtype=torch.float32).to(DEVICE)
        fm_t = torch.tensor(fm[start:end], dtype=torch.float32).to(DEVICE)
        am_t = torch.tensor(am[start:end], dtype=torch.float32).to(DEVICE)

        with torch.no_grad():
            p = torch.softmax(model(xf_t, xa_t, fm_t, am_t), dim=-1)

        all_probs.append(p.cpu().numpy())

    return np.concatenate(all_probs)


def get_xgb_probs(model, scaler, pca, Xf, Xa, fm, am):
    Xf = apply_face_norm(Xf)
    X = build_features(Xf, Xa, fm, am)
    X = scaler.transform(X)
    return model.predict_proba(X)


# CALIBRATION


def calibrate(p_modal, p_xgb, y):
    best_acc = 0
    best_w = (0.5, 0.5)

    for w in np.linspace(0, 1, 21):
        probs = w * p_modal + (1 - w) * p_xgb
        acc = (probs.argmax(1) == y).mean()

        if acc > best_acc:
            best_acc = acc
            best_w = (w, 1 - w)

    return best_w, best_acc


# MAIN


def main():
    Xf, Xa, fm, am, y = load_val_data()
    modal = load_modal()
    xgb, scaler, pca = load_xgb()

    p_modal = get_modal_probs(modal, Xf, Xa, fm, am)
    p_xgb = get_xgb_probs(xgb, scaler, pca, Xf, Xa, fm, am)

    (w_modal, w_xgb), acc = calibrate(p_modal, p_xgb, y)

    print(f"\n BEST: modal={w_modal:.2f}, xgb={w_xgb:.2f}, acc={acc:.4f}")

    save_dir = BASE_DIR / "models" / "ensemble"
    save_dir.mkdir(parents=True, exist_ok=True)

    json.dump(
        {"w_modal": float(w_modal), "w_xgb": float(w_xgb)},
        open(save_dir / "weights.json", "w"),
        indent=2,
    )


if __name__ == "__main__":
    main()
