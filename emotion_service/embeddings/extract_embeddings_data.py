"""
Feature extraction pipeline for multimodal emotion recognition.

Extracts face and audio embeddings from RAVDESS and CREMA-D datasets,
assembles fixed-length sequences, computes train-only normalisation stats,
and serialises actor-stratified train/val/test splits to disk.

Face embedding (FACE_DIM = 272):
    136 (x, y) landmarks normalised to nose origin, canonical rotation,
    and inter-ocular scale + 51 ARKit blendshapes + 3 head pose angles
    (pitch, yaw, roll) clipped to [-1, 1].

Audio embedding (AUDIO_DIM):
    Mean-pooled last hidden state from Wav2Vec2
    (audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim).
    Each sequence step uses a centred window of AUDIO_WINDOW_SEC seconds.

Modality flags:
    MODALITY_AUDIO_ONLY (0) — .wav / .flac / audio-only files.
    MODALITY_VIDEO_ONLY (1) — video with no paired audio.
    MODALITY_BOTH       (2) — video with paired or embedded audio.

Resumable chunked processing:
    Videos are processed in chunks of CHUNK_SIZE. Each chunk is saved as
    chunks/chunk_NNN.npz before assembly so a crashed run can resume from
    the last completed chunk. The chunks directory is deleted on success.
"""

import os
import json
import shutil
import random
import logging
import threading
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import List, Tuple, Optional

import atexit
import multiprocessing

multiprocessing.set_start_method("spawn", force=True)

import numpy as np
import torch
import cv2
import librosa
from tqdm import tqdm

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from transformers import Wav2Vec2Processor, Wav2Vec2Model

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).parent / "extract_config.json"

if not CONFIG_PATH.exists():
    raise FileNotFoundError(f"Missing extract_config.json at {CONFIG_PATH}")

with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

DATA_ROOT = str(BASE_DIR / CONFIG["paths"]["data_root"])
EXTRACT_DIR = BASE_DIR / CONFIG["paths"]["extract_dir"]
CHUNKS_DIR = Path(EXTRACT_DIR) / "chunks"
OUT_PATH = Path(EXTRACT_DIR) / "dataset.npz"
SPLITS_PATH = BASE_DIR / CONFIG["paths"]["splits"]

CHUNK_SIZE = CONFIG["processing"]["chunk_size"]
SEQ_LEN = CONFIG["processing"]["seq_len"]
SR = CONFIG["processing"]["sample_rate"]
AUDIO_WINDOW_SEC = CONFIG["processing"]["audio_window_sec"]
AUDIO_DIM = CONFIG["processing"]["audio_dim"]
FACE_DIM = CONFIG["processing"]["face_dim"]
NUM_WORKERS = CONFIG["processing"]["num_workers"]
AUDIO_BATCH_SIZE = CONFIG["processing"]["audio_batch_size"]

TRAIN_RATIO = CONFIG["split"]["train_ratio"]
VAL_RATIO = CONFIG["split"]["val_ratio"]
SEED = CONFIG["split"]["seed"]

MODALITY_AUDIO_ONLY = 0
MODALITY_VIDEO_ONLY = 1
MODALITY_BOTH = 2

random.seed(SEED)
np.random.seed(SEED)

_cfg_device = CONFIG.get("device", "cpu")
if _cfg_device == "mps" and torch.backends.mps.is_available():
    TORCH_DEVICE = "mps"
elif _cfg_device == "cuda" and torch.cuda.is_available():
    TORCH_DEVICE = "cuda"
else:
    TORCH_DEVICE = "cpu"

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger(__name__)

RAVDESS_EMOTION_MAP = {
    "01": 5,
    "02": 5,
    "03": 3,
    "04": 4,
    "05": 0,
    "06": 2,
    "07": 1,
    "08": None,
}

CREMAD_EMOTION_MAP = {
    "ANG": 0,
    "FEA": 1,
    "DIS": 2,
    "HAP": 3,
    "SAD": 4,
    "NEU": 5,
}

KEY_LANDMARKS = [
    10,
    152,
    234,
    454,
    323,
    361,
    288,
    397,
    365,
    379,
    378,
    400,
    377,
    148,
    33,
    7,
    163,
    144,
    145,
    153,
    154,
    155,
    133,
    173,
    157,
    158,
    159,
    160,
    161,
    246,
    362,
    382,
    381,
    380,
    374,
    373,
    390,
    249,
    263,
    466,
    388,
    387,
    386,
    385,
    384,
    398,
    70,
    63,
    105,
    66,
    107,
    55,
    65,
    52,
    53,
    46,
    300,
    293,
    334,
    296,
    336,
    285,
    295,
    282,
    283,
    276,
    1,
    2,
    98,
    327,
    168,
    197,
    195,
    5,
    4,
    45,
    220,
    115,
    48,
    61,
    185,
    40,
    39,
    37,
    0,
    267,
    269,
    270,
    409,
    291,
    375,
    321,
    405,
    314,
    17,
    84,
    181,
    91,
    146,
    78,
    191,
    80,
    81,
    82,
    13,
    312,
    311,
    310,
    415,
    308,
    324,
    318,
    402,
    317,
    14,
    87,
    178,
    88,
    95,
    116,
    123,
    147,
    213,
    192,
    214,
    210,
    345,
    352,
    376,
    433,
    416,
    434,
    430,
    151,
    9,
    8,
]

assert len(KEY_LANDMARKS) == len(set(KEY_LANDMARKS)), "Duplicate landmarks!"
assert len(KEY_LANDMARKS) == 136, f"Expected 136, got {len(KEY_LANDMARKS)}"

NOSE_IDX = KEY_LANDMARKS.index(1)
LEFT_IDX = KEY_LANDMARKS.index(234)
RIGHT_IDX = KEY_LANDMARKS.index(454)
LEFT_EYE_IDX = KEY_LANDMARKS.index(33)
RIGHT_EYE_IDX = KEY_LANDMARKS.index(263)

BLENDSHAPE_ORDER = [
    "browDownLeft",
    "browDownRight",
    "browInnerUp",
    "browOuterUpLeft",
    "browOuterUpRight",
    "cheekPuff",
    "cheekSquintLeft",
    "cheekSquintRight",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "eyeLookDownLeft",
    "eyeLookDownRight",
    "eyeLookInLeft",
    "eyeLookInRight",
    "eyeLookOutLeft",
    "eyeLookOutRight",
    "eyeLookUpLeft",
    "eyeLookUpRight",
    "eyeSquintLeft",
    "eyeSquintRight",
    "eyeWideLeft",
    "eyeWideRight",
    "jawForward",
    "jawLeft",
    "jawOpen",
    "jawRight",
    "mouthClose",
    "mouthDimpleLeft",
    "mouthDimpleRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "mouthFunnel",
    "mouthLeft",
    "mouthLowerDownLeft",
    "mouthLowerDownRight",
    "mouthPressLeft",
    "mouthPressRight",
    "mouthPucker",
    "mouthRight",
    "mouthRollLower",
    "mouthRollUpper",
    "mouthShrugLower",
    "mouthShrugUpper",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthStretchLeft",
    "mouthStretchRight",
    "mouthUpperUpLeft",
    "mouthUpperUpRight",
    "noseSneerLeft",
    "noseSneerRight",
]

assert (
    len(BLENDSHAPE_ORDER) == 51
), f"Expected 51 blendshapes, got {len(BLENDSHAPE_ORDER)}"

FACE_LANDMARKER_PATH = Path(__file__).parent / "face_landmarker.task"

processor = None
wav2vec = None
_local = threading.local()


def _get_landmarker():
    """Return a thread-local MediaPipe FaceLandmarker, creating it on first access.

    Thread-local storage ensures each worker process owns an independent
    landmarker instance; MediaPipe objects are not safe to share across threads.
    Registers landmarker.close() with atexit to release GPU/CPU resources cleanly.
    """
    if not hasattr(_local, "landmarker"):
        if not FACE_LANDMARKER_PATH.exists():
            raise FileNotFoundError(
                f"face_landmarker.task not found at {FACE_LANDMARKER_PATH}\n"
                "Download: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
            )
        base_options = mp_python.BaseOptions(model_asset_path=str(FACE_LANDMARKER_PATH))
        options = mp_vision.FaceLandmarkerOptions(
            base_options=base_options,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
            num_faces=1,
            min_face_detection_confidence=0.2,
            min_face_presence_confidence=0.2,
            min_tracking_confidence=0.2,
        )
        _local.landmarker = mp_vision.FaceLandmarker.create_from_options(options)
        atexit.register(_local.landmarker.close)
    return _local.landmarker


def load_models():
    """Load and initialise the Wav2Vec2 processor and model onto TORCH_DEVICE.

    Sets module-level globals `processor` and `wav2vec`. Must be called once
    before any audio embedding extraction. Safe to call multiple times; each
    call replaces the existing globals.
    """
    global processor, wav2vec
    logger.info("Loading audio model...")
    processor = Wav2Vec2Processor.from_pretrained(
        "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
    )
    wav2vec = (
        Wav2Vec2Model.from_pretrained(
            "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
        )
        .eval()
        .to(TORCH_DEVICE)
    )
    logger.info(f"Audio model loaded on {TORCH_DEVICE}")


def extract_face_embedding(frame_rgb: np.ndarray) -> Optional[np.ndarray]:
    """Extract a normalised face embedding from an RGB image frame.

    Embedding layout (FACE_DIM = 272):
        [0:272]   136 (x, y) landmark pairs, nose-centred, canonically rotated,
                  scaled by inter-ocular distance.
        [272:323] 51 ARKit blendshape scores in BLENDSHAPE_ORDER.
        [323:326] Head pose (pitch, yaw, roll) in radians, clipped to [-1, 1].

    Returns:
        float32 array of shape (FACE_DIM,), or None if no face is detected
        or an exception occurs during landmark detection.
    """
    try:
        landmarker = _get_landmarker()
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
        result = landmarker.detect(mp_image)

        if not result.face_landmarks or len(result.face_landmarks) == 0:
            return None

        landmarks = result.face_landmarks[0]
        lm_xy = np.array(
            [[landmarks[i].x, landmarks[i].y] for i in KEY_LANDMARKS],
            dtype=np.float32,
        )

        lm_xy = lm_xy - lm_xy[NOSE_IDX]

        left_eye = lm_xy[LEFT_EYE_IDX]
        right_eye = lm_xy[RIGHT_EYE_IDX]
        dx = right_eye[0] - left_eye[0]
        dy = right_eye[1] - left_eye[1]
        angle = -np.arctan2(dy, dx)
        R = np.array(
            [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]],
            dtype=np.float32,
        )
        lm_xy = lm_xy @ R.T

        scale = np.linalg.norm(lm_xy[LEFT_IDX] - lm_xy[RIGHT_IDX]) + 1e-6
        lm_xy = lm_xy / scale
        lm_flat = lm_xy.flatten()

        if result.face_blendshapes and len(result.face_blendshapes) > 0:
            blend_dict = {b.category_name: b.score for b in result.face_blendshapes[0]}
            blendshapes = np.array(
                [blend_dict.get(k, 0.0) for k in BLENDSHAPE_ORDER], dtype=np.float32
            )
        else:
            blendshapes = np.zeros(51, dtype=np.float32)

        pose = np.zeros(3, dtype=np.float32)
        if (
            result.facial_transformation_matrixes
            and len(result.facial_transformation_matrixes) > 0
        ):
            mat = np.array(result.facial_transformation_matrixes[0], dtype=np.float32)
            if mat.shape == (4, 4):
                sy = np.sqrt(mat[0, 0] ** 2 + mat[1, 0] ** 2)
                pitch = float(np.arctan2(-mat[2, 1], mat[2, 2]))
                yaw = float(np.arctan2(mat[2, 0], sy))
                roll = float(np.arctan2(mat[1, 0], mat[0, 0]))
                pose = np.clip([pitch, yaw, roll], -1.0, 1.0).astype(np.float32)

        emb = np.concatenate([lm_flat, blendshapes, pose])

        if emb.shape[0] != FACE_DIM:
            logger.debug(f"Dim mismatch: got {emb.shape[0]}, expected {FACE_DIM}")
            return None

        return emb

    except Exception as e:
        logger.debug(f"Face embedding failed: {e}")
        return None


def _parse_ravdess(p: Path) -> Optional[Tuple[int, int, str]]:
    """Parse a RAVDESS filename and return (label, actor, modality_code).

    Modality codes per RAVDESS spec:
        '01' — full AV (.mp4 with embedded audio) → MODALITY_BOTH
        '02' — video-only (.mp4)                  → MODALITY_VIDEO_ONLY
        '03' — audio-only (.wav)                  → MODALITY_AUDIO_ONLY

    Returns None for filenames that do not conform to the RAVDESS naming
    convention or map to an unsupported emotion (e.g. surprised = None).
    """
    parts = p.stem.split("-")
    if len(parts) < 7:
        return None
    modality_code = parts[0]
    emotion = parts[2]
    try:
        actor = int(parts[6])
    except ValueError:
        return None
    label = RAVDESS_EMOTION_MAP.get(emotion)
    if label is None:
        return None
    return label, actor, modality_code


def _parse_cremad(p: Path) -> Optional[Tuple[int, int]]:
    """Parse a CREMA-D filename and return (label, actor).

    Actor IDs are offset by 1000 to avoid collision with RAVDESS actor IDs
    (RAVDESS uses 1–24; CREMA-D uses 1001+).

    Returns None for filenames that do not match the expected pattern or
    contain an unrecognised emotion code.
    """
    parts = p.stem.split("_")
    if len(parts) < 3:
        return None
    emotion = parts[2]
    try:
        actor = int(parts[0]) + 1000
    except ValueError:
        return None
    label = CREMAD_EMOTION_MAP.get(emotion)
    if label is None:
        return None
    return label, actor


def discover_files(root: str) -> List[Tuple[Path, int, int, Optional[Path]]]:
    """Scan RAVDESS and CREMA-D directories and return a sorted file manifest.

    Each entry is a tuple of (video_or_audio_path, label, actor, audio_path).
    audio_path is non-None only when a separate audio file is paired with a
    video, or when the video file itself carries embedded audio (RAVDESS AV).
    A None audio_path signals video-only to process_audio_batch.

    RAVDESS layout: root/RAVDESS/**/*.{mp4,wav,m4a}
    CREMA-D layout: root/CREMA-D/Video/*.mp4 + root/CREMA-D/Audio/*.{wav,flac}
    """
    root_path = Path(root)
    ravdess_root = root_path / "RAVDESS"
    cremad_root = root_path / "CREMA-D"

    files = []

    if ravdess_root.exists():
        for p in ravdess_root.rglob("*.*"):
            if p.suffix not in (".mp4", ".wav", ".m4a"):
                continue
            result = _parse_ravdess(p)
            if result is None:
                continue
            label, actor, modality_code = result
            if modality_code == "01" and p.suffix == ".mp4":
                files.append((p, label, actor, p))
            else:
                files.append((p, label, actor, None))

    if cremad_root.exists():
        video_dir = cremad_root / "Video"
        audio_dir = cremad_root / "Audio"

        video_stems: dict = {}
        if video_dir.exists():
            for p in video_dir.rglob("*.*"):
                if p.suffix not in (".mp4",):
                    continue
                result = _parse_cremad(p)
                if result is None:
                    continue
                video_stems[p.stem] = (p, result)

        audio_stems: dict = {}
        if audio_dir.exists():
            for p in audio_dir.rglob("*.*"):
                if p.suffix not in (".wav", ".flac"):
                    continue
                result = _parse_cremad(p)
                if result is None:
                    continue
                audio_stems[p.stem] = (p, result)

        all_stems = set(video_stems.keys()) | set(audio_stems.keys())
        for stem in all_stems:
            if stem in audio_stems:
                audio_path, audio_result = audio_stems[stem]
                label, actor = audio_result
                if stem in video_stems:
                    video_path, _ = video_stems[stem]
                    files.append((video_path, label, actor, audio_path))
                else:
                    files.append((audio_path, label, actor, None))
            else:
                video_path, video_result = video_stems[stem]
                label, actor = video_result
                files.append((video_path, label, actor, None))

    logger.info(
        f"Discovered {len(files)} files "
        f"(RAVDESS: {sum(1 for f in files if 'RAVDESS' in str(f[0]))}, "
        f"CREMA-D: {sum(1 for f in files if 'CREMA-D' in str(f[0]))})"
    )

    return sorted(files)


def _infer_modality(path: Path, audio_path: Optional[Path]) -> int:
    """Determine the modality flag from file structure, not extraction success.

    Modality is structural — it reflects what data sources exist, not whether
    extraction succeeded. This prevents a failed audio decode from silently
    demoting a MODALITY_BOTH sample to MODALITY_VIDEO_ONLY at training time.

    Rules:
        video (.mp4) + paired audio_path → MODALITY_BOTH
        video (.mp4) + no audio_path     → MODALITY_VIDEO_ONLY
        audio file (.wav/.flac/.m4a)     → MODALITY_AUDIO_ONLY
    """
    is_video = path.suffix == ".mp4"
    has_separate_audio = audio_path is not None

    if is_video and has_separate_audio:
        return MODALITY_BOTH
    elif is_video and not has_separate_audio:
        return MODALITY_VIDEO_ONLY
    else:
        return MODALITY_AUDIO_ONLY


def load_audio(path: Path) -> Optional[np.ndarray]:
    """Load an audio file and return a fixed-length float32 PCM array.

    Resamples to SR (mono). Pads with zeros if shorter than 4 seconds;
    truncates to 4 seconds if longer. Supports .wav, .flac, .m4a, and .mp4
    (audio track extracted via librosa/ffmpeg).

    Returns:
        float32 array of shape (SR * 4,), or None on load failure.
    """
    try:
        if path.suffix not in (".wav", ".flac", ".m4a", ".mp4"):
            logger.warning(f"Unsupported audio format, skipping: {path}")
            return None

        y, _ = librosa.load(path, sr=SR, mono=True)

        if y is None or len(y) == 0:
            return None

        target_len = SR * 4
        if len(y) < target_len:
            y = np.pad(y, (0, target_len - len(y)))
        else:
            y = y[:target_len]

        return y.astype(np.float32)

    except Exception as e:
        logger.warning(f"Audio error {path}: {e}")
        return None


def extract_frames_with_time(path: Path) -> List[Tuple[Optional[np.ndarray], float]]:
    """Extract SEQ_LEN evenly-spaced RGB frames from a video file.

    Samples frames at linearly spaced timestamps covering the full duration,
    excluding the final 1/SEQ_LEN fraction to avoid reading past the last frame.

    Returns:
        List of (rgb_frame_or_None, timestamp_seconds) tuples of length SEQ_LEN.
        Returns an empty list if the video cannot be opened or has no frames.
    """
    try:
        cap = cv2.VideoCapture(str(path))
        if not cap.isOpened():
            return []

        fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if fps <= 0 or total <= 0:
            cap.release()
            return []

        duration = total / fps
        times = np.linspace(0, duration * (1 - 1 / SEQ_LEN), SEQ_LEN)

        frames = []
        for t in times:
            frame_idx = int(t * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, f = cap.read()
            frames.append((cv2.cvtColor(f, cv2.COLOR_BGR2RGB) if ret else None, t))

        cap.release()
        return frames

    except Exception as e:
        logger.warning(f"Frame extraction failed {path}: {e}")
        return []


def build_face_sequence(frames: List[Tuple[Optional[np.ndarray], float]]):
    """Build a fixed-length face embedding sequence with last-good-frame carry-forward.

    For each frame slot, attempts MediaPipe embedding extraction. On failure,
    repeats the last successfully extracted embedding so the sequence remains
    dense. Slots with no prior successful embedding are left as zero vectors
    with mask=0.

    Returns:
        Tuple of (seq, times, mask):
            seq   — float32 array of shape (SEQ_LEN, FACE_DIM).
            times — float64 array of shape (SEQ_LEN,) with frame timestamps.
            mask  — float32 array of shape (SEQ_LEN,); 1.0 = valid, 0.0 = padded.
    """
    seq = np.zeros((SEQ_LEN, FACE_DIM), dtype=np.float32)
    mask = np.zeros(SEQ_LEN, dtype=np.float32)
    times = []
    last = None

    for i, (f, t) in enumerate(frames):
        times.append(t)
        if f is not None:
            emb = extract_face_embedding(f)
            if emb is not None:
                seq[i] = emb
                mask[i] = 1.0
                last = emb
            elif last is not None:
                seq[i] = last
                mask[i] = 1.0

    return seq, np.array(times), mask


def process_video(args: Tuple[Path, int, int, Optional[Path]]) -> Optional[Tuple]:
    """Extract face sequence and metadata for a single video or audio file.

    Runs in a worker process via ProcessPoolExecutor. For video files, extracts
    SEQ_LEN evenly-spaced frames and builds the face embedding sequence. For
    audio-only files, constructs a zero face sequence with consistent timestamps
    derived from load_audio so process_audio_batch slices the same 4-second window.

    Args:
        args: Tuple of (path, label, actor, audio_path) as produced by discover_files.

    Returns:
        Tuple of (face_seq, times, face_mask, label, actor, effective_audio_path, modality),
        or None on failure.
    """
    path, label, actor, audio_path = args
    modality = _infer_modality(path, audio_path)

    try:
        if path.suffix == ".mp4":
            frames = extract_frames_with_time(path)
            if not frames:
                return None
            face_seq, times, face_mask = build_face_sequence(frames)
        else:
            y_temp = load_audio(path)
            if y_temp is None:
                return None
            duration = len(y_temp) / SR
            times = np.linspace(0, duration * (1 - 1 / SEQ_LEN), SEQ_LEN)
            face_seq = np.zeros((SEQ_LEN, FACE_DIM), dtype=np.float32)
            face_mask = np.zeros(SEQ_LEN, dtype=np.float32)

        effective_audio_path = (
            audio_path
            if audio_path is not None
            else (path if path.suffix != ".mp4" else None)
        )

        return face_seq, times, face_mask, label, actor, effective_audio_path, modality

    except Exception as e:
        logger.warning(f"Processing failed {path}: {e}")
        return None


def process_audio_batch(face_results: list) -> list:
    """Batch-extract Wav2Vec2 audio embeddings for all videos in a chunk.

    Groups all audio windows across all videos into a single padded batch,
    runs one forward pass per AUDIO_BATCH_SIZE windows, then scatters results
    back into per-video sequence arrays. VIDEO_ONLY entries (audio_path=None)
    are skipped; their audio arrays and masks remain zero.

    Silence detection: windows with std < 1e-6 are skipped to avoid embedding
    noise from silent padding segments.

    Args:
        face_results: List of tuples as returned by process_video.

    Returns:
        List of (face_seq, audio_feats, label, face_mask, audio_mask, actor, modality).
    """
    all_chunks: List[np.ndarray] = []
    meta: List[Tuple[int, int]] = []

    for video_idx, (
        face_seq,
        times,
        face_mask,
        label,
        actor,
        audio_path,
        modality,
    ) in enumerate(face_results):
        if audio_path is None:
            continue

        y = load_audio(audio_path)
        if y is None:
            continue

        win = int(SR * AUDIO_WINDOW_SEC)
        added = 0
        for frame_idx, t in enumerate(times):
            if added >= SEQ_LEN:
                break
            try:
                c = int(t * SR)
                s = int(c - win // 2)
                e = int(c + win // 2)
                if s < 0:
                    s = 0
                    e = win
                if e > len(y):
                    e = len(y)
                    s = e - win
                s = max(0, s)
                if e - s < win // 4:
                    continue
                segment = y[s:e]
                if np.std(segment) < 1e-6:
                    continue
                all_chunks.append(segment.astype(np.float32))
                meta.append((video_idx, frame_idx))
                added += 1
            except Exception:
                continue

    n_videos = len(face_results)
    all_feats = np.zeros((n_videos, SEQ_LEN, AUDIO_DIM), dtype=np.float32)
    all_masks = np.zeros((n_videos, SEQ_LEN), dtype=np.float32)

    if all_chunks:
        all_out = []
        for i in range(0, len(all_chunks), AUDIO_BATCH_SIZE):
            batch_chunks = all_chunks[i : i + AUDIO_BATCH_SIZE]
            inputs = processor(
                batch_chunks, sampling_rate=SR, return_tensors="pt", padding=True
            )
            inputs = {k: v.to(TORCH_DEVICE) for k, v in inputs.items()}
            with torch.no_grad():
                out = wav2vec(**inputs).last_hidden_state.mean(dim=1).cpu().numpy()
            all_out.append(out)

        all_out = np.concatenate(all_out, axis=0)

        for i, (video_idx, frame_idx) in enumerate(meta):
            all_feats[video_idx, frame_idx] = all_out[i]
            all_masks[video_idx, frame_idx] = 1.0

    final = []
    for video_idx, (face_seq, times, face_mask, label, actor, _, modality) in enumerate(
        face_results
    ):
        final.append(
            (
                face_seq,
                all_feats[video_idx],
                label,
                face_mask,
                all_masks[video_idx],
                actor,
                modality,
            )
        )
    return final


def _log_modality_distribution(y: np.ndarray, mod: np.ndarray, split_name: str):
    """Log overall and per-emotion modality distribution to catch silent dataset bias."""
    mod_names = {
        MODALITY_AUDIO_ONLY: "audio_only",
        MODALITY_VIDEO_ONLY: "video_only",
        MODALITY_BOTH: "both",
    }
    overall = {mod_names[m]: int((mod == m).sum()) for m in [0, 1, 2]}
    logger.info(f"{split_name} modality distribution: {overall}")

    for m in [MODALITY_AUDIO_ONLY, MODALITY_VIDEO_ONLY, MODALITY_BOTH]:
        mask = mod == m
        if mask.sum() == 0:
            continue
        emotion_dist = dict(Counter(y[mask].tolist()))
        logger.info(f"  {mod_names[m]} emotion dist: {emotion_dist}")


def save_atomic(path: Path, compressed: bool = True, **arrays):
    """Save numpy arrays to an .npz file atomically via a temporary file.

    Writes to path.with_suffix('.tmp.npz') first, then renames to path.
    Ensures the output file is never left in a partially-written state on
    crash or KeyboardInterrupt. The temp file is deleted on failure.
    """
    tmp_path = path.with_suffix(".tmp.npz")
    try:
        if compressed:
            np.savez_compressed(tmp_path, **arrays)
        else:
            np.savez(tmp_path, **arrays)
        tmp_path.rename(path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise


def save_splits(train_actors, val_actors, test_actors):
    """Persist the actor-based train/val/test split to SPLITS_PATH as JSON."""
    splits = {
        "seed": SEED,
        "train_actors": sorted(train_actors),
        "val_actors": sorted(val_actors),
        "test_actors": sorted(test_actors),
    }
    SPLITS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(SPLITS_PATH, "w") as f:
        json.dump(splits, f, indent=2)
    logger.info(f"Splits saved to {SPLITS_PATH}")


def log_split_summary(name, y, act, mod):
    """Log label distribution, dataset source counts, and modality breakdown for a split."""
    label_dist = dict(Counter(y.tolist()))
    ravdess_mask = act < 1000
    cremad_mask = act >= 1000
    logger.info(
        f"{name}: n={len(y)} | labels={label_dist} | "
        f"RAVDESS={ravdess_mask.sum()} labels={dict(Counter(y[ravdess_mask].tolist()))} | "
        f"CREMA-D={cremad_mask.sum()} labels={dict(Counter(y[cremad_mask].tolist()))}"
    )
    _log_modality_distribution(y, mod, name)


def _compute_masked_norm_stats(
    X: np.ndarray, mask: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute per-feature mean and std over valid (unpadded) time steps only.

    Excludes padding positions indicated by mask=0 to prevent padding zeros
    from deflating the mean and compressing the std of real embeddings.

    Returns:
        Tuple of (mean, std) each with shape (1, 1, feature_dim), float32.
        Returns zero mean and unit std if no valid frames exist.
    """
    valid = mask.astype(bool)
    flat = X[valid]
    if flat.shape[0] == 0:
        mean = np.zeros((1, 1, X.shape[-1]), dtype=np.float32)
        std = np.ones((1, 1, X.shape[-1]), dtype=np.float32)
        return mean, std
    mean = flat.mean(axis=0, keepdims=True)[np.newaxis]
    std = flat.std(axis=0, keepdims=True)[np.newaxis] + 1e-6
    return mean.astype(np.float32), std.astype(np.float32)


def _apply_norm(
    X: np.ndarray, mask: np.ndarray, mean: np.ndarray, std: np.ndarray
) -> np.ndarray:
    """Z-score normalise X using pre-computed stats and zero out padded positions.

    Padding positions (mask=0) are set to 0.0 after normalisation so they
    remain distinguishable from real zero-valued features.
    """
    X_norm = (X - mean) / std
    X_norm[~mask.astype(bool)] = 0.0
    return X_norm


def main():
    """Run the full extraction pipeline end-to-end.

    Steps:
        1. Load Wav2Vec2 and MediaPipe models.
        2. Discover all RAVDESS and CREMA-D files.
        3. Extract face sequences in parallel (ProcessPoolExecutor).
        4. Batch-extract audio embeddings (GPU-accelerated Wav2Vec2).
        5. Save each chunk to chunks/chunk_NNN.npz (resumable).
        6. Concatenate all chunks and perform actor-stratified splits.
        7. Compute train-only normalisation stats and apply to all splits.
        8. Save final dataset.npz and norm_stats.npz; delete chunk directory.

    The chunks directory is preserved on failure to allow resuming from the
    last completed chunk on the next run.
    """
    pipeline_success = False
    try:
        load_models()

        os.makedirs(EXTRACT_DIR, exist_ok=True)
        os.makedirs(CHUNKS_DIR, exist_ok=True)

        files = discover_files(DATA_ROOT)
        if not files:
            raise RuntimeError(f"No files found in {DATA_ROOT}")

        logger.info(
            f"Found {len(files)} files | workers={NUM_WORKERS} | face_dim={FACE_DIM} | device={TORCH_DEVICE}"
        )

        total_chunks = (len(files) + CHUNK_SIZE - 1) // CHUNK_SIZE

        for chunk_idx in range(total_chunks):
            chunk_path = CHUNKS_DIR / f"chunk_{chunk_idx:03d}.npz"

            if chunk_path.exists():
                logger.info(f"chunk {chunk_idx} exists, skipping")
                continue

            batch = files[chunk_idx * CHUNK_SIZE : (chunk_idx + 1) * CHUNK_SIZE]
            face_results = []
            failed = 0

            with ProcessPoolExecutor(max_workers=NUM_WORKERS) as exe:
                futures = {exe.submit(process_video, item): item for item in batch}
                for future in tqdm(
                    as_completed(futures),
                    total=len(batch),
                    desc=f"chunk {chunk_idx} [face]",
                ):
                    r = future.result()
                    if r is not None:
                        face_results.append(r)
                    else:
                        failed += 1

            results = process_audio_batch(face_results)

            logger.info(
                f"chunk {chunk_idx}: succeeded={len(results)}, failed={failed + (len(face_results) - len(results))}"
            )

            if not results:
                continue

            Xf, Xa, y, fm, am, act, mod = zip(*results)

            save_atomic(
                chunk_path,
                X_face=np.stack(Xf),
                X_audio=np.stack(Xa),
                y=np.array(y),
                face_mask=np.stack(fm),
                audio_mask=np.stack(am),
                actors=np.array(act),
                modality=np.array(mod),
            )

        Xf, Xa, y, fm, am, act, mod = [], [], [], [], [], [], []

        for p in sorted(CHUNKS_DIR.glob("chunk_*.npz")):
            with np.load(p) as d:
                Xf.append(d["X_face"])
                Xa.append(d["X_audio"])
                y.append(d["y"])
                fm.append(d["face_mask"])
                am.append(d["audio_mask"])
                act.append(d["actors"])
                mod.append(d["modality"])

        Xf = np.concatenate(Xf)
        Xa = np.concatenate(Xa)
        y = np.concatenate(y)
        fm = np.concatenate(fm)
        am = np.concatenate(am)
        act = np.concatenate(act)
        mod = np.concatenate(mod)

        all_actors = sorted(map(int, np.unique(act)))
        ravdess_actors = [a for a in all_actors if a < 1000]
        cremad_actors = [a for a in all_actors if a >= 1000]

        rng = random.Random(SEED)
        rng.shuffle(ravdess_actors)
        rng.shuffle(cremad_actors)

        val_end = TRAIN_RATIO + VAL_RATIO

        def _split_actors(actors):
            n = len(actors)
            return (
                actors[: int(TRAIN_RATIO * n)],
                actors[int(TRAIN_RATIO * n) : int(val_end * n)],
                actors[int(val_end * n) :],
            )

        r_tr, r_va, r_te = _split_actors(ravdess_actors)
        c_tr, c_va, c_te = _split_actors(cremad_actors)

        train_actors = r_tr + c_tr
        val_actors = r_va + c_va
        test_actors = r_te + c_te

        save_splits(train_actors, val_actors, test_actors)

        def split(a_list):
            a_set = set(a_list)
            idx = [i for i, a in enumerate(act) if int(a) in a_set]
            return Xf[idx], Xa[idx], fm[idx], am[idx], y[idx], act[idx], mod[idx]

        Xf_tr, Xa_tr, fm_tr, am_tr, y_tr, a_tr, mod_tr = split(train_actors)
        Xf_va, Xa_va, fm_va, am_va, y_va, a_va, mod_va = split(val_actors)
        Xf_te, Xa_te, fm_te, am_te, y_te, a_te, mod_te = split(test_actors)

        log_split_summary("train", y_tr, a_tr, mod_tr)
        log_split_summary("val", y_va, a_va, mod_va)
        log_split_summary("test", y_te, a_te, mod_te)

        Xa_mean, Xa_std = _compute_masked_norm_stats(Xa_tr, am_tr)
        Xf_mean, Xf_std = _compute_masked_norm_stats(Xf_tr, fm_tr)

        Xa_tr = _apply_norm(Xa_tr, am_tr, Xa_mean, Xa_std)
        Xa_va = _apply_norm(Xa_va, am_va, Xa_mean, Xa_std)
        Xa_te = _apply_norm(Xa_te, am_te, Xa_mean, Xa_std)

        Xf_tr = _apply_norm(Xf_tr, fm_tr, Xf_mean, Xf_std)
        Xf_va = _apply_norm(Xf_va, fm_va, Xf_mean, Xf_std)
        Xf_te = _apply_norm(Xf_te, fm_te, Xf_mean, Xf_std)

        norm_path = Path(EXTRACT_DIR) / "norm_stats.npz"
        np.savez_compressed(
            norm_path,
            Xa_mean=Xa_mean,
            Xa_std=Xa_std,
            Xf_mean=Xf_mean,
            Xf_std=Xf_std,
        )
        logger.info(f"Norm stats saved to {norm_path}")

        save_atomic(
            OUT_PATH,
            compressed=False,
            X_face_train=Xf_tr,
            X_audio_train=Xa_tr,
            face_mask_train=fm_tr,
            audio_mask_train=am_tr,
            y_train=y_tr,
            actor_train=a_tr,
            modality_train=mod_tr,
            X_face_val=Xf_va,
            X_audio_val=Xa_va,
            face_mask_val=fm_va,
            audio_mask_val=am_va,
            y_val=y_va,
            actor_val=a_va,
            modality_val=mod_va,
            X_face_test=Xf_te,
            X_audio_test=Xa_te,
            face_mask_test=fm_te,
            audio_mask_test=am_te,
            y_test=y_te,
            actor_test=a_te,
            modality_test=mod_te,
        )

        pipeline_success = True
        shutil.rmtree(CHUNKS_DIR)

        logger.info("FULL PIPELINE COMPLETE")

    except Exception as e:
        logger.exception(f"FATAL: {e}")
        raise

    finally:
        if not pipeline_success and CHUNKS_DIR.exists():
            logger.warning(
                "Pipeline did not complete — chunks dir preserved for resume"
            )


if __name__ == "__main__":
    main()
