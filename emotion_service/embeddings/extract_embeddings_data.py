
"""
Extract embeddings from RAVDESS audio-video dataset and prepare data for training.

This script processes video/audio files to generate multimodal features:
- Face features  : AU intensities + emotion probabilities (27-dim) using py-feat
- Audio features : Mean-pooled Wav2Vec2 embeddings (1024-dim)

Processing:
- Uniformly samples SEQ_LEN frames per clip
- Aligns audio segments with visual frames
- Aggregates features into sequences

Data Splitting:
- Actor-based split to prevent data leakage across train/val/test sets

Output:
- Saves processed dataset as a compressed .npz file

Dependencies:
- py-feat (facial feature extraction)
- Wav2Vec2 (audio embeddings)
"""

import os
import json
import shutil
import random
import subprocess
import tempfile
import logging
from pathlib import Path
from typing import List, Tuple, Optional

import numpy as np
import torch
import cv2
import librosa
from tqdm import tqdm

from feat import Detector
from transformers import Wav2Vec2Processor, Wav2Vec2Model

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).parent / "config.json"

if not CONFIG_PATH.exists():
    raise FileNotFoundError(f"Missing config.json at {CONFIG_PATH}")

with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

DATA_ROOT = str(BASE_DIR / CONFIG["paths"]["data_root"])
EXTRACT_DIR = BASE_DIR / CONFIG["paths"]["extract_dir"]
CHUNKS_DIR = Path(EXTRACT_DIR) / "chunks"
OUT_PATH = str(EXTRACT_DIR / "dataset.npz")

CHUNK_SIZE = CONFIG["processing"]["chunk_size"]
SEQ_LEN = CONFIG["processing"]["seq_len"]
SR = CONFIG["processing"]["sample_rate"]
AUDIO_WINDOW_SEC = CONFIG["processing"]["audio_window_sec"]

DEVICE = CONFIG["device"]
SEED = CONFIG["split"]["seed"]

random.seed(SEED)
np.random.seed(SEED)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger(__name__)

# RAVDESS emotion code → class index
# RAVDESS uses two-digit codes in the filename stem (e.g. 03 = happy).
# Neutral/calm are merged into class 5.
# Surprised (08) is excluded due to limited samples and ambiguous valence.

# This mapping ensures:
# - Better class balance
# - Reduced noise from ambiguous emotions
# - More stable model training


EMOTION_MAP = {
    "01": 5,
    "02": 5,
    "03": 3,
    "04": 4,
    "05": 0,
    "06": 2,
    "07": 1,
    "08": None,
}

face_detector = None
processor = None
wav2vec = None

FACE_DIM = 27   # 17 AUs + 7 basic emotions + 3 pose angles (py-feat default)

def load_models():
    global face_detector, processor, wav2vec

    logger.info("Loading face detector...")
    face_detector = Detector(device=DEVICE)

    logger.info("Loading audio model...")
    processor = Wav2Vec2Processor.from_pretrained(
        "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
    )

    wav2vec = (
        Wav2Vec2Model.from_pretrained(
            "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
        )
        .eval()
        .to(DEVICE)
    )

def discover_files(root: str) -> List[Tuple[Path, int, int]]:
    files = []
    for p in Path(root).rglob("*.*"):
        if p.suffix not in (".mp4", ".wav", ".m4a"):
            continue
        try:
            parts = p.stem.split("-")
            if len(parts) < 7:
                continue

            emotion = parts[2]
            actor = int(parts[6])

            if emotion not in EMOTION_MAP or EMOTION_MAP[emotion] is None:
                continue

            files.append((p, EMOTION_MAP[emotion], actor))
        except Exception as e:
            logger.warning(f"Skipping {p}: {e}")

    return sorted(files)


def load_audio(path: Path) -> Optional[np.ndarray]:

    """
    Load and preprocess an audio file for feature extraction.

    - Supports common formats (WAV, MP3, MP4).
    - MP4 files are decoded via ffmpeg to WAV.
    - Resamples audio to SR Hz and converts to mono.
    - Pads or truncates clips to a fixed 4-second duration.

    Returns:

    np.ndarray: Audio signal (shape: [samples])
    None: If decoding or loading fails
    """

    try:
        if path.suffix in [".wav", ".m4a"]:
            y, _ = librosa.load(path, sr=SR, mono=True)
        else:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name

            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                str(SR),
                "-ac",
                "1",
                tmp_path,
            ]

            result = subprocess.run(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            if result.returncode != 0:
                return None

            y, _ = librosa.load(tmp_path, sr=SR, mono=True)
            os.remove(tmp_path)

        if y is None or len(y) == 0:
            return None

        if len(y) < SR * 4:     # CLIP_DURATION_SEC = 4
            y = np.pad(y, (0, SR * 4 - len(y)))
        else:
            y = y[: SR * 4]

        return y.astype(np.float32)

    except Exception as e:
        logger.warning(f"Audio error {path}: {e}")
        return None


def extract_audio_at_times(y, times):

    """
    Extract Wav2Vec2 embeddings for a sequence of timestamps.

    - Audio segments are windowed around each timestamp in `times`
    - Segments are batched and passed through Wav2Vec2
    - Output embeddings are L2-normalized
    - Silent segments (std < 1e-5) are skipped

    Args:

    times (List[float]): Timestamps (in seconds) for feature extraction

    Returns:

    feats (np.ndarray): Shape (SEQ_LEN, 1024), float32
    Zero-padded where embeddings could not be computed
    mask (np.ndarray): Shape (SEQ_LEN,), float32
    1.0 for valid embeddings, 0.0 for skipped/silent segments
    """

    feats = np.zeros((SEQ_LEN, 1024), dtype=np.float32)
    mask = np.zeros(SEQ_LEN, dtype=np.float32)

    if y is None:
        return feats, mask

    win = int(SR * AUDIO_WINDOW_SEC)
    chunks, idxs = [], []

    for i, t in enumerate(times):
        try:
            c = int(t * SR)
            s = max(0, c - win // 2)
            e = min(len(y), s + win)

            if e - s < win // 4:
                continue

            segment = y[s:e]
            if np.std(segment) < 1e-5: # skip near-silent segments
                continue

            chunks.append(segment.astype(np.float32))
            idxs.append(i)

        except Exception:
            continue

    if not chunks:
        return feats, mask

    inputs = processor(chunks, sampling_rate=SR, return_tensors="pt", padding=True)
    inputs = {k: v.to(DEVICE) for k, v in inputs.items()}

    with torch.no_grad():
        out = wav2vec(**inputs).last_hidden_state.mean(dim=1).cpu().numpy()

    # normalization
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    out = out / (norms + 1e-6)

    for i, j in enumerate(idxs):
        feats[j] = out[i]
        mask[j] = 1.0

    return feats, mask

def extract_frames_with_time(path):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return []

    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    if fps <= 0 or total <= 0:
        cap.release()
        return []

    duration = total / fps
    times = np.linspace(0, duration, SEQ_LEN)

    frames = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, f = cap.read()
        frames.append((cv2.cvtColor(f, cv2.COLOR_BGR2RGB) if ret else None, t))

    cap.release()
    return frames


def build_face_sequence(frames):

    """
    Extract face-based features from sampled video frames.

    - Performs batch face detection on input frames
    - Extracts Action Unit (AU) intensities and emotion probabilities
    - Missing detections are forward-filled using the last valid embedding
    - If no face is detected in the entire clip, outputs are zero-initialized

    Returns:

    seq (np.ndarray): Shape (SEQ_LEN, FACE_DIM), float32
    Sequence of face feature embeddings
    times (np.ndarray): Shape (SEQ_LEN,), float64
    Timestamps corresponding to each sampled frame (in seconds)
    mask (np.ndarray): Shape (SEQ_LEN,), float32
    1.0 for valid detections, 0.0 where features were filled or missing
    """

    seq = np.zeros((SEQ_LEN, FACE_DIM), dtype=np.float32)
    mask = np.zeros(SEQ_LEN, dtype=np.float32)

    times, last = [], None
    tmp_paths = {}

    for i, (f, t) in enumerate(frames):
        times.append(t)

        if f is not None:
            try:
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                    cv2.imwrite(tmp.name, cv2.cvtColor(f, cv2.COLOR_RGB2BGR))
                    tmp_paths[i] = tmp.name
            except Exception:
                continue

    if not tmp_paths:
        return seq, np.array(times), mask

    try:
        results = face_detector.detect_image(list(tmp_paths.values()))

        for idx, (frame_idx, _) in enumerate(tmp_paths.items()):
            try:
                aus = results.aus.values[idx]
                emotions = results.emotions.values[idx]

                emb = np.concatenate([aus, emotions]).astype(np.float32)

                seq[frame_idx] = emb
                mask[frame_idx] = 1
                last = emb

            except Exception:
                if last is not None:
                    seq[frame_idx] = last

    except Exception as e:
        logger.warning(f"Batch face detection failed: {e}")

    finally:
        for p in tmp_paths.values():
            if os.path.exists(p):
                os.remove(p)

    return seq, np.array(times), mask


def process_video(path, label, actor):

    """
    Extract face and audio sequences for a single RAVDESS file.
 
    For .mp4 files both modalities are extracted.
    For audio-only files (.wav, .m4a) face features are zeroed out.
 
    Returns a tuple of (face_seq, audio_seq, label, face_mask, audio_mask, actor)
    or None if processing fails.
    """

    try:
        if path.suffix == ".mp4":
            frames = extract_frames_with_time(path)
            if not frames:
                return None

            face_seq, times, face_mask = build_face_sequence(frames)

        else:
            duration = librosa.get_duration(path=str(path))
            times = np.linspace(0, min(duration, 4.0), SEQ_LEN)

            face_seq = np.zeros((SEQ_LEN, FACE_DIM), dtype=np.float32)
            face_mask = np.zeros(SEQ_LEN, dtype=np.float32)

        y = load_audio(path)
        audio_seq, audio_mask = extract_audio_at_times(y, times)

        return face_seq, audio_seq, label, face_mask, audio_mask, actor

    except Exception as e:
        logger.warning(f"Processing failed {path}: {e}")
        return None


def main():

    """
    Full extraction pipeline:
      1. Process files in chunks and save intermediate .npz files.
      2. Merge all chunks into a single array.
      3. Split by actor (70 / 15 / 15) and save the final dataset.npz.
 
    Chunked processing allows resuming after interruption — existing chunk
    files are skipped automatically.
    """

    try:
        load_models()

        os.makedirs(EXTRACT_DIR, exist_ok=True)
        os.makedirs(CHUNKS_DIR, exist_ok=True)

        files = discover_files(DATA_ROOT)
        if not files:
            raise RuntimeError(f"No files found in {DATA_ROOT}")

        total_chunks = (len(files) + CHUNK_SIZE - 1) // CHUNK_SIZE

        for chunk_idx in range(total_chunks):
            chunk_path = CHUNKS_DIR / f"chunk_{chunk_idx:03d}.npz"

            if chunk_path.exists():
                logger.info(f"chunk {chunk_idx} exists, skipping")
                continue

            batch = files[chunk_idx * CHUNK_SIZE : (chunk_idx + 1) * CHUNK_SIZE]
            results = []

            for path, label, actor in tqdm(batch):
                r = process_video(path, label, actor)
                if r is not None:
                    results.append(r)

            if not results:
                continue

            Xf, Xa, y, fm, am, act = zip(*results)

            np.savez_compressed(
                chunk_path,
                X_face=np.stack(Xf),
                X_audio=np.stack(Xa),
                y=np.array(y),
                face_mask=np.stack(fm),
                audio_mask=np.stack(am),
                actors=np.array(act),
            )

        # MERGE
        Xf, Xa, y, fm, am, act = [], [], [], [], [], []

        for p in sorted(CHUNKS_DIR.glob("chunk_*.npz")):
            with np.load(p) as d:
                Xf.append(d["X_face"])
                Xa.append(d["X_audio"])
                y.append(d["y"])
                fm.append(d["face_mask"])
                am.append(d["audio_mask"])
                act.append(d["actors"])

        Xf = np.concatenate(Xf)
        Xa = np.concatenate(Xa)
        y = np.concatenate(y)
        fm = np.concatenate(fm)
        am = np.concatenate(am)
        act = np.concatenate(act)

        # SPLIT
        actors = list(map(int, sorted(np.unique(act))))
        random.shuffle(actors)

        n = len(actors)
        train_a = actors[: int(0.7 * n)]
        val_a = actors[int(0.7 * n) : int(0.85 * n)]
        test_a = actors[int(0.85 * n) :]

        def split(a_list):
            idx = [i for i, a in enumerate(act) if int(a) in set(a_list)]
            return Xf[idx], Xa[idx], fm[idx], am[idx], y[idx], act[idx]

        Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, a_tr = split(train_a)
        Xf_va, Xa_va, fm_va, am_va, y_va, a_va = split(val_a)
        Xf_te, Xa_te, fm_te, am_te, y_te, a_te = split(test_a)

        np.savez_compressed(
            OUT_PATH,
            X_face_train=Xf_tr,
            X_audio_train=Xa_tr,
            face_mask_train=fm_tr,
            audio_mask_train=am_tr,
            y_train=y_tr,
            actor_train=a_tr,
            X_face_val=Xf_va,
            X_audio_val=Xa_va,
            face_mask_val=fm_va,
            audio_mask_val=am_va,
            y_val=y_va,
            actor_val=a_va,
            X_face_test=Xf_te,
            X_audio_test=Xa_te,
            face_mask_test=fm_te,
            audio_mask_test=am_te,
            y_test=y_te,
            actor_test=a_te,
        )

        shutil.rmtree(CHUNKS_DIR)

        logger.info("FULL PIPELINE COMPLETE")

    except Exception as e:
        logger.exception(f"FATAL: {e}")
        raise


if __name__ == "__main__":
    main()
