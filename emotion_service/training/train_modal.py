

import os
import json
import logging
import math
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts
from sklearn.metrics import classification_report


def load_config():
    config_path = Path(__file__).resolve().parents[1] / "config" / "config.json"
    with open(config_path) as f:
        return json.load(f)


@dataclass
class TrainConfig:
    data_path: str
    norm_dir: str
    ckpt_dir: str
    log_dir: str

    face_dim: int
    audio_dim: int
    seq_len: int
    num_classes: int
    d_model: int

    nhead: int = 8
    num_encoder_layers: int = 6
    dim_feedforward: int = 768
    dropout: float = 0.2

    epochs: int = 80
    batch_size: int = 64
    lr: float = 3e-4
    weight_decay: float = 1e-4
    grad_clip: float = 1.0
    early_stop_patience: int = 12
    warmup_epochs: int = 5

    class_counts: list = field(
        default_factory=lambda: [1128, 576, 1128, 1128, 1128, 1692]
    )

    device: str = (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )


def build_train_config(cfg):
    return TrainConfig(
        data_path=cfg["paths"]["dataset"],
        norm_dir=cfg["paths"]["norm_dir"],
        # ckpt_dir=cfg["paths"]["checkpoints"],
        ckpt_dir=cfg["paths"]["checkpoints"]["modal"],
        log_dir=cfg["paths"]["logs"],
        face_dim=cfg["model"]["face_dim"],
        audio_dim=cfg["model"]["audio_dim"],
        seq_len=cfg["model"]["seq_len"],
        num_classes=cfg["model"]["num_classes"],
        d_model=cfg["model"]["d_model"],
        batch_size=cfg["training"]["batch_size"],
        epochs=cfg["training"]["epochs"],
        lr=cfg["training"]["lr"],
        weight_decay=cfg["training"]["weight_decay"],
        early_stop_patience=cfg["training"]["patience"],
        warmup_epochs=cfg["training"]["warmup_epochs"],
    )


def setup_logging(log_dir):
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(f"{log_dir}/train_modal.log"),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)



class EmotionDataset(Dataset):
    def __init__(self, Xf, Xa, fm, am, y, augment=False):
        self.Xf = torch.tensor(Xf, dtype=torch.float32)
        self.Xa = torch.tensor(Xa, dtype=torch.float32)
        self.fm = torch.tensor(fm, dtype=torch.float32)
        self.am = torch.tensor(am, dtype=torch.float32)
        self.y = torch.tensor(y, dtype=torch.long)
        self.augment = augment

    def __len__(self):
        return len(self.y)

    def __getitem__(self, i):
        xf = self.Xf[i].clone()
        xa = self.Xa[i].clone()
        fm = self.fm[i]
        am = self.am[i]
        y = self.y[i]

        if self.augment:
            xf = xf + torch.randn_like(xf) * 0.02 * fm.unsqueeze(-1)
            xa = xa + torch.randn_like(xa) * 0.01 * am.unsqueeze(-1)

        return xf, xa, fm, am, y


def compute_norm(X, mask, norm_dir):
    Path(norm_dir).mkdir(parents=True, exist_ok=True)

    valid = mask.reshape(-1) == 1
    flat = X.reshape(-1, X.shape[-1])

    mean = flat[valid].mean(0)
    std = flat[valid].std(0) + 1e-6

    np.save(f"{norm_dir}/face_mean.npy", mean)
    np.save(f"{norm_dir}/face_std.npy", std)

    return mean, std


def apply_norm(X, mean, std):
    return (X - mean) / std


class PositionalEncoding(nn.Module):
    def __init__(self, d_model, dropout=0.1, max_len=64):
        super().__init__()
        self.dropout = nn.Dropout(dropout)

        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(max_len).unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2) * (-math.log(10000.0) / d_model))

        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)

        self.register_buffer("pe", pe.unsqueeze(0))

    def forward(self, x):
        return self.dropout(x + self.pe[:, : x.size(1)])


class ModalityProjection(nn.Module):
    def __init__(self, in_dim, out_dim, dropout):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, out_dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(out_dim * 2, out_dim),
        )
        self.gate = nn.Sequential(nn.Linear(in_dim, out_dim), nn.Sigmoid())

    def forward(self, x):
        return self.net(x) * self.gate(x)


class EmotionTransformer(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        half = cfg.d_model // 2

        self.fp = ModalityProjection(cfg.face_dim, half, cfg.dropout)
        self.ap = ModalityProjection(cfg.audio_dim, half, cfg.dropout)

        self.pos = PositionalEncoding(half, cfg.dropout)

        encoder = nn.TransformerEncoderLayer(
            d_model=cfg.d_model,
            nhead=cfg.nhead,
            dim_feedforward=cfg.dim_feedforward,
            batch_first=True,
        )
        self.tr = nn.TransformerEncoder(encoder, cfg.num_encoder_layers)

        self.pool = nn.Linear(cfg.d_model, 1)

        self.cls = nn.Sequential(
            nn.LayerNorm(cfg.d_model), nn.Linear(cfg.d_model, cfg.num_classes)
        )

    def forward(self, f, a, fm, am):
        f = self.pos(self.fp(f))
        a = self.pos(self.ap(a))

        x = torch.cat([f, a], dim=-1)

        combined_mask = torch.maximum(fm, am)
        x = self.tr(x, src_key_padding_mask=(combined_mask == 0))

        attn_logits = self.pool(x).squeeze(-1)
        attn_logits = attn_logits.masked_fill(combined_mask == 0, -1e9)
        w = torch.softmax(attn_logits, dim=1)

        pooled = (x * w.unsqueeze(-1)).sum(1)

        return self.cls(pooled)


# TRAINING

def compute_weights(counts, device):
    w = 1 / np.array(counts)
    w = w / w.sum() * len(counts)
    return torch.tensor(w, dtype=torch.float32).to(device)


class EarlyStop:
    def __init__(self, patience, path):
        self.p = patience
        self.best = float("inf")
        self.c = 0
        self.path = path

    def step(self, loss, model):
        import os

        if loss < self.best:
            self.best = loss
            self.c = 0
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            torch.save(model.state_dict(), self.path)
            print(f"Model saved at {self.path}")

            return False
        self.c += 1
        return self.c >= self.p


def main():
    cfg = build_train_config(load_config())
    logger = setup_logging(cfg.log_dir)

    project_root = Path(__file__).resolve().parents[1]
    data_path = project_root / cfg.data_path

    logger.info(f"Loading dataset from: {data_path}")

    if not data_path.exists():
        raise FileNotFoundError(f"\n Dataset NOT found at:\n{data_path}\n")

    data = np.load(data_path)

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

    mean, std = compute_norm(Xf_tr, fm_tr, cfg.norm_dir)

    Xf_tr = apply_norm(Xf_tr, mean, std)
    Xf_va = apply_norm(Xf_va, mean, std)
    Xf_te = apply_norm(Xf_te, mean, std)

    train = DataLoader(
        EmotionDataset(Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, True),
        batch_size=cfg.batch_size,
        shuffle=True,
    )
    val = DataLoader(
        EmotionDataset(Xf_va, Xa_va, fm_va, am_va, y_va), batch_size=cfg.batch_size
    )
    test = DataLoader(
        EmotionDataset(Xf_te, Xa_te, fm_te, am_te, y_te), batch_size=cfg.batch_size
    )

    model = EmotionTransformer(cfg).to(cfg.device)

    loss_fn = nn.CrossEntropyLoss(weight=compute_weights(cfg.class_counts, cfg.device))
    opt = AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    sched = CosineAnnealingWarmRestarts(opt, 20)

    early = EarlyStop(cfg.early_stop_patience, f"{cfg.ckpt_dir}/best_modal.pt")

    for e in range(cfg.epochs):
        model.train()
        for xf, xa, fm, am, y in train:
            xf, xa, fm, am, y = (
                xf.to(cfg.device),
                xa.to(cfg.device),
                fm.to(cfg.device),
                am.to(cfg.device),
                y.to(cfg.device),
            )

            loss = loss_fn(model(xf, xa, fm, am), y)

            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), cfg.grad_clip)

            opt.step()

        #VALIDATION
        model.eval()
        val_loss = 0
        correct = 0
        total = 0

        with torch.no_grad():
            for xf, xa, fm, am, y in val:
                xf, xa, fm, am, y = (
                    xf.to(cfg.device),
                    xa.to(cfg.device),
                    fm.to(cfg.device),
                    am.to(cfg.device),
                    y.to(cfg.device),
                )

                logits = model(xf, xa, fm, am)
                loss = loss_fn(logits, y)

                val_loss += loss.item()
                preds = logits.argmax(1)
                correct += (preds == y).sum().item()
                total += len(y)

        val_loss /= len(val)
        val_acc = correct / total

        logger.info(f"Epoch {e+1} | Val Loss {val_loss:.4f} | Val Acc {val_acc:.4f}")

        if early.step(val_loss, model):
            break

        sched.step()

    # TEST
    model.load_state_dict(
        torch.load(f"{cfg.ckpt_dir}/best_modal.pt", map_location=cfg.device)
    )

    preds, labels = [], []

    with torch.no_grad():
        for xf, xa, fm, am, y in test:
            xf, xa, fm, am = (
                xf.to(cfg.device),
                xa.to(cfg.device),
                fm.to(cfg.device),
                am.to(cfg.device),
            )
            p = model(xf, xa, fm, am).argmax(1)
            preds.extend(p.cpu().numpy())
            labels.extend(y.numpy())

    preds, labels = np.array(preds), np.array(labels)

    acc = (preds == labels).mean()
    logger.info(f"\n TEST ACC: {acc:.4f}")
    logger.info("\n" + classification_report(labels, preds))

    logger.info(" DONE")


if __name__ == "__main__":
    main()
