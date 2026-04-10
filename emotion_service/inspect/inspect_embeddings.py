"""
Sanity checks for the extracted dataset.npz before training.

Catches common issues early:
- NaN / Inf values in face or audio embeddings
- Actor leakage between train / val / test splits
- Severe class imbalance
- Low mask coverage (too many missing detections)
- Degenerate embeddings (near-zero norms)
"""

import numpy as np
import json
from collections import Counter
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DATA_PATH = BASE_DIR / "extracted_dataset" / "dataset.npz"
SPLITS_PATH = BASE_DIR / "extracted_dataset" / "splits.json"


def stats(name, Xf, Xa, fm, am, y, act):

    """Print shape, NaN/Inf counts, mask coverage, and label/actor distribution."""

    print(f"\n---- {name.upper()} ----")
    print("samples:", len(y))
    print("face shape:", Xf.shape)
    print("audio shape:", Xa.shape)

    print("\nNaN / Inf check:")
    print("face NaN:", int(np.isnan(Xf).sum()), "Inf:", int(np.isinf(Xf).sum()))
    print("audio NaN:", int(np.isnan(Xa).sum()), "Inf:", int(np.isinf(Xa).sum()))

    print("\nmask coverage:")
    print("face coverage %:", float(fm.mean()))
    print("audio coverage %:", float(am.mean()))

    print("\nlabel distribution:")
    print(dict(Counter(y.tolist())))

    print("\nactor distribution:")
    print(dict(Counter(act.tolist())))


def embedding_norms(Xf, Xa):

    """
    Check L2 norms of face and audio embeddings across the sequence dimension.

    Audio embeddings should be close to 1.0 after L2 normalisation in the
    extraction step. Face embeddings are not normalised so norms will vary.
    Near-zero mean norms indicate a failed extraction pass.
    """

    face_norms = np.linalg.norm(Xf, axis=2)
    audio_norms = np.linalg.norm(Xa, axis=2)

    print("\nembedding norms:")
    print("face mean:", float(face_norms.mean()), "std:", float(face_norms.std()))
    print("audio mean:", float(audio_norms.mean()), "std:", float(audio_norms.std()))

    print("face min/max:", float(face_norms.min()), float(face_norms.max()))
    print("audio min/max:", float(audio_norms.min()), float(audio_norms.max()))


def temporal_variance(Xf, Xa):

    """
    Measure how much embeddings change across the sequence dimension.

    Very low variance means the model is seeing static / repeated frames,
    which can hurt temporal learning in the transformer.
    """

    face_var = float(np.var(Xf, axis=1).mean())
    audio_var = float(np.var(Xa, axis=1).mean())

    print("\ntemporal variance:")
    print("face:", face_var)
    print("audio:", audio_var)


def sparsity_check(fm, am):

    """
    Report the fraction of frames with no valid detection (mask == 0).

    High sparsity in face masks is expected for audio-only clips.
    High sparsity in audio masks suggests silent segments or bad audio.
    """

    print("\nsparsity:")
    print("face zero ratio:", float((fm == 0).mean()))
    print("audio zero ratio:", float((am == 0).mean()))


def check_overlap(a_tr, a_va, a_te):
    tr = set(a_tr.tolist())
    va = set(a_va.tolist())
    te = set(a_te.tolist())

    print("\nactor overlap check:")
    print("train ∩ val:", tr & va)
    print("train ∩ test:", tr & te)
    print("val ∩ test:", va & te)


def class_balance(y_tr, y_va, y_te):
    total = np.concatenate([y_tr, y_va, y_te])
    print("\nclass balance (global):")
    print(dict(Counter(total.tolist())))


def main():
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"{DATA_PATH} not found")

    with np.load(DATA_PATH) as data:
        Xf_tr = data["X_face_train"]
        Xa_tr = data["X_audio_train"]
        fm_tr = data["face_mask_train"]
        am_tr = data["audio_mask_train"]
        y_tr = data["y_train"]
        a_tr = data["actor_train"]

        Xf_va = data["X_face_val"]
        Xa_va = data["X_audio_val"]
        fm_va = data["face_mask_val"]
        am_va = data["audio_mask_val"]
        y_va = data["y_val"]
        a_va = data["actor_val"]

        Xf_te = data["X_face_test"]
        Xa_te = data["X_audio_test"]
        fm_te = data["face_mask_test"]
        am_te = data["audio_mask_test"]
        y_te = data["y_test"]
        a_te = data["actor_test"]

    stats("train", Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, a_tr)
    stats("val", Xf_va, Xa_va, fm_va, am_va, y_va, a_va)
    stats("test", Xf_te, Xa_te, fm_te, am_te, y_te, a_te)

    print("\n---- GLOBAL CHECKS ----")

    embedding_norms(Xf_tr, Xa_tr)
    temporal_variance(Xf_tr, Xa_tr)
    sparsity_check(fm_tr, am_tr)
    class_balance(y_tr, y_va, y_te)
    check_overlap(a_tr, a_va, a_te)

    if SPLITS_PATH.exists():
        with open(SPLITS_PATH) as f:
            splits = json.load(f)
        print("\nSaved splits:")
        print(splits)


if __name__ == "__main__":
    main()
