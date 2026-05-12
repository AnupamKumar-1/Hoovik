"""Extract test-split samples from the dataset and save them as .npy files for inference.

Usage
-----
# Single sample (index 0 by default)
python create_sample.py

# Specific index
python create_sample.py --index 42

# First N samples of a given emotion
python create_sample.py --emotion sad --count 3

# One sample per emotion
python create_sample.py --one-per-emotion

# Restrict to one dataset source
python create_sample.py --emotion happy --source ravdess

# Save a manifest of all extracted samples
python create_sample.py --one-per-emotion --save-manifest
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent

_cfg_path = ROOT / "config" / "config.json"
if not _cfg_path.exists():
    sys.exit(f"ERROR: config.json not found at {_cfg_path}")

with open(_cfg_path) as _f:
    _cfg = json.load(_f)

EMOTION_NAMES: list[str] = _cfg["misc"]["class_names"]

ACTOR_ID_THRESHOLD: int = _cfg["misc"]["actor_id_threshold"]
SEQ_LEN: int = _cfg["processing"]["seq_len"]
FACE_DIM: int = _cfg["processing"]["face_dim"]
AUDIO_DIM: int = _cfg["processing"]["audio_dim"]
DATASET_PATH = ROOT / _cfg["paths"]["dataset"]
OUT_DIR = ROOT / "sample_inputs"

_EMOTION_CHOICES: list[str] = [e.replace("/", "_") for e in EMOTION_NAMES]


def load_data() -> dict:
    """Load the test split from the dataset file and validate shapes against config.

    Returns:
        Dictionary of arrays keyed by dataset field name.
    """
    if not DATASET_PATH.exists():
        sys.exit(f"ERROR: dataset not found at {DATASET_PATH}")
    data = dict(np.load(DATASET_PATH))
    xf_shape = data["X_face_test"].shape
    xa_shape = data["X_audio_test"].shape
    if xf_shape[1] != SEQ_LEN or xf_shape[2] != FACE_DIM:
        sys.exit(
            f"ERROR: X_face_test shape {xf_shape} does not match config "
            f"(seq_len={SEQ_LEN}, face_dim={FACE_DIM})"
        )
    if xa_shape[1] != SEQ_LEN or xa_shape[2] != AUDIO_DIM:
        sys.exit(
            f"ERROR: X_audio_test shape {xa_shape} does not match config "
            f"(seq_len={SEQ_LEN}, audio_dim={AUDIO_DIM})"
        )
    return data


def save_sample(data: dict, idx: int, tag: str) -> dict:
    """Save one test-split sample to disk and return its metadata summary.

    Args:
        data: Loaded dataset dictionary.
        idx: Index into the test split.
        tag: Label appended to output filenames (e.g. ``"sad_0"`` or ``"42"``).

    Returns:
        Dictionary containing index, label, source, modality, file paths,
        and the corresponding inference command.
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    xf = data["X_face_test"][idx]
    xa = data["X_audio_test"][idx]
    fm = data["face_mask_test"][idx]
    am = data["audio_mask_test"][idx]
    actor = int(data["actor_test"][idx])
    label = int(data["y_test"][idx])
    mod_flag = int(data["modality_test"][idx])

    paths = {
        "face": OUT_DIR / f"xf_{tag}.npy",
        "audio": OUT_DIR / f"xa_{tag}.npy",
        "face_mask": OUT_DIR / f"fm_{tag}.npy",
        "audio_mask": OUT_DIR / f"am_{tag}.npy",
    }

    np.save(paths["face"], xf)
    np.save(paths["audio"], xa)
    np.save(paths["face_mask"], fm)
    np.save(paths["audio_mask"], am)

    source = "RAVDESS" if actor < ACTOR_ID_THRESHOLD else "CREMA-D"
    _MODALITY_NAMES = {0: "audio_only", 1: "video_only", 2: "both"}
    modality = _MODALITY_NAMES.get(mod_flag, "none")

    cmd = (
        f"python inference/predict.py"
        f" --face {paths['face']}"
        f" --audio {paths['audio']}"
        f" --face_mask {paths['face_mask']}"
        f" --audio_mask {paths['audio_mask']}"
    )

    return {
        "index": idx,
        "tag": tag,
        "true_label": EMOTION_NAMES[label],
        "actor": actor,
        "source": source,
        "modality": modality,
        "face_frames": int(fm.sum()),
        "audio_frames": int(am.sum()),
        "paths": {k: str(v) for k, v in paths.items()},
        "run_cmd": cmd,
    }


def print_summary(s: dict) -> None:
    """Print a formatted summary of an extracted sample to stdout.

    Args:
        s: Metadata dictionary returned by :func:`save_sample`.
    """
    print(f"\n{'─'*58}")
    print(f"  Index       : {s['index']}")
    print(f"  True label  : {s['true_label'].upper()}")
    print(f"  Source      : {s['source']}  (actor {s['actor']})")
    print(
        f"  Modality    : {s['modality']}  "
        f"(face frames={s['face_frames']}  audio frames={s['audio_frames']})"
    )
    print(f"  Saved to    : {OUT_DIR}/")
    print(f"\n  Run:\n    {s['run_cmd']}")
    print(f"{'─'*58}")


def source_mask(act: np.ndarray, source: str) -> np.ndarray:
    """Return a boolean mask selecting samples from the specified dataset source.

    Args:
        act: Actor ID array of shape (N,).
        source: One of ``"ravdess"``, ``"cremad"``, or ``"both"``.

    Returns:
        Boolean array of shape (N,).
    """
    if source == "ravdess":
        return act < ACTOR_ID_THRESHOLD
    if source == "cremad":
        return act >= ACTOR_ID_THRESHOLD
    return np.ones(len(act), dtype=bool)


def emotion_id(choice: str) -> int:
    """Map a CLI-safe emotion key to its index in ``EMOTION_NAMES``.

    Args:
        choice: CLI-safe key where ``"/"`` has been replaced with ``"_"``
            (e.g. ``"neutral_calm"``).

    Returns:
        Integer index into ``EMOTION_NAMES``.

    Raises:
        ValueError: If ``choice`` does not match any known emotion.
    """
    for i, name in enumerate(EMOTION_NAMES):
        if name.replace("/", "_") == choice:
            return i
    raise ValueError(f"Unknown emotion choice: {choice!r}")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Populated argument namespace.
    """
    p = argparse.ArgumentParser(
        description="Extract test-split samples for inference/predict.py"
    )

    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--index",
        type=int,
        metavar="N",
        help="Single test-set index to extract",
    )
    mode.add_argument(
        "--emotion",
        choices=_EMOTION_CHOICES,
        metavar="{" + ",".join(_EMOTION_CHOICES) + "}",
        help="Extract the first --count samples of this emotion",
    )
    mode.add_argument(
        "--one-per-emotion",
        action="store_true",
        help="Extract one sample per emotion class",
    )

    p.add_argument(
        "--count",
        type=int,
        default=1,
        help="Number of samples to extract when --emotion is used (default: 1)",
    )
    p.add_argument(
        "--source",
        choices=["ravdess", "cremad", "both"],
        default="both",
        help="Restrict samples to one dataset source (default: both)",
    )
    p.add_argument(
        "--save-manifest",
        action="store_true",
        help="Write sample_inputs/manifest.json with all sample metadata",
    )
    return p.parse_args()


def main() -> None:
    """Run sample extraction according to the parsed CLI arguments."""
    args = parse_args()
    data = load_data()
    y_te = data["y_test"]
    act_te = data["actor_test"]
    n_test = len(y_te)

    src_mask = source_mask(act_te, args.source)
    summaries: list[dict] = []

    if args.one_per_emotion:
        if args.count != 1:
            warnings.warn("--count is ignored when --one-per-emotion is set")

        for eid, ename in enumerate(EMOTION_NAMES):
            candidates = np.where((y_te == eid) & src_mask)[0]
            if len(candidates) == 0:
                print(
                    f"  [skip] no test samples for '{ename}' "
                    f"with source='{args.source}'"
                )
                continue
            idx = int(candidates[0])
            safe = ename.replace("/", "_")
            s = save_sample(data, idx, tag=f"{safe}_0")
            summaries.append(s)
            print_summary(s)

    elif args.emotion is not None:
        eid = emotion_id(args.emotion)
        candidates = np.where((y_te == eid) & src_mask)[0]
        if len(candidates) == 0:
            sys.exit(
                f"No test samples found for emotion='{args.emotion}' "
                f"with source='{args.source}'"
            )
        count = min(args.count, len(candidates))
        if count < args.count:
            warnings.warn(
                f"Only {count} sample(s) available for '{args.emotion}' "
                f"(requested {args.count})"
            )
        for k in range(count):
            idx = int(candidates[k])
            s = save_sample(data, idx, tag=f"{args.emotion}_{k}")
            summaries.append(s)
            print_summary(s)

    else:
        target = args.index if args.index is not None else 0
        if args.count != 1:
            warnings.warn("--count is ignored when using --index mode")
        if target >= n_test:
            sys.exit(f"Index {target} out of range — test set has {n_test} samples")
        s = save_sample(data, target, tag=str(target))
        summaries.append(s)
        print_summary(s)

    if args.save_manifest and summaries:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        manifest_path = OUT_DIR / "manifest.json"
        with open(manifest_path, "w") as f:
            json.dump(summaries, f, indent=2)
        print(f"\n  Manifest saved → {manifest_path}")

    print(f"\n  {len(summaries)} sample(s) saved to {OUT_DIR}/\n")


if __name__ == "__main__":
    main()
