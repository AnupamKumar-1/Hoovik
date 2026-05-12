"""Dataset inspection utilities for multimodal embedding splits."""

import numpy as np
import json
import logging
from collections import Counter
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent.parent

DATA_PATH = BASE_DIR / "extracted_dataset" / "dataset.npz"
SPLITS_PATH = BASE_DIR / "extracted_dataset" / "splits.json"
LOGS_DIR = BASE_DIR / "logs"

LOGS_DIR.mkdir(parents=True, exist_ok=True)
log_file = LOGS_DIR / f"inspect_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2

MODALITY_NAMES = {
    MODALITY_AUDIO_ONLY: "audio_only",
    MODALITY_VIDEO_ONLY: "video_only",
    MODALITY_BOTH: "both",
}


def _modality_mask(mod, m):
    return mod == m


def _header(title):
    bar = "=" * 60
    logger.info(bar)
    logger.info(f"  {title}")
    logger.info(bar)


def _subheader(title):
    logger.info(f"  -- {title} --")


def stats(name, Xf, Xa, fm, am, y, act, mod):
    """Log a per-split overview including modality breakdown, shapes, NaN checks, and distributions.

    Args:
        name: Split name (e.g. ``"train"``).
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
        fm: Face validity masks of shape (N, T).
        am: Audio validity masks of shape (N, T).
        y: Integer label array of shape (N,).
        act: Actor ID array of shape (N,).
        mod: Modality integer array of shape (N,).
    """
    _header(f"SPLIT: {name.upper()}")
    n = len(y)
    logger.info(f"  total samples : {n}")

    counts = {MODALITY_NAMES[m]: int((mod == m).sum()) for m in [0, 1, 2]}
    logger.info(f"  modality breakdown:")
    for mname, cnt in counts.items():
        pct = 100 * cnt / n if n else 0
        logger.info(f"    {mname:<12}: {cnt:>5}  ({pct:.1f}%)")

    logger.info(f"  face  shape   : {Xf.shape}")
    logger.info(f"  audio shape   : {Xa.shape}")

    logger.info(f"  NaN/Inf check :")
    logger.info(
        f"    face  NaN={int(np.isnan(Xf).sum())}  Inf={int(np.isinf(Xf).sum())}"
    )
    logger.info(
        f"    audio NaN={int(np.isnan(Xa).sum())}  Inf={int(np.isinf(Xa).sum())}"
    )

    logger.info(f"  mask coverage (global):")
    logger.info(f"    face  : {float(fm.mean()):.4f}")
    logger.info(f"    audio : {float(am.mean()):.4f}")

    logger.info(f"  mask coverage (by modality — expected values shown):")
    for m, mname, exp_face, exp_audio in [
        (MODALITY_AUDIO_ONLY, "audio_only", "~0.00 [expected]", "~0.60-0.70"),
        (MODALITY_VIDEO_ONLY, "video_only", "~0.80-0.90", "~0.00 [expected]"),
        (MODALITY_BOTH, "both", "~0.80-0.90", "~0.60-0.70"),
    ]:
        idx = mod == m
        if idx.sum() == 0:
            continue
        fc = float(fm[idx].mean())
        ac = float(am[idx].mean())
        logger.info(
            f"    {mname:<12}: face={fc:.4f} (exp {exp_face})  "
            f"audio={ac:.4f} (exp {exp_audio})"
        )

    logger.info(f"  label distribution : {dict(Counter(y.tolist()))}")
    logger.info(f"  actor distribution : {dict(Counter(act.tolist()))}")


def embedding_norms(Xf_tr, Xa_tr, mod_tr):
    """Log L2 norm statistics for face and audio embeddings on the training set.

    Only samples whose modality includes a given stream are included
    (e.g. face norms are computed only for ``video_only`` and ``both``).

    Args:
        Xf_tr: Face embeddings of shape (N, T, D_face).
        Xa_tr: Audio embeddings of shape (N, T, D_audio).
        mod_tr: Modality integer array of shape (N,).
    """
    _header("EMBEDDING NORMS  (train, modality-aware)")

    face_idx = np.isin(mod_tr, [MODALITY_VIDEO_ONLY, MODALITY_BOTH])
    audio_idx = np.isin(mod_tr, [MODALITY_AUDIO_ONLY, MODALITY_BOTH])

    if face_idx.sum():
        fn = np.linalg.norm(Xf_tr[face_idx], axis=2)
        logger.info(
            f"  face  (video_only+both, n={face_idx.sum()}): "
            f"mean={fn.mean():.4f}  std={fn.std():.4f}  "
            f"min={fn.min():.4f}  max={fn.max():.4f}"
        )
    else:
        logger.info("  face : no video samples found")

    if audio_idx.sum():
        an = np.linalg.norm(Xa_tr[audio_idx], axis=2)
        logger.info(
            f"  audio (audio_only+both, n={audio_idx.sum()}): "
            f"mean={an.mean():.4f}  std={an.std():.4f}  "
            f"min={an.min():.4f}  max={an.max():.4f}"
        )
    else:
        logger.info("  audio: no audio samples found")


def audio_norm_check(Xa_tr, mod_tr):
    """Check whether audio embeddings are approximately unit-L2-normalised.

    Args:
        Xa_tr: Audio embeddings of shape (N, T, D_audio).
        mod_tr: Modality integer array of shape (N,).
    """
    _header("AUDIO NORMALIZATION CHECK")
    audio_idx = np.isin(mod_tr, [MODALITY_AUDIO_ONLY, MODALITY_BOTH])
    Xa_audio = Xa_tr[audio_idx]
    norms = np.linalg.norm(Xa_audio, axis=2)
    non_silent = norms[norms > 1e-5]
    if len(non_silent) == 0:
        logger.warning(
            "  no non-silent audio frames found — cannot check normalization"
        )
        return
    mean_norm = float(non_silent.mean())
    logger.info(f"  L2 mean norm (non-silent frames): {mean_norm:.4f}")
    if 0.9 < mean_norm < 1.1:
        logger.info("  [OK] audio embeddings are properly normalized (mean norm ≈ 1)")
    else:
        logger.warning(
            f"  [WARN] audio NOT unit-normalized (mean={mean_norm:.4f}). "
            "This is fine if your model normalizes internally or uses z-score stats from norm_stats.npz. "
            "Flag this if training diverges early."
        )


def face_norm_check(Xf_tr, mod_tr):
    """Check the value range of face embeddings for potential outliers.

    Args:
        Xf_tr: Face embeddings of shape (N, T, D_face).
        mod_tr: Modality integer array of shape (N,).
    """
    _header("FACE NORMALIZATION CHECK")
    face_idx = np.isin(mod_tr, [MODALITY_VIDEO_ONLY, MODALITY_BOTH])
    Xf_face = Xf_tr[face_idx]
    p99 = float(np.percentile(np.abs(Xf_face), 99))
    fmin = float(Xf_face.min())
    fmax = float(Xf_face.max())
    logger.info(f"  value range    : min={fmin:.4f}  max={fmax:.4f}")
    logger.info(f"  |value| p99    : {p99:.4f}")
    if p99 > 10.0:
        logger.warning(
            f"  [WARN] face p99={p99:.4f} > 10 — potential outliers. "
            "Check norm_stats.npz was applied correctly."
        )
    else:
        logger.info("  [OK] face value range looks reasonable")


def empty_samples(Xf, Xa, mod):
    """Check for all-zero face or audio sequences, stratified by modality.

    Args:
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
        mod: Modality integer array of shape (N,).
    """
    _header("EMPTY SAMPLE CHECK  (modality-aware)")

    for m, mname, check_face, check_audio in [
        (MODALITY_AUDIO_ONLY, "audio_only", False, True),
        (MODALITY_VIDEO_ONLY, "video_only", True, False),
        (MODALITY_BOTH, "both", True, True),
    ]:
        idx = mod == m
        n = idx.sum()
        if n == 0:
            continue

        face_empty = int((np.abs(Xf[idx]).sum(axis=(1, 2)) == 0).sum())
        audio_empty = int((np.abs(Xa[idx]).sum(axis=(1, 2)) == 0).sum())

        msgs = []
        if check_face:
            status = "[OK]" if face_empty == 0 else "[WARN]"
            msgs.append(f"face_empty={face_empty}/{n} {status}")
        else:
            msgs.append(f"face_empty={face_empty}/{n} [expected — no face data]")

        if check_audio:
            status = "[OK]" if audio_empty == 0 else "[WARN]"
            msgs.append(f"audio_empty={audio_empty}/{n} {status}")
        else:
            msgs.append(f"audio_empty={audio_empty}/{n} [expected — no audio data]")

        logger.info(f"  {mname:<12}: {', '.join(msgs)}")


def dead_sequences(Xf, Xa, mod):
    """Check for sequences with no temporal change (constant embeddings), stratified by modality.

    Args:
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
        mod: Modality integer array of shape (N,).
    """
    _header("DEAD SEQUENCE CHECK  (no temporal change, modality-aware)")
    face_diffs = np.abs(np.diff(Xf, axis=1)).mean(axis=(1, 2))
    audio_diffs = np.abs(np.diff(Xa, axis=1)).mean(axis=(1, 2))

    for m, mname, check_face, check_audio in [
        (MODALITY_AUDIO_ONLY, "audio_only", False, True),
        (MODALITY_VIDEO_ONLY, "video_only", True, False),
        (MODALITY_BOTH, "both", True, True),
    ]:
        idx = mod == m
        n = idx.sum()
        if n == 0:
            continue

        msgs = []
        if check_face:
            fd = int((face_diffs[idx] < 1e-4).sum())
            status = "[OK]" if fd == 0 else "[WARN]"
            msgs.append(f"face_dead={fd}/{n} {status}")
        else:
            fd = int((face_diffs[idx] < 1e-4).sum())
            msgs.append(f"face_dead={fd}/{n} [expected]")

        if check_audio:
            ad = int((audio_diffs[idx] < 1e-4).sum())
            status = "[OK]" if ad == 0 else f"[WARN] {ad} silent sequences"
            msgs.append(f"audio_dead={ad}/{n} {status}")
        else:
            ad = int((audio_diffs[idx] < 1e-4).sum())
            msgs.append(f"audio_dead={ad}/{n} [expected]")

        logger.info(f"  {mname:<12}: {', '.join(msgs)}")


def mask_alignment(fm, am, mod):
    """Check face/audio mask alignment for samples with both modalities present.

    Mismatch is expected for ``audio_only`` and ``video_only`` samples and is
    only flagged for ``both`` samples.

    Args:
        fm: Face validity masks of shape (N, T).
        am: Audio validity masks of shape (N, T).
        mod: Modality integer array of shape (N,).
    """
    _header("MASK ALIGNMENT CHECK")
    logger.info(
        "  Note: face/audio mask mismatch is EXPECTED for audio_only and video_only."
    )
    logger.info("  Only 'both' samples should have aligned masks.")

    both_idx = mod == MODALITY_BOTH
    if both_idx.sum() == 0:
        logger.info("  No 'both' samples — skipping alignment check.")
        return

    diff = float(np.abs(fm[both_idx] - am[both_idx]).mean())
    logger.info(f"  'both' samples mask alignment diff: {diff:.4f}")
    if diff > 0.3:
        logger.warning(
            f"  [WARN] mask diff={diff:.4f} in 'both' samples — face or audio extraction "
            "may have failed for some frames. Check silent frame skipping threshold."
        )
    else:
        logger.info("  [OK] face and audio masks reasonably aligned for 'both' samples")


def temporal_variance(Xf, Xa, mod):
    """Log mean temporal variance of embeddings, stratified by modality.

    Args:
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
        mod: Modality integer array of shape (N,).
    """
    _header("TEMPORAL VARIANCE  (modality-aware)")
    face_idx = np.isin(mod, [MODALITY_VIDEO_ONLY, MODALITY_BOTH])
    audio_idx = np.isin(mod, [MODALITY_AUDIO_ONLY, MODALITY_BOTH])

    if face_idx.sum():
        fv = float(np.var(Xf[face_idx], axis=1).mean())
        logger.info(f"  face  (video_only+both): {fv:.6f}")
    if audio_idx.sum():
        av = float(np.var(Xa[audio_idx], axis=1).mean())
        logger.info(f"  audio (audio_only+both): {av:.6f}")


def class_balance(y_tr, y_va, y_te):
    """Log class distribution and imbalance ratio across all splits.

    Args:
        y_tr: Training label array.
        y_va: Validation label array.
        y_te: Test label array.
    """
    _header("CLASS BALANCE")
    total = np.concatenate([y_tr, y_va, y_te])
    counts = dict(Counter(total.tolist()))
    max_c = max(counts.values())
    min_c = min(counts.values())
    ratio = max_c / min_c
    logger.info(f"  global counts  : {counts}")
    logger.info(f"  imbalance ratio: {ratio:.2f}x")
    if ratio > 2.0:
        logger.warning(
            "  [WARN] severe class imbalance — consider weighted loss or oversampling"
        )
    elif ratio > 1.3:
        logger.info("  [NOTE] mild imbalance — monitor per-class val accuracy")
    else:
        logger.info("  [OK] classes reasonably balanced")

    for name, y in [("train", y_tr), ("val", y_va), ("test", y_te)]:
        logger.info(f"  {name:<6}: {dict(Counter(y.tolist()))}")


def check_overlap(a_tr, a_va, a_te):
    """Check for actor ID leakage across train, val, and test splits.

    Args:
        a_tr: Actor IDs for training samples.
        a_va: Actor IDs for validation samples.
        a_te: Actor IDs for test samples.
    """
    _header("ACTOR OVERLAP CHECK")
    tr, va, te = set(a_tr.tolist()), set(a_va.tolist()), set(a_te.tolist())
    tv = tr & va
    tt = tr & te
    vt = va & te
    logger.info(f"  train ∩ val  : {tv if tv else '∅  [OK]'}")
    logger.info(f"  train ∩ test : {tt if tt else '∅  [OK]'}")
    logger.info(f"  val ∩ test   : {vt if vt else '∅  [OK]'}")
    if tv or tt or vt:
        logger.error(
            "  [ERROR] ACTOR LEAKAGE DETECTED — splits are not actor-disjoint!"
        )
    else:
        logger.info("  [OK] no actor leakage across splits")


def seq_len_check(Xf, Xa):
    """Verify that face and audio sequence lengths match.

    Args:
        Xf: Face embeddings of shape (N, T, D_face).
        Xa: Audio embeddings of shape (N, T, D_audio).
    """
    _header("SEQUENCE LENGTH CHECK")
    logger.info(f"  face  seq len: {Xf.shape[1]}")
    logger.info(f"  audio seq len: {Xa.shape[1]}")
    if Xf.shape[1] != Xa.shape[1]:
        logger.error("  [ERROR] face and audio seq lengths differ!")
    else:
        logger.info("  [OK] seq lengths match")


def main():
    """Run all dataset inspection checks and write results to the log file."""
    logger.info(f"Log file: {log_file}")

    if not DATA_PATH.exists():
        logger.error(f"{DATA_PATH} not found")
        raise FileNotFoundError(f"{DATA_PATH} not found")

    with np.load(DATA_PATH) as data:
        Xf_tr = data["X_face_train"]
        Xa_tr = data["X_audio_train"]
        fm_tr = data["face_mask_train"]
        am_tr = data["audio_mask_train"]
        y_tr = data["y_train"]
        a_tr = data["actor_train"]
        mod_tr = data["modality_train"]

        Xf_va = data["X_face_val"]
        Xa_va = data["X_audio_val"]
        fm_va = data["face_mask_val"]
        am_va = data["audio_mask_val"]
        y_va = data["y_val"]
        a_va = data["actor_val"]
        mod_va = data["modality_val"]

        Xf_te = data["X_face_test"]
        Xa_te = data["X_audio_test"]
        fm_te = data["face_mask_test"]
        am_te = data["audio_mask_test"]
        y_te = data["y_test"]
        a_te = data["actor_test"]
        mod_te = data["modality_test"]

    stats("train", Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, a_tr, mod_tr)
    stats("val", Xf_va, Xa_va, fm_va, am_va, y_va, a_va, mod_va)
    stats("test", Xf_te, Xa_te, fm_te, am_te, y_te, a_te, mod_te)

    seq_len_check(Xf_tr, Xa_tr)
    embedding_norms(Xf_tr, Xa_tr, mod_tr)
    temporal_variance(Xf_tr, Xa_tr, mod_tr)
    audio_norm_check(Xa_tr, mod_tr)
    face_norm_check(Xf_tr, mod_tr)
    empty_samples(Xf_tr, Xa_tr, mod_tr)
    dead_sequences(Xf_tr, Xa_tr, mod_tr)
    mask_alignment(fm_tr, am_tr, mod_tr)
    class_balance(y_tr, y_va, y_te)
    check_overlap(a_tr, a_va, a_te)

    if SPLITS_PATH.exists():
        _header("SAVED SPLITS")
        with open(SPLITS_PATH) as f:
            splits = json.load(f)
        for k, v in splits.items():
            if isinstance(v, list):
                logger.info(f"  {k} ({len(v)}): {v}")
            else:
                logger.info(f"  {k}: {v}")

    _header("INSPECT COMPLETE")


if __name__ == "__main__":
    main()
