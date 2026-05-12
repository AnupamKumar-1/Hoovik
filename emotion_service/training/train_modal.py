import copy
import json
import logging
import math
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torch.optim import AdamW
from sklearn.metrics import classification_report, confusion_matrix

BASE_DIR = Path(__file__).resolve().parents[1]

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2


def load_config():
    """Load JSON config from ``<BASE_DIR>/config/config.json``.

    Returns:
        dict: Parsed configuration dictionary.
    """
    with open(BASE_DIR / "config" / "config.json") as f:
        return json.load(f)


@dataclass
class TrainConfig:
    """Flat dataclass holding all hyper-parameters and runtime settings.

    Attributes:
        data_path: Path to the preprocessed dataset (.npz).
        ckpt_dir: Directory for saving model checkpoints.
        log_dir: Directory for log files.
        face_dim: Feature dimensionality of face embeddings.
        audio_dim: Feature dimensionality of audio embeddings.
        seq_len: Temporal sequence length.
        num_classes: Number of emotion classes.
        d_model: Transformer model dimension.
        nhead: Number of attention heads.
        num_encoder_layers: Number of Transformer encoder layers.
        dim_feedforward: Feedforward hidden dimension.
        dropout: Dropout probability.
        face_scale: Multiplicative scale applied to face projections.
        cross_gate_weight: Weight for cross-modal gating.
        conf_blend_weight: Weight for confidence-based blending.
        epochs_a: Training epochs for Phase A.
        epochs_b: Training epochs for Phase B.
        epochs_c: Training epochs for Phase C.
        batch_size: Mini-batch size.
        lr_a: Learning rate for Phase A.
        lr_b: Learning rate for Phase B.
        lr_c: Learning rate for Phase C.
        weight_decay: AdamW weight decay.
        grad_clip: Gradient clipping max norm.
        label_smoothing: Label smoothing factor for cross-entropy.
        early_stop_patience: Patience epochs for early stopping.
        warmup_epochs: LR warmup epochs for Phase A/C.
        warmup_epochs_b: LR warmup epochs for Phase B.
        mixup_alpha: Beta distribution alpha for Mixup.
        mixup_prob: Probability of applying Mixup per batch.
        mixup_warmup_epochs: Epochs before Mixup is activated.
        supcon_temp_start: Starting temperature for SupCon loss.
        supcon_temp_floor: Minimum temperature for SupCon loss.
        supcon_temp_decay: Per-epoch decay rate for SupCon temperature.
        lambda_sc_max: Maximum weight for SupCon loss.
        lambda_sc_ramp_epochs: Epochs to ramp SupCon weight to max.
        triplet_weight: Weight for triplet loss.
        triplet_margin: Margin for triplet loss.
        sad_margin: Separation margin for the sad class.
        disgust_margin: Separation margin for the disgust class.
        fear_margin: Separation margin for the fear class.
        sad_sep_w: Weight for sad separation loss.
        fear_sep_w: Weight for fear separation loss.
        disgust_sep_w: Weight for disgust separation loss.
        modality_drop_prob: Per-sample modality dropout probability.
        augment_noise_face_low: Low Gaussian noise std for face (quiet frames).
        augment_noise_face_high: High Gaussian noise std for face (active frames).
        augment_noise_face_thresh: Activity threshold switching face noise level.
        augment_noise_audio_low: Low Gaussian noise std for audio (quiet frames).
        augment_noise_audio_high: High Gaussian noise std for audio (active frames).
        augment_noise_audio_thresh: Activity threshold switching audio noise level.
        augment_drop_face_prob: Probability of zeroing the entire face modality.
        augment_drop_audio_prob: Probability of zeroing the entire audio modality.
        augment_roll_prob: Probability of applying temporal roll.
        augment_roll_max: Maximum frames for temporal roll.
        augment_mask_prob: Probability of applying temporal masking.
        augment_mask_max_frac: Maximum fraction of frames to mask.
        class_counts: Per-class sample counts for class weighting.
        class_boost: Additive per-class weight multipliers.
        num_workers: DataLoader worker processes.
        persistent_workers: Keep DataLoader workers alive between epochs.
        prefetch_factor: Batches to prefetch per worker.
        ravdess_weight_a: RAVDESS over-sampling weight for Phase A.
        ravdess_weight_b: RAVDESS over-sampling weight for Phase B.
        patience_c: Early stopping patience for Phase C.
        min_delta_c: Minimum accuracy improvement for Phase C early stopping.
        swa_tail: Number of tail epochs to include in SWA averaging.
        temp_lr: LBFGS learning rate for temperature scaling.
        temp_max_iter: Maximum LBFGS iterations for temperature scaling.
        actor_id_threshold: Actor ID below which samples belong to RAVDESS.
        device: Compute device (mps > cuda > cpu).
    """

    data_path: str
    ckpt_dir: str
    log_dir: str
    face_dim: int
    audio_dim: int
    seq_len: int
    num_classes: int
    d_model: int
    nhead: int
    num_encoder_layers: int
    dim_feedforward: int
    dropout: float
    face_scale: float
    cross_gate_weight: float
    conf_blend_weight: float
    epochs_a: int
    epochs_b: int
    epochs_c: int
    batch_size: int
    lr_a: float
    lr_b: float
    lr_c: float
    weight_decay: float
    grad_clip: float
    label_smoothing: float
    early_stop_patience: int
    warmup_epochs: int
    warmup_epochs_b: int
    mixup_alpha: float
    mixup_prob: float
    mixup_warmup_epochs: int
    supcon_temp_start: float
    supcon_temp_floor: float
    supcon_temp_decay: float
    lambda_sc_max: float
    lambda_sc_ramp_epochs: int
    triplet_weight: float
    triplet_margin: float
    sad_margin: float
    disgust_margin: float
    fear_margin: float
    sad_sep_w: float
    fear_sep_w: float
    disgust_sep_w: float
    modality_drop_prob: float
    augment_noise_face_low: float
    augment_noise_face_high: float
    augment_noise_face_thresh: float
    augment_noise_audio_low: float
    augment_noise_audio_high: float
    augment_noise_audio_thresh: float
    augment_drop_face_prob: float
    augment_drop_audio_prob: float
    augment_roll_prob: float
    augment_roll_max: int
    augment_mask_prob: float
    augment_mask_max_frac: float
    class_counts: List[int]
    class_boost: List[float]
    num_workers: int
    persistent_workers: bool
    prefetch_factor: int
    ravdess_weight_a: float
    ravdess_weight_b: float
    patience_c: int
    min_delta_c: float
    swa_tail: int
    temp_lr: float
    temp_max_iter: int
    actor_id_threshold: int
    device: str = (
        "mps"
        if torch.backends.mps.is_available()
        else "cuda" if torch.cuda.is_available() else "cpu"
    )


def build_train_config(cfg) -> TrainConfig:
    """Construct a :class:`TrainConfig` from a raw config dictionary.

    Args:
        cfg: Nested dictionary loaded from ``config.json``.

    Returns:
        TrainConfig: Fully populated training configuration.
    """
    proc = cfg["processing"]
    mdl = cfg["model"]
    trn = cfg["training"]
    misc = cfg["misc"]
    sep = cfg.get("separation_losses", {})
    dl = cfg.get("dataloader", {})
    return TrainConfig(
        data_path=cfg["paths"]["dataset"],
        ckpt_dir=cfg["paths"]["checkpoints"]["modal"],
        log_dir=cfg["paths"]["logs"],
        face_dim=proc["face_dim"],
        audio_dim=proc["audio_dim"],
        seq_len=proc["seq_len"],
        num_classes=mdl["num_classes"],
        d_model=mdl["d_model"],
        nhead=mdl["nhead"],
        num_encoder_layers=mdl["num_encoder_layers"],
        dim_feedforward=mdl["dim_feedforward"],
        dropout=mdl["dropout"],
        face_scale=mdl["face_scale"],
        cross_gate_weight=mdl["cross_gate_weight"],
        conf_blend_weight=mdl["conf_blend_weight"],
        epochs_a=trn["epochs_a"],
        epochs_b=trn["epochs_b"],
        epochs_c=trn["epochs_c"],
        batch_size=trn["batch_size"],
        lr_a=trn["lr_a"],
        lr_b=trn["lr_b"],
        lr_c=trn["lr_c"],
        weight_decay=trn["weight_decay"],
        label_smoothing=trn["label_smoothing"],
        early_stop_patience=trn["patience"],
        warmup_epochs=trn["warmup_epochs"],
        warmup_epochs_b=trn.get("warmup_epochs_b", trn["warmup_epochs"]),
        grad_clip=trn["grad_clip"],
        mixup_alpha=trn["mixup_alpha"],
        mixup_prob=trn["mixup_prob"],
        mixup_warmup_epochs=trn.get("mixup_warmup_epochs", 0),
        supcon_temp_start=trn["supcon_temp_start"],
        supcon_temp_floor=trn["supcon_temp_floor"],
        supcon_temp_decay=trn["supcon_temp_decay"],
        lambda_sc_max=trn["lambda_sc_max"],
        lambda_sc_ramp_epochs=trn["lambda_sc_ramp_epochs"],
        triplet_weight=trn["triplet_weight"],
        triplet_margin=trn["triplet_margin"],
        modality_drop_prob=trn["modality_drop_prob"],
        augment_noise_face_low=trn["augment_noise_face_low"],
        augment_noise_face_high=trn["augment_noise_face_high"],
        augment_noise_face_thresh=trn["augment_noise_face_thresh"],
        augment_noise_audio_low=trn["augment_noise_audio_low"],
        augment_noise_audio_high=trn["augment_noise_audio_high"],
        augment_noise_audio_thresh=trn["augment_noise_audio_thresh"],
        augment_drop_face_prob=trn["augment_drop_face_prob"],
        augment_drop_audio_prob=trn["augment_drop_audio_prob"],
        augment_roll_prob=trn["augment_roll_prob"],
        augment_roll_max=trn["augment_roll_max"],
        augment_mask_prob=trn["augment_mask_prob"],
        augment_mask_max_frac=trn["augment_mask_max_frac"],
        class_counts=misc["class_counts"],
        class_boost=misc["class_boost"],
        actor_id_threshold=misc["actor_id_threshold"],
        sad_margin=sep.get("sad_margin", 0.34),
        disgust_margin=sep.get("disgust_margin", 0.199),
        fear_margin=sep.get("fear_margin", 0.15),
        sad_sep_w=sep.get("sad_sep_w", 0.055),
        fear_sep_w=sep.get("fear_sep_w", 0.0419),
        disgust_sep_w=sep.get("disgust_sep_w", 0.025),
        num_workers=dl.get("num_workers", 2),
        persistent_workers=dl.get("persistent_workers", True),
        prefetch_factor=dl.get("prefetch_factor", 2),
        ravdess_weight_a=dl.get("ravdess_weight_a", 1.2),
        ravdess_weight_b=dl.get("ravdess_weight_b", 1.4),
        patience_c=trn.get("patience_c", 6),
        min_delta_c=trn.get("min_delta_c", 5e-4),
        swa_tail=trn.get("swa_tail", 5),
        temp_lr=trn.get("temp_lr", 0.01),
        temp_max_iter=trn.get("temp_max_iter", 50),
    )


def setup_logging(log_dir: str) -> logging.Logger:
    """Configure file and console logging.

    Args:
        log_dir: Directory where ``train_modal.log`` will be written.

    Returns:
        logging.Logger: Configured logger for this module.
    """
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


def filter_both_modalities(
    Xf: np.ndarray,
    Xa: np.ndarray,
    fm: np.ndarray,
    am: np.ndarray,
    y: np.ndarray,
    act: np.ndarray,
    mod: np.ndarray,
) -> Tuple:
    """Retain only samples where both face and audio are present.

    Uses the ``MODALITY_BOTH`` flag from ``extract_embeddings_data.py`` to
    ensure train/extract definitions stay consistent.

    Args:
        Xf: Face embeddings of shape ``(N, T, face_dim)``.
        Xa: Audio embeddings of shape ``(N, T, audio_dim)``.
        fm: Face validity masks of shape ``(N, T)``.
        am: Audio validity masks of shape ``(N, T)``.
        y: Class labels of shape ``(N,)``.
        act: Actor IDs of shape ``(N,)``.
        mod: Modality flags of shape ``(N,)``.

    Returns:
        Tuple of filtered arrays ``(Xf, Xa, fm, am, y, act, mod)``.
    """
    mask = mod == MODALITY_BOTH
    return Xf[mask], Xa[mask], fm[mask], am[mask], y[mask], act[mask], mod[mask]


def mixup_batch(xf, xa, fm, am, y, alpha: float = 0.2):
    """Apply Mixup augmentation to a multimodal batch.

    Masks are blended alongside features so the mixed sample's validity mask
    reflects contributions from both source samples.

    Args:
        xf: Face features of shape ``(B, T, face_dim)``.
        xa: Audio features of shape ``(B, T, audio_dim)``.
        fm: Face masks of shape ``(B, T)``.
        am: Audio masks of shape ``(B, T)``.
        y: Labels of shape ``(B,)``.
        alpha: Beta distribution concentration parameter.

    Returns:
        Tuple ``(xf_mixed, xa_mixed, fm_mixed, am_mixed, y_a, y_b, lam)``.
    """
    if alpha <= 0:
        return xf, xa, fm, am, y, y, 1.0
    lam = float(np.random.beta(alpha, alpha))
    lam = max(lam, 1 - lam)
    idx = torch.randperm(xf.size(0), device=xf.device)
    xf_mixed = lam * xf + (1 - lam) * xf[idx]
    xa_mixed = lam * xa + (1 - lam) * xa[idx]
    fm_mixed = lam * fm + (1 - lam) * fm[idx]
    am_mixed = lam * am + (1 - lam) * am[idx]
    return xf_mixed, xa_mixed, fm_mixed, am_mixed, y, y[idx], lam


class EmotionDataset(Dataset):
    """PyTorch Dataset for multimodal emotion recognition.

    Applies optional per-sample augmentation at retrieval time.

    Args:
        Xf: Face embeddings of shape ``(N, T, face_dim)``.
        Xa: Audio embeddings of shape ``(N, T, audio_dim)``.
        fm: Face validity masks of shape ``(N, T)``.
        am: Audio validity masks of shape ``(N, T)``.
        y: Class labels of shape ``(N,)``.
        act: Actor IDs of shape ``(N,)``.
        cfg: Training configuration.
        augment: Whether to apply augmentation during ``__getitem__``.
    """

    def __init__(self, Xf, Xa, fm, am, y, act, cfg: TrainConfig, augment=False):
        self.Xf = torch.tensor(Xf, dtype=torch.float32)
        self.Xa = torch.tensor(Xa, dtype=torch.float32)
        self.fm = torch.tensor(fm, dtype=torch.float32)
        self.am = torch.tensor(am, dtype=torch.float32)
        self.y = torch.tensor(y, dtype=torch.long)
        self.act = act
        self.augment = augment
        self.cfg = cfg

    def __len__(self):
        return len(self.y)

    def __getitem__(self, idx):
        cfg = self.cfg
        xf = self.Xf[idx].clone()
        xa = self.Xa[idx].clone()
        fm = self.fm[idx].clone()
        am = self.am[idx].clone()
        y = self.y[idx]

        if self.augment:
            noise_f = (
                cfg.augment_noise_face_low
                if xf.std(dim=0).mean() < cfg.augment_noise_face_thresh
                else cfg.augment_noise_face_high
            )
            xf = xf + torch.randn_like(xf) * noise_f * fm.unsqueeze(-1)

            noise_a = (
                cfg.augment_noise_audio_low
                if xa.std(dim=0).mean() < cfg.augment_noise_audio_thresh
                else cfg.augment_noise_audio_high
            )
            xa = xa + torch.randn_like(xa) * noise_a * am.unsqueeze(-1)

            if torch.rand(1).item() < cfg.augment_drop_face_prob:
                xf = torch.zeros_like(xf)
                fm = torch.zeros_like(fm)
            if torch.rand(1).item() < cfg.augment_drop_audio_prob:
                xa = torch.zeros_like(xa)
                am = torch.zeros_like(am)

            if torch.rand(1).item() < cfg.augment_roll_prob:
                xa = torch.roll(
                    xa,
                    torch.randint(
                        -cfg.augment_roll_max, cfg.augment_roll_max + 1, (1,)
                    ).item(),
                    dims=0,
                )

            if torch.rand(1).item() < cfg.augment_mask_prob:
                seq_len = xa.size(0)
                max_mask = max(2, int(seq_len * cfg.augment_mask_max_frac))
                mask_len = torch.randint(1, max_mask, (1,)).item()
                start = torch.randint(0, max(1, seq_len - mask_len), (1,)).item()
                xa[start : start + mask_len] = 0.0

        return xf, xa, fm, am, y


class PositionalEncoding(nn.Module):
    """Sinusoidal positional encoding.

    Args:
        d_model: Embedding dimensionality.
        dropout: Dropout probability applied after adding positional signal.
        max_len: Maximum supported sequence length.
    """

    def __init__(self, d_model: int, dropout: float, max_len: int = 64):
        super().__init__()
        self.dropout = nn.Dropout(dropout)
        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(max_len).unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2) * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)
        self.register_buffer("pe", pe.unsqueeze(0))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Add positional encoding and apply dropout.

        Args:
            x: Input tensor of shape ``(B, T, d_model)``.

        Returns:
            torch.Tensor: Positionally encoded tensor of the same shape.
        """
        return self.dropout(x + self.pe[:, : x.size(1)])


class ModalityProjection(nn.Module):
    """Gated two-layer MLP projection for a single modality.

    Projects raw embeddings to ``out_dim`` using a GELU hidden layer
    modulated by a sigmoid gate computed from the input.

    Args:
        in_dim: Input feature dimensionality.
        out_dim: Output feature dimensionality.
        dropout: Dropout probability inside the MLP.
    """

    def __init__(self, in_dim: int, out_dim: int, dropout: float):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, out_dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(out_dim * 2, out_dim),
        )
        self.gate = nn.Sequential(nn.Linear(in_dim, out_dim), nn.Sigmoid())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Project and gate the input.

        Args:
            x: Input of shape ``(B, T, in_dim)``.

        Returns:
            torch.Tensor: Gated projection of shape ``(B, T, out_dim)``.
        """
        return self.net(x) * self.gate(x)


class TemporalConvStem(nn.Module):
    """Depthwise separable temporal conv stem with residual connection.

    Consists of a 3-wide depthwise conv, a pointwise conv, and a dilated
    depthwise conv, each followed by LayerNorm and GELU.

    Args:
        d_model: Channel dimension (input and output).
    """

    def __init__(self, d_model: int):
        super().__init__()
        groups = max(1, d_model // 4)
        self.conv1 = nn.Conv1d(
            d_model, d_model, kernel_size=3, padding=1, groups=groups
        )
        self.norm1 = nn.LayerNorm(d_model)
        self.pw = nn.Conv1d(d_model, d_model, kernel_size=1)
        self.norm_pw = nn.LayerNorm(d_model)
        self.conv2 = nn.Conv1d(
            d_model, d_model, kernel_size=3, padding=2, dilation=2, groups=groups
        )
        self.norm2 = nn.LayerNorm(d_model)
        self.act = nn.GELU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Apply the convolutional stem with residual skip.

        Args:
            x: Input of shape ``(B, T, d_model)``.

        Returns:
            torch.Tensor: Output of shape ``(B, T, d_model)``.
        """
        h = x.transpose(1, 2)
        h = self.act(self.norm1(self.conv1(h).transpose(1, 2)).transpose(1, 2))
        h = self.act(self.norm_pw(self.pw(h).transpose(1, 2)).transpose(1, 2))
        h = self.act(self.norm2(self.conv2(h).transpose(1, 2)).transpose(1, 2))
        return h.transpose(1, 2) + x


class MaskedAttentionPooling(nn.Module):
    """Attention-weighted pooling that respects validity masks.

    Computes a scalar attention score per timestep; invalid positions
    (mask == 0) are masked to ``-inf`` before softmax.

    Args:
        d_model: Input feature dimensionality.
    """

    def __init__(self, d_model: int):
        super().__init__()
        self.score = nn.Linear(d_model, 1)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """Pool a sequence into a single vector.

        Args:
            x: Sequence tensor of shape ``(B, T, d_model)``.
            mask: Binary validity mask of shape ``(B, T)``.

        Returns:
            torch.Tensor: Pooled representation of shape ``(B, d_model)``.
        """
        logits = self.score(x).squeeze(-1).masked_fill(mask == 0, -1e9)
        weights = torch.softmax(logits, dim=1)
        return (x * weights.unsqueeze(-1)).sum(dim=1)


def hard_triplet_loss(
    emb: torch.Tensor, y: torch.Tensor, margin: float = 0.5
) -> torch.Tensor:
    """Batch-hard triplet loss on L2-normalised embeddings.

    Args:
        emb: Embeddings of shape ``(B, D)``.
        y: Integer class labels of shape ``(B,)``.
        margin: Triplet margin.

    Returns:
        torch.Tensor: Scalar loss value.
    """
    emb = F.normalize(emb, dim=1)
    dist = torch.cdist(emb, emb, p=2)
    labels_eq = y.unsqueeze(0) == y.unsqueeze(1)
    eye = torch.eye(emb.size(0), dtype=torch.bool, device=emb.device)
    pos_mask = labels_eq & ~eye
    neg_mask = ~labels_eq
    d_pos = dist.masked_fill(~pos_mask, -1e9).max(dim=1).values
    d_neg = dist.masked_fill(~neg_mask, 1e9).min(dim=1).values
    valid = pos_mask.any(dim=1) & neg_mask.any(dim=1)
    if not valid.any():
        return emb.sum() * 0.0
    return F.relu(d_pos - d_neg + margin)[valid].mean()


def supervised_contrastive_loss(
    emb: torch.Tensor, y: torch.Tensor, temp: float = 0.07
) -> torch.Tensor:
    """Supervised contrastive loss (Khosla et al., 2020).

    Args:
        emb: L2-normalised embeddings of shape ``(B, D)``.
        y: Integer class labels of shape ``(B,)``.
        temp: Logit temperature.

    Returns:
        torch.Tensor: Scalar loss value.
    """
    emb = F.normalize(emb, dim=1)
    N = emb.size(0)
    sim = emb @ emb.T / temp
    eye = torch.eye(N, dtype=torch.bool, device=emb.device)
    sim = sim.masked_fill(eye, -1e9)
    labels_eq = y.unsqueeze(0) == y.unsqueeze(1)
    pos_mask = labels_eq & ~eye
    log_denom = torch.logsumexp(sim, dim=1, keepdim=True)
    n_pos = pos_mask.sum(dim=1).clamp(min=1).float()
    loss_per = -((sim - log_denom) * pos_mask.float()).sum(dim=1) / n_pos
    has_pos = pos_mask.any(dim=1)
    if not has_pos.any():
        return emb.sum() * 0.0
    return loss_per[has_pos].mean()


class EmotionTransformer(nn.Module):
    """Dual-stream Transformer for multimodal emotion recognition.

    Encodes face and audio streams independently with per-modality
    Transformer encoders, then fuses them via gated cross-attention.
    Produces three sets of logits (fusion, face-only, audio-only) and
    intermediate embeddings for auxiliary losses.

    Args:
        cfg: Training configuration providing all architecture hyper-parameters.
    """

    def __init__(self, cfg: TrainConfig):
        super().__init__()
        half = cfg.d_model // 2
        assert half * 2 == cfg.d_model, "d_model must be even"

        self.face_scale = cfg.face_scale
        self.cross_gate_w = cfg.cross_gate_weight
        self.conf_blend_w = cfg.conf_blend_weight
        self.modality_drop_p = cfg.modality_drop_prob

        self.face_proj = ModalityProjection(cfg.face_dim, half, cfg.dropout)
        self.audio_proj = ModalityProjection(cfg.audio_dim, half, cfg.dropout)
        self.face_conv_stem = TemporalConvStem(half)
        self.audio_conv_stem = TemporalConvStem(half)
        self.face_pos = PositionalEncoding(half, cfg.dropout)
        self.audio_pos = PositionalEncoding(half, cfg.dropout)
        self.face_token = nn.Parameter(torch.randn(1, 1, half) * 0.02)
        self.audio_token = nn.Parameter(torch.randn(1, 1, half) * 0.02)

        def _encoder_layer():
            return nn.TransformerEncoderLayer(
                d_model=half,
                nhead=cfg.nhead // 2,
                dim_feedforward=cfg.dim_feedforward // 2,
                dropout=cfg.dropout,
                batch_first=True,
                norm_first=True,
            )

        self.face_encoder = nn.TransformerEncoder(
            _encoder_layer(), cfg.num_encoder_layers, enable_nested_tensor=False
        )
        self.audio_encoder = nn.TransformerEncoder(
            _encoder_layer(), cfg.num_encoder_layers, enable_nested_tensor=False
        )

        self.face_to_cross = nn.Linear(half, half)
        self.audio_to_cross = nn.Linear(half, half)
        self.face_cross_attn = nn.MultiheadAttention(
            half, cfg.nhead // 2, dropout=cfg.dropout, batch_first=True
        )
        self.audio_cross_attn = nn.MultiheadAttention(
            half, cfg.nhead // 2, dropout=cfg.dropout, batch_first=True
        )

        self.cross_ln = nn.LayerNorm(cfg.d_model)
        self.cross_gate = nn.Sequential(nn.Linear(half * 2, 1), nn.Sigmoid())

        self.face_pool = MaskedAttentionPooling(half)
        self.audio_pool = MaskedAttentionPooling(half)
        self.fusion_pool = MaskedAttentionPooling(cfg.d_model)

        self.face_head = nn.Sequential(
            nn.LayerNorm(half), nn.Linear(half, cfg.num_classes)
        )
        self.audio_head = nn.Sequential(
            nn.LayerNorm(half), nn.Linear(half, cfg.num_classes)
        )
        self.fusion_head = nn.Sequential(
            nn.LayerNorm(cfg.d_model),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.d_model, cfg.d_model // 2),
            nn.GELU(),
            nn.Dropout(cfg.dropout / 2),
            nn.Linear(cfg.d_model // 2, cfg.num_classes),
        )

    def forward(
        self, f: torch.Tensor, a: torch.Tensor, fm: torch.Tensor, am: torch.Tensor
    ):
        """Forward pass through both streams and cross-attention fusion.

        Args:
            f: Face embeddings ``(B, T, face_dim)``.
            a: Audio embeddings ``(B, T, audio_dim)``.
            fm: Face validity mask ``(B, T)``.
            am: Audio validity mask ``(B, T)``.

        Returns:
            Tuple of:
                - fusion_logits ``(B, num_classes)``
                - face_logits ``(B, num_classes)``
                - audio_logits ``(B, num_classes)``
                - face_pooled ``(B, d_model//2)``
                - audio_pooled ``(B, d_model//2)``
                - fusion_pooled ``(B, d_model)``
        """
        B = f.size(0)

        f = f * fm.unsqueeze(-1)
        a = a * am.unsqueeze(-1)

        f_proj = self.face_pos(self.face_scale * self.face_conv_stem(self.face_proj(f)))
        a_proj = self.audio_pos(self.audio_conv_stem(self.audio_proj(a)))

        tok_ones = torch.ones(B, 1, device=fm.device)
        fm_ext = torch.cat([tok_ones, fm], dim=1)
        am_ext = torch.cat([tok_ones, am], dim=1)

        f_seq = torch.cat([self.face_token.expand(B, -1, -1), f_proj], dim=1)
        a_seq = torch.cat([self.audio_token.expand(B, -1, -1), a_proj], dim=1)

        f_enc = self.face_encoder(f_seq, src_key_padding_mask=(fm_ext == 0))
        a_enc = self.audio_encoder(a_seq, src_key_padding_mask=(am_ext == 0))

        f_pool_out = self.face_pool(f_enc, fm_ext)
        a_pool_out = self.audio_pool(a_enc, am_ext)

        if self.training:
            f_drop = (
                torch.rand(f_enc.size(0), 1, 1, device=f_enc.device)
                < self.modality_drop_p
            ).float()
            a_drop = (
                torch.rand(a_enc.size(0), 1, 1, device=a_enc.device)
                < self.modality_drop_p
            ).float()
            f_enc = f_enc * (1 - f_drop)
            a_enc = a_enc * (1 - a_drop)

        f_q = self.face_to_cross(f_enc)
        a_q = self.audio_to_cross(a_enc)

        f_cross, _ = self.face_cross_attn(
            query=f_q, key=a_q, value=a_q, key_padding_mask=(am_ext == 0)
        )
        a_cross, _ = self.audio_cross_attn(
            query=a_q, key=f_q, value=f_q, key_padding_mask=(fm_ext == 0)
        )

        gate = self.cross_gate(torch.cat([f_pool_out, a_pool_out], dim=-1)).unsqueeze(1)
        fused = self.cross_ln(
            torch.cat(
                [
                    f_enc + self.cross_gate_w * gate * f_cross,
                    a_enc + self.cross_gate_w * gate * a_cross,
                ],
                dim=-1,
            )
        )

        fusion_mask = ((fm_ext + am_ext) > 0).float()
        fusion_pooled = self.fusion_pool(fused, fusion_mask)

        face_logits = self.face_head(f_pool_out)
        audio_logits = self.audio_head(a_pool_out)

        face_p = torch.softmax(face_logits, dim=-1)
        audio_p = torch.softmax(audio_logits, dim=-1)
        face_ent = -(face_p * torch.log(face_p + 1e-8)).sum(dim=-1, keepdim=True)
        audio_ent = -(audio_p * torch.log(audio_p + 1e-8)).sum(dim=-1, keepdim=True)
        conf_w = torch.softmax(-torch.cat([face_ent, audio_ent], dim=-1), dim=-1)

        fusion_pooled = fusion_pooled + self.conf_blend_w * (
            conf_w[:, 0:1]
            * torch.cat([f_pool_out, torch.zeros_like(f_pool_out)], dim=-1)
            + conf_w[:, 1:2]
            * torch.cat([torch.zeros_like(a_pool_out), a_pool_out], dim=-1)
        )
        has_any = ((fm.sum(dim=1) + am.sum(dim=1)) > 0).float().unsqueeze(1)
        fusion_pooled = fusion_pooled * has_any

        return (
            self.fusion_head(fusion_pooled),
            face_logits,
            audio_logits,
            f_pool_out,
            a_pool_out,
            fusion_pooled,
        )


def compute_class_weights(counts: List[int], device: str) -> torch.Tensor:
    """Compute inverse-sqrt class weights normalised to unit mean.

    Args:
        counts: Per-class sample counts.
        device: Target device string.

    Returns:
        torch.Tensor: Weight tensor of shape ``(num_classes,)``.
    """
    w = 1.0 / np.sqrt(np.array(counts, dtype=np.float32))
    w = w / w.mean()
    return torch.tensor(w, dtype=torch.float32).to(device)


class FocalLoss(nn.Module):
    """Focal loss with optional class weighting and label smoothing.

    Args:
        weight: Per-class weights passed to ``CrossEntropyLoss``.
        gamma: Focusing exponent.
        label_smoothing: Label smoothing factor.
    """

    def __init__(
        self, weight: torch.Tensor, gamma: float = 1.5, label_smoothing: float = 0.0
    ):
        super().__init__()
        self.gamma = gamma
        self.ce = nn.CrossEntropyLoss(
            weight=weight, label_smoothing=label_smoothing, reduction="none"
        )

    def forward(self, logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        """Compute focal loss.

        Args:
            logits: Predicted logits of shape ``(B, C)``.
            target: Ground-truth class indices of shape ``(B,)``.

        Returns:
            torch.Tensor: Scalar focal loss.
        """
        ce_loss = self.ce(logits, target)
        return ((1 - torch.exp(-ce_loss)) ** self.gamma * ce_loss).mean()


def focal_loss_soft(loss_fn, logits, y_a, y_b, lam):
    """Mixup-aware focal loss interpolating between two label targets.

    Args:
        loss_fn: A :class:`FocalLoss` instance.
        logits: Predicted logits of shape ``(B, C)``.
        y_a: Primary labels of shape ``(B,)``.
        y_b: Secondary (shuffled) labels of shape ``(B,)``.
        lam: Mixup interpolation coefficient.

    Returns:
        torch.Tensor: Scalar interpolated loss.
    """
    return lam * loss_fn(logits, y_a) + (1 - lam) * loss_fn(logits, y_b)


class WarmupCosineScheduler:
    """Linear warmup followed by cosine annealing learning rate schedule.

    Args:
        optimizer: The optimizer whose LR is managed.
        warmup_epochs: Number of linear warmup epochs.
        total_epochs: Total training epochs.
        base_lr: Peak learning rate reached at end of warmup.
    """

    def __init__(
        self, optimizer, warmup_epochs: int, total_epochs: int, base_lr: float
    ):
        self.optimizer = optimizer
        self.warmup_epochs = warmup_epochs
        self.total_epochs = total_epochs
        self.base_lr = base_lr

    def step(self, epoch: int) -> float:
        """Update the learning rate for the given epoch.

        Args:
            epoch: Zero-indexed current epoch.

        Returns:
            float: Learning rate applied this epoch.
        """
        if epoch < self.warmup_epochs:
            lr = self.base_lr * (epoch + 1) / self.warmup_epochs
        else:
            progress = (epoch - self.warmup_epochs) / max(
                1, self.total_epochs - self.warmup_epochs
            )
            lr = self.base_lr * 0.5 * (1.0 + math.cos(math.pi * progress))
        for pg in self.optimizer.param_groups:
            pg["lr"] = lr
        return lr


class EarlyStopping:
    """Early stopping with validation-accuracy tracking and checkpoint saving.

    A checkpoint is saved whenever accuracy improves by more than
    ``min_delta``, or accuracy ties but validation loss decreases.

    Args:
        patience: Epochs to wait without improvement before stopping.
        ckpt_path: File path for the best model checkpoint.
        min_delta: Minimum accuracy gain to count as an improvement.
    """

    def __init__(self, patience: int, ckpt_path: str, min_delta: float = 1e-3):
        self.patience = patience
        self.min_delta = min_delta
        self.best_acc = 0.0
        self.best_loss = float("inf")
        self.counter = 0
        self.ckpt_path = ckpt_path

    def step(
        self, acc: float, model: nn.Module, val_loss: float = float("inf")
    ) -> bool:
        """Evaluate the current epoch and optionally save a checkpoint.

        Args:
            acc: Validation accuracy for this epoch.
            model: Model whose state dict is saved on improvement.
            val_loss: Validation loss used as a tiebreaker.

        Returns:
            bool: ``True`` if training should stop.
        """
        better = acc > self.best_acc + self.min_delta
        tiebreak = (
            abs(acc - self.best_acc) <= self.min_delta
            and val_loss < self.best_loss - 1e-4
        )
        if better or tiebreak:
            self.best_acc = max(acc, self.best_acc)
            self.best_loss = val_loss
            self.counter = 0
            Path(self.ckpt_path).parent.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), self.ckpt_path)
            return False
        self.counter += 1
        return self.counter >= self.patience

    def reset(self, initial_acc: float = 0.0):
        """Reset internal state, optionally seeding the best accuracy baseline.

        Args:
            initial_acc: Starting baseline accuracy (e.g. best from a prior phase).
        """
        self.best_acc = initial_acc
        self.best_loss = float("inf")
        self.counter = 0


class SWAHandler:
    """Stochastic Weight Averaging over the last ``swa_tail`` epochs of a phase.

    Usage::

        swa = SWAHandler(model, swa_start_epoch=total_epochs - 5, device=cfg.device)
        swa.update(model, epoch)   # inside training loop
        swa.apply(model)           # after loop — copies averaged weights

    Args:
        model: The base model to average.
        swa_start_epoch: First epoch (zero-indexed) to include in the average.
        device: Device on which the averaged model lives.
    """

    def __init__(self, model: nn.Module, swa_start_epoch: int, device: str = "cpu"):
        self.swa_start_epoch = swa_start_epoch
        self.swa_model = torch.optim.swa_utils.AveragedModel(model).to(device)
        self.n_averaged = 0

    def update(self, model: nn.Module, epoch: int):
        """Accumulate model weights if epoch is within the SWA tail.

        Args:
            model: Current model state to absorb.
            epoch: Zero-indexed epoch number.
        """
        if epoch >= self.swa_start_epoch:
            self.swa_model.update_parameters(model)
            self.n_averaged += 1

    def apply(self, model: nn.Module):
        """Copy averaged weights into *model* in-place. No-op if never updated.

        Args:
            model: Target model to receive averaged parameters.
        """
        if self.n_averaged == 0:
            return
        swa_sd = self.swa_model.state_dict()
        model_keys = set(model.state_dict().keys())
        cleaned = {}
        for k, v in swa_sd.items():
            while k.startswith("module."):
                k = k[len("module.") :]
            if k in model_keys:
                cleaned[k] = v
        model.load_state_dict(cleaned)


class TemperatureScaler(nn.Module):
    """Single-parameter post-hoc calibration via temperature scaling.

    Learns a scalar temperature ``T`` on the validation set such that
    ``calibrated_logits = logits / T`` minimises NLL. Does not alter accuracy.
    """

    def __init__(self):
        super().__init__()
        self.temperature = nn.Parameter(torch.ones(1))

    def forward(self, logits: torch.Tensor) -> torch.Tensor:
        """Scale logits by the learned temperature.

        Args:
            logits: Raw logits of shape ``(B, C)``.

        Returns:
            torch.Tensor: Calibrated logits of shape ``(B, C)``.
        """
        return logits / self.temperature.clamp(min=1e-2)


def fit_temperature(
    model: nn.Module,
    val_loader: DataLoader,
    cfg: TrainConfig,
    logger: logging.Logger,
    ckpt_dir: Path,
) -> TemperatureScaler:
    """Fit a :class:`TemperatureScaler` on the validation set and save it.

    Args:
        model: Frozen model used to collect validation logits.
        val_loader: Validation DataLoader.
        cfg: Training configuration.
        logger: Logger for diagnostic output.
        ckpt_dir: Directory where ``temperature.pt`` will be written.

    Returns:
        TemperatureScaler: Fitted scaler in eval mode.
    """
    scaler = TemperatureScaler().to(cfg.device)
    optimizer = torch.optim.LBFGS(
        [scaler.temperature],
        lr=cfg.temp_lr,
        max_iter=cfg.temp_max_iter,
        line_search_fn="strong_wolfe",
    )
    nll_fn = nn.CrossEntropyLoss()

    all_logits, all_labels = [], []
    model.eval()
    with torch.no_grad():
        for xf, xa, fm, am, y in val_loader:
            logits, *_ = model(
                xf.to(cfg.device),
                xa.to(cfg.device),
                fm.to(cfg.device),
                am.to(cfg.device),
            )
            all_logits.append(logits)
            all_labels.append(y.to(cfg.device))

    logits_val = torch.cat(all_logits)
    labels_val = torch.cat(all_labels)

    def _closure():
        optimizer.zero_grad()
        loss = nll_fn(scaler(logits_val), labels_val)
        loss.backward()
        return loss

    optimizer.step(_closure)

    T = scaler.temperature.item()
    logger.info(f"Temperature scaling: T={T:.4f}")
    torch.save({"temperature": T}, ckpt_dir / "temperature.pt")
    scaler.eval()
    return scaler


def make_loader(
    Xf,
    Xa,
    fm,
    am,
    y,
    act,
    cfg: TrainConfig,
    augment=False,
    use_sampler=False,
    ravdess_weight: float = 1.0,
) -> DataLoader:
    """Build a :class:`DataLoader` for an :class:`EmotionDataset`.

    Args:
        Xf: Face embeddings array.
        Xa: Audio embeddings array.
        fm: Face masks array.
        am: Audio masks array.
        y: Labels array.
        act: Actor IDs array.
        cfg: Training configuration.
        augment: Enable per-sample augmentation.
        use_sampler: Use a weighted sampler to up-weight RAVDESS samples.
        ravdess_weight: Sampling weight multiplier for RAVDESS samples.

    Returns:
        DataLoader: Configured DataLoader instance.
    """
    dataset = EmotionDataset(Xf, Xa, fm, am, y, act, cfg, augment=augment)
    sampler = None
    if use_sampler:
        w = np.where(act < cfg.actor_id_threshold, ravdess_weight, 1.0).astype(
            np.float32
        )
        sampler = torch.utils.data.WeightedRandomSampler(
            torch.tensor(w), num_samples=len(w), replacement=True
        )
    persistent = cfg.persistent_workers and cfg.num_workers > 0
    return DataLoader(
        dataset,
        batch_size=cfg.batch_size,
        sampler=sampler,
        shuffle=False,
        num_workers=cfg.num_workers,
        pin_memory=False,
        persistent_workers=persistent,
        prefetch_factor=cfg.prefetch_factor if cfg.num_workers > 0 else None,
        multiprocessing_context="fork" if cfg.num_workers > 0 else None,
    )


def evaluate(
    model: nn.Module,
    loader: DataLoader,
    loss_fn: nn.Module,
    cfg: TrainConfig,
) -> Tuple[float, float]:
    """Compute average loss and accuracy over a DataLoader.

    Restores the model's training mode on exit, even if an exception occurs.

    Args:
        model: Model to evaluate.
        loader: DataLoader providing batches.
        loss_fn: Loss function.
        cfg: Training configuration.

    Returns:
        Tuple[float, float]: ``(avg_loss, accuracy)``.
    """
    was_training = model.training
    model.eval()
    total_loss = correct = total = 0
    try:
        with torch.no_grad():
            for xf, xa, fm, am, y in loader:
                xf, xa, fm, am, y = (
                    xf.to(cfg.device),
                    xa.to(cfg.device),
                    fm.to(cfg.device),
                    am.to(cfg.device),
                    y.to(cfg.device),
                )
                logits_fusion, *_ = model(xf, xa, fm, am)
                loss = loss_fn(logits_fusion, y)
                total_loss += loss.item()
                correct += (logits_fusion.argmax(1) == y).sum().item()
                total += len(y)
    finally:
        if was_training:
            model.train()
    return total_loss / len(loader), correct / total


def eval_by_dataset(
    model: nn.Module,
    loader: DataLoader,
    cfg: TrainConfig,
    act: np.ndarray,
) -> Tuple[float, float]:
    """Compute per-dataset accuracy split between RAVDESS and CREMA-D.

    Restores the model's training mode on exit.

    Args:
        model: Model to evaluate.
        loader: DataLoader providing batches.
        cfg: Training configuration.
        act: Actor IDs aligned with the loader's dataset.

    Returns:
        Tuple[float, float]: ``(ravdess_acc, cremad_acc)``.
            Either value is ``nan`` if the corresponding subset is empty.
    """
    was_training = model.training
    model.eval()
    preds, labels = [], []
    try:
        with torch.no_grad():
            for xf, xa, fm, am, y in loader:
                logits, *_ = model(
                    xf.to(cfg.device),
                    xa.to(cfg.device),
                    fm.to(cfg.device),
                    am.to(cfg.device),
                )
                preds.extend(logits.argmax(1).cpu().numpy())
                labels.extend(y.numpy())
    finally:
        if was_training:
            model.train()

    preds = np.array(preds)
    labels = np.array(labels)
    r_idx = act < cfg.actor_id_threshold
    c_idx = ~r_idx
    acc_r = (preds[r_idx] == labels[r_idx]).mean() if r_idx.any() else float("nan")
    acc_c = (preds[c_idx] == labels[c_idx]).mean() if c_idx.any() else float("nan")
    return acc_r, acc_c


def run_epoch(
    model: nn.Module,
    loader: DataLoader,
    loss_fn: nn.Module,
    optimizer,
    cfg: TrainConfig,
    train: bool,
    epoch: int = 0,
    epoch_offset: int = 0,
    use_mixup: bool = False,
):
    """Run one full epoch of training or evaluation.

    Computes focal loss combined with triplet, supervised contrastive, and
    class-separation auxiliary losses. Auxiliary losses are skipped when
    Mixup is active (non-integer targets).

    Args:
        model: Model to train or evaluate.
        loader: DataLoader for this epoch.
        loss_fn: Primary :class:`FocalLoss` instance.
        optimizer: Optimizer (used only when ``train=True``).
        cfg: Training configuration.
        train: If ``True``, runs forward/backward with gradient updates.
        epoch: Zero-indexed epoch within the current phase.
        epoch_offset: Global epoch offset accumulated across phases.
        use_mixup: Whether to apply Mixup augmentation.

    Returns:
        Tuple[float, float]: ``(avg_loss, accuracy)`` over the epoch.
    """
    model.train() if train else model.eval()
    total_loss = correct = total = 0
    global_epoch = epoch + epoch_offset

    supcon_temp = max(
        cfg.supcon_temp_floor,
        cfg.supcon_temp_start - global_epoch * cfg.supcon_temp_decay,
    )

    with torch.enable_grad() if train else torch.no_grad():
        for xf, xa, fm, am, y in loader:
            xf, xa, fm, am, y = (
                xf.to(cfg.device),
                xa.to(cfg.device),
                fm.to(cfg.device),
                am.to(cfg.device),
                y.to(cfg.device),
            )

            y_clean = y
            y_b = y
            lam = 1.0
            if train and use_mixup and torch.rand(1).item() < cfg.mixup_prob:
                xf, xa, fm, am, y, y_b, lam = mixup_batch(
                    xf, xa, fm, am, y, alpha=cfg.mixup_alpha
                )

            logits_fusion, logits_face, logits_audio, f_emb, a_emb, fusion_emb = model(
                xf, xa, fm, am
            )

            if lam < 1.0:
                loss_main = (
                    0.70 * focal_loss_soft(loss_fn, logits_fusion, y, y_b, lam)
                    + 0.15 * focal_loss_soft(loss_fn, logits_face, y, y_b, lam)
                    + 0.15 * focal_loss_soft(loss_fn, logits_audio, y, y_b, lam)
                )
            else:
                loss_main = (
                    0.70 * loss_fn(logits_fusion, y)
                    + 0.15 * loss_fn(logits_face, y)
                    + 0.15 * loss_fn(logits_audio, y)
                )

            if lam >= 1.0:
                triplet = hard_triplet_loss(
                    fusion_emb, y_clean, margin=cfg.triplet_margin
                )

                if global_epoch >= cfg.warmup_epochs:
                    lambda_sc = min(
                        cfg.lambda_sc_max,
                        (global_epoch - cfg.warmup_epochs)
                        / cfg.lambda_sc_ramp_epochs
                        * cfg.lambda_sc_max,
                    )
                    sc_loss = supervised_contrastive_loss(
                        fusion_emb, y_clean, temp=supcon_temp
                    )
                else:
                    lambda_sc = 0.0
                    sc_loss = torch.tensor(0.0, device=cfg.device)

                probs = torch.softmax(logits_fusion, dim=-1)
                sad_mask = (y_clean == 4).float()
                fearful_mask = (y_clean == 1).float()
                disgust_mask = (y_clean == 2).float()

                sep_sad = (
                    torch.relu(cfg.sad_margin - (probs[:, 4] - probs[:, 5])) * sad_mask
                )
                sep_fear = (
                    torch.relu(cfg.fear_margin - (probs[:, 1] - probs[:, 4]))
                    * fearful_mask
                )
                sep_disgust = (
                    torch.relu(cfg.disgust_margin - (probs[:, 2] - probs[:, 4]))
                    * disgust_mask
                )
                aux_loss = (
                    lambda_sc * sc_loss
                    + cfg.triplet_weight * triplet
                    + cfg.sad_sep_w * sep_sad.mean()
                    + cfg.fear_sep_w * sep_fear.mean()
                    + cfg.disgust_sep_w * sep_disgust.mean()
                )
            else:
                aux_loss = torch.tensor(0.0, device=cfg.device)

            loss = loss_main + aux_loss

            if train:
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), cfg.grad_clip)
                optimizer.step()

            total_loss += loss.item()
            correct += (logits_fusion.argmax(1) == y_clean).sum().item()
            total += len(y_clean)

    return total_loss / len(loader), correct / total


def train_phase(
    phase: str,
    model: nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    loss_fn: nn.Module,
    cfg: TrainConfig,
    epochs: int,
    base_lr: float,
    early: EarlyStopping,
    logger: logging.Logger,
    val_act: Optional[np.ndarray] = None,
    epoch_offset: int = 0,
    use_mixup: bool = False,
    mixup_warmup_epochs: int = 0,
    initial_acc: float = 0.0,
    warmup_epochs_override: Optional[int] = None,
    eval_loader: Optional[DataLoader] = None,
    eval_act: Optional[np.ndarray] = None,
    swa_handler: Optional["SWAHandler"] = None,
) -> Tuple[int, float]:
    """Train for one phase with warmup-cosine LR and early stopping.

    Args:
        phase: Phase label (e.g. ``"A"``) used for logging.
        model: Model to train.
        train_loader: Training DataLoader.
        val_loader: Validation DataLoader used for early stopping.
        loss_fn: Primary loss function.
        cfg: Training configuration.
        epochs: Maximum epochs for this phase.
        base_lr: Peak learning rate.
        early: :class:`EarlyStopping` instance (reset internally).
        logger: Logger for per-epoch metrics.
        val_act: Actor IDs for per-dataset breakdown (optional).
        epoch_offset: Global epoch offset for auxiliary loss ramps.
        use_mixup: Enable Mixup after ``mixup_warmup_epochs``.
        mixup_warmup_epochs: Epochs to delay Mixup activation.
        initial_acc: Accuracy baseline seeded into ``early``.
        warmup_epochs_override: Overrides ``cfg.warmup_epochs`` if provided.
        eval_loader: Separate loader for per-dataset breakdown (optional).
        eval_act: Actor IDs aligned with ``eval_loader`` (optional).
        swa_handler: :class:`SWAHandler` to update each epoch (optional).

    Returns:
        Tuple[int, float]: ``(epochs_run, best_val_accuracy)``.
    """
    logger.info(f"{'='*20} Phase {phase} | lr={base_lr} | epochs={epochs} {'='*20}")
    warmup = (
        warmup_epochs_override
        if warmup_epochs_override is not None
        else cfg.warmup_epochs
    )
    optimizer = AdamW(model.parameters(), lr=base_lr, weight_decay=cfg.weight_decay)
    scheduler = WarmupCosineScheduler(optimizer, warmup, epochs, base_lr)
    early.reset(initial_acc=initial_acc)

    epochs_run = 0
    for epoch in range(epochs):
        lr = scheduler.step(epoch)
        effective_mixup = use_mixup and (epoch >= mixup_warmup_epochs)
        train_loss, train_acc = run_epoch(
            model,
            train_loader,
            loss_fn,
            optimizer,
            cfg,
            train=True,
            epoch=epoch,
            epoch_offset=epoch_offset,
            use_mixup=effective_mixup,
        )
        val_loss, val_acc = run_epoch(
            model,
            val_loader,
            loss_fn,
            optimizer,
            cfg,
            train=False,
            epoch=epoch,
            epoch_offset=epoch_offset,
        )

        log_line = (
            f"[{phase}] Epoch {epoch+1:03d} | lr={lr:.2e} | "
            f"train_loss={train_loss:.4f} train_acc={train_acc:.4f} | "
            f"val_loss={val_loss:.4f} val_acc={val_acc:.4f}"
        )

        _breakdown_loader = eval_loader if eval_loader is not None else val_loader
        _breakdown_act = eval_act if eval_act is not None else val_act
        if _breakdown_act is not None and (epoch + 1) % 5 == 0:
            acc_r, acc_c = eval_by_dataset(
                model, _breakdown_loader, cfg, _breakdown_act
            )
            r_str = (
                f"{acc_r:.4f}" if (acc_r is not None and not np.isnan(acc_r)) else "n/a"
            )
            c_str = (
                f"{acc_c:.4f}" if (acc_c is not None and not np.isnan(acc_c)) else "n/a"
            )
            log_line += f" | val_R={r_str} val_C={c_str}"

        logger.info(log_line)
        epochs_run += 1

        if swa_handler is not None:
            swa_handler.update(model, epoch)

        if early.step(val_acc, model, val_loss):
            logger.info(
                f"[{phase}] Early stopping at epoch {epoch+1} | best_acc={early.best_acc:.4f}"
            )
            break

    return epochs_run, early.best_acc


def main():
    """Entry point: load data, run three-phase training, calibrate, and evaluate."""
    cfg_raw = load_config()
    cfg = build_train_config(cfg_raw)
    logger = setup_logging(str(BASE_DIR / cfg.log_dir))

    logger.info(
        f"device={cfg.device} | face_dim={cfg.face_dim} | "
        f"audio_dim={cfg.audio_dim} | d_model={cfg.d_model}"
    )

    data_path = BASE_DIR / cfg.data_path
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset not found: {data_path}")

    data = np.load(data_path)

    assert (
        data["X_audio_train"].shape[-1] == cfg.audio_dim
    ), f"audio_dim mismatch: got {data['X_audio_train'].shape[-1]}, expected {cfg.audio_dim}"
    assert (
        data["X_face_train"].shape[-1] == cfg.face_dim
    ), f"face_dim mismatch: got {data['X_face_train'].shape[-1]}, expected {cfg.face_dim}"
    assert (
        data["X_audio_train"].shape[1] == cfg.seq_len
    ), f"audio seq_len mismatch: got {data['X_audio_train'].shape[1]}, expected {cfg.seq_len}"
    assert (
        data["X_face_train"].shape[1] == cfg.seq_len
    ), f"face seq_len mismatch: got {data['X_face_train'].shape[1]}, expected {cfg.seq_len}"

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

    Xf_te = data["X_face_test"]
    Xa_te = data["X_audio_test"]
    fm_te = data["face_mask_test"]
    am_te = data["audio_mask_test"]
    y_te = data["y_test"]
    act_te = data["actor_test"]
    mod_te = data["modality_test"]

    logger.info(f"Loaded — train: {len(y_tr)}  val: {len(y_va)}  test: {len(y_te)}")
    logger.info(
        f"Data mix — RAVDESS: {(act_tr < cfg.actor_id_threshold).mean():.1%}  "
        f"CREMA-D: {(act_tr >= cfg.actor_id_threshold).mean():.1%}"
    )

    (
        Xf_tr_both,
        Xa_tr_both,
        fm_tr_both,
        am_tr_both,
        y_tr_both,
        act_tr_both,
        _,
    ) = filter_both_modalities(Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, act_tr, mod_tr)
    (
        Xf_va_both,
        Xa_va_both,
        fm_va_both,
        am_va_both,
        y_va_both,
        act_va_both,
        _,
    ) = filter_both_modalities(Xf_va, Xa_va, fm_va, am_va, y_va, act_va, mod_va)

    logger.info(
        f"Phase A (both modalities) — train: {len(y_tr_both)}  val: {len(y_va_both)}"
    )
    logger.info(f"Phase B/C (all modalities) — train: {len(y_tr)}  val: {len(y_va)}")

    loader_a_tr = make_loader(
        Xf_tr_both,
        Xa_tr_both,
        fm_tr_both,
        am_tr_both,
        y_tr_both,
        act_tr_both,
        cfg,
        augment=True,
        use_sampler=True,
        ravdess_weight=cfg.ravdess_weight_a,
    )
    loader_a_va = make_loader(
        Xf_va_both,
        Xa_va_both,
        fm_va_both,
        am_va_both,
        y_va_both,
        act_va_both,
        cfg,
        augment=False,
        use_sampler=False,
    )
    loader_b_tr = make_loader(
        Xf_tr,
        Xa_tr,
        fm_tr,
        am_tr,
        y_tr,
        act_tr,
        cfg,
        augment=True,
        use_sampler=True,
        ravdess_weight=cfg.ravdess_weight_b,
    )
    loader_b_va = make_loader(
        Xf_va, Xa_va, fm_va, am_va, y_va, act_va, cfg, augment=False, use_sampler=False
    )
    loader_te = make_loader(Xf_te, Xa_te, fm_te, am_te, y_te, act_te, cfg)

    model = EmotionTransformer(cfg).to(cfg.device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info(f"Trainable parameters: {n_params:,}")
    logger.info("Running in eager mode (MPS native)")

    base_weights = compute_class_weights(cfg.class_counts, cfg.device)
    class_boost = torch.tensor(cfg.class_boost, dtype=torch.float32, device=cfg.device)
    loss_fn = FocalLoss(
        weight=base_weights * class_boost,
        gamma=1.0,
        label_smoothing=cfg.label_smoothing,
    )

    ckpt_a = str(BASE_DIR / cfg.ckpt_dir / "best_modal_a.pt")
    ckpt_b = str(BASE_DIR / cfg.ckpt_dir / "best_modal_b.pt")
    ckpt_c = str(BASE_DIR / cfg.ckpt_dir / "best_modal.pt")

    epochs_a_run, _ = train_phase(
        "A",
        model,
        loader_a_tr,
        loader_a_va,
        loss_fn,
        cfg,
        cfg.epochs_a,
        cfg.lr_a,
        EarlyStopping(cfg.early_stop_patience, ckpt_a),
        logger,
        val_act=act_va_both,
        epoch_offset=0,
        use_mixup=False,
        initial_acc=0.0,
        eval_loader=loader_b_va,
        eval_act=act_va,
    )
    model.load_state_dict(torch.load(ckpt_a, map_location=cfg.device))
    logger.info("Phase A best restored")

    best_a_loss_on_full_val, best_a_acc_on_full_val = evaluate(
        model, loader_b_va, loss_fn, cfg
    )
    logger.info(
        f"Phase A best checkpoint — full val acc: {best_a_acc_on_full_val:.4f} "
        f"(Phase B must beat this to save a checkpoint)"
    )

    epochs_b_run, best_b_acc = train_phase(
        "B",
        model,
        loader_b_tr,
        loader_b_va,
        loss_fn,
        cfg,
        cfg.epochs_b,
        cfg.lr_b,
        EarlyStopping(cfg.early_stop_patience, ckpt_b),
        logger,
        val_act=act_va,
        epoch_offset=epochs_a_run,
        use_mixup=True,
        mixup_warmup_epochs=cfg.warmup_epochs_b,
        initial_acc=best_a_acc_on_full_val,
        warmup_epochs_override=cfg.warmup_epochs_b,
    )

    if Path(ckpt_b).exists():
        model.load_state_dict(torch.load(ckpt_b, map_location=cfg.device))
        logger.info("Phase B best restored")
        best_bc_acc = best_b_acc
        best_bc_ckpt = ckpt_b
    else:
        model.load_state_dict(torch.load(ckpt_a, map_location=cfg.device))
        logger.info(
            f"Phase B did not improve over Phase A (B best={best_b_acc:.4f}) — "
            f"restoring Phase A checkpoint for Phase C"
        )
        best_bc_acc = best_a_acc_on_full_val
        best_bc_ckpt = ckpt_a

    for param in model.parameters():
        param.requires_grad = True

    phase_c_es = EarlyStopping(cfg.patience_c, ckpt_c, min_delta=cfg.min_delta_c)

    swa_tail = cfg.swa_tail
    swa_start = max(0, cfg.epochs_c - swa_tail)
    swa = SWAHandler(model, swa_start_epoch=swa_start, device=cfg.device)

    epochs_c_run, _ = train_phase(
        "C",
        model,
        loader_b_tr,
        loader_b_va,
        loss_fn,
        cfg,
        cfg.epochs_c,
        cfg.lr_c,
        phase_c_es,
        logger,
        val_act=act_va,
        epoch_offset=epochs_a_run + epochs_b_run,
        use_mixup=False,
        initial_acc=best_bc_acc,
        swa_handler=swa,
    )

    if Path(ckpt_c).exists() and phase_c_es.best_acc > best_bc_acc:
        model.load_state_dict(torch.load(ckpt_c, map_location=cfg.device))
        logger.info(f"Phase C best restored (acc={phase_c_es.best_acc:.4f})")
    else:
        model.load_state_dict(torch.load(best_bc_ckpt, map_location=cfg.device))
        logger.info(
            f"Phase C did not improve — using best prior checkpoint "
            f"(prior={best_bc_acc:.4f}, C={phase_c_es.best_acc:.4f})"
        )

    if swa.n_averaged > 0:
        logger.info(
            f"SWA averaged over {swa.n_averaged} checkpoint(s) "
            f"(start_epoch={swa_start}) — evaluating on val set"
        )
        current_state = copy.deepcopy(model.state_dict())
        swa.apply(model)
        _, swa_val_acc = evaluate(model, loader_b_va, loss_fn, cfg)
        current_best = max(phase_c_es.best_acc, best_b_acc)
        logger.info(
            f"SWA val acc: {swa_val_acc:.4f}  (current best: {current_best:.4f})"
        )
        if swa_val_acc > current_best:
            logger.info("SWA is better — keeping SWA weights")
            ckpt_swa = str(BASE_DIR / cfg.ckpt_dir / "best_modal_swa.pt")
            Path(ckpt_swa).parent.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), ckpt_swa)
        else:
            logger.info("SWA did not improve — reverting to previous best")
            model.load_state_dict(current_state)
    else:
        logger.info("SWA: no epochs collected (Phase C stopped too early)")

    final_ckpt = str(BASE_DIR / cfg.ckpt_dir / "best_modal.pt")
    Path(final_ckpt).parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), final_ckpt)
    logger.info(f"Final best weights saved → {final_ckpt}")

    ckpt_dir_path = BASE_DIR / cfg.ckpt_dir
    temp_scaler = fit_temperature(model, loader_b_va, cfg, logger, ckpt_dir_path)

    model.eval()
    all_preds, all_labels = [], []
    with torch.no_grad():
        for batch in loader_te:
            xf, xa, fm, am, y = batch
            logits, *_ = model(
                xf.to(cfg.device),
                xa.to(cfg.device),
                fm.to(cfg.device),
                am.to(cfg.device),
            )
            calibrated = temp_scaler(logits)
            all_preds.extend(calibrated.argmax(1).cpu().numpy())
            all_labels.extend(y.numpy())

    all_preds = np.array(all_preds)
    all_labels = np.array(all_labels)
    class_names = cfg_raw["misc"]["class_names"]

    logger.info(f"\n{'='*20} TEST RESULTS {'='*20}")
    logger.info(f"OVERALL TEST ACC: {(all_preds == all_labels).mean():.4f}")
    logger.info(
        "\n" + classification_report(all_labels, all_preds, target_names=class_names)
    )
    logger.info(f"\nConfusion Matrix:\n{confusion_matrix(all_labels, all_preds)}")

    for name, idx in [
        ("RAVDESS", act_te < cfg.actor_id_threshold),
        ("CREMA-D", act_te >= cfg.actor_id_threshold),
    ]:
        if idx.sum() == 0:
            continue
        acc = (all_preds[idx] == all_labels[idx]).mean()
        logger.info(f"\n{name} test acc ({idx.sum()} samples): {acc:.4f}")
        logger.info(
            "\n"
            + classification_report(
                all_labels[idx],
                all_preds[idx],
                target_names=class_names,
                zero_division=0,
            )
        )

    logger.info("DONE")


if __name__ == "__main__":
    main()
