import asyncio
import logging
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import cv2
import numpy as np
import socketio
import torch
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware

from embeddings.extract_embeddings_data import build_face_sequence, load_models
from inference.predict import EmotionPredictor

# CONFIG
SEQ_LEN = 8
FACE_DIM = 27
AUDIO_DIM = 1024
WINDOW_SIZE = 5
SMOOTHING_ALPHA = 0.6
BUFFER_TTL = 60
FRAME_HISTORY = 3
MAX_FRAME_SIZE = 2 * 1024 * 1024
FPS_LIMIT = 30

DEVICE = (
    "mps"
    if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available() else "cpu"
)

# LOGGING
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("emotion_socket")

# SOCKET
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_timeout=20,
    ping_interval=10,
)

# EXECUTORS
face_executor = ThreadPoolExecutor(max_workers=2)
inference_executor = ThreadPoolExecutor(max_workers=1)

logger.info("Loading models...")
load_models()
predictor = EmotionPredictor()
logger.info("Models ready")

_lock = threading.Lock()

STREAM_BUFFER = defaultdict(
    lambda: {
        "xf": deque(maxlen=SEQ_LEN),
        "xa": deque(maxlen=SEQ_LEN),
        "fm": deque(maxlen=SEQ_LEN),
        "am": deque(maxlen=SEQ_LEN),
    }
)

FRAME_BUFFER = defaultdict(lambda: deque(maxlen=FRAME_HISTORY))
HTTP_FRAME_BUFFER = defaultdict(lambda: deque(maxlen=SEQ_LEN))
WINDOW_BUFFER = defaultdict(lambda: deque(maxlen=WINDOW_SIZE))

EMOTION_HISTORY = {}
LAST_SEEN = {}
LAST_FRAME_TIME = {}
CONNECTED = set()

# METRICS
_metrics = {
    "requests": 0,
    "anomalies": 0,
    "errors": 0,
    "avg_latency": 0,
    "count": 0,
}
_metrics_lock = threading.Lock()


def record_latency(ms):
    with _metrics_lock:
        n = _metrics["count"]
        _metrics["avg_latency"] = (_metrics["avg_latency"] * n + ms) / (n + 1)
        _metrics["count"] += 1
        _metrics["requests"] += 1


# HELPERS
def decode_frame(data):
    arr = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def smooth(key, probs):
    prev = EMOTION_HISTORY.get(key, probs)

    sm = {
        k: SMOOTHING_ALPHA * probs[k] + (1 - SMOOTHING_ALPHA) * prev.get(k, 0)
        for k in probs
    }

    total = sum(sm.values()) + 1e-6
    sm = {k: v / total for k, v in sm.items()}
    EMOTION_HISTORY[key] = sm
    return sm


def update_buffer(key, xf, xa, fm, am):
    with _lock:
        buf = STREAM_BUFFER[key]
        buf["xf"].extend(xf)
        buf["xa"].extend(xa)
        buf["fm"].extend(fm)
        buf["am"].extend(am)

        if len(buf["xf"]) < SEQ_LEN:
            return None

        return (
            np.array(buf["xf"], dtype=np.float32),
            np.array(buf["xa"], dtype=np.float32),
            np.array(buf["fm"], dtype=np.float32),
            np.array(buf["am"], dtype=np.float32),
        )


# FAST FACE
def fast_face(frames):
    """
    frames: list of (np.ndarray, float) tuples — (frame, timestamp)
    build_face_sequence expects exactly this format.
    """
    logger.info(f"fast_face received {len(frames)} frames")

    face_seq, _, face_mask = build_face_sequence(frames)

    if face_seq is None:
        logger.error("build_face_sequence returned None (NO FACE)")
        return None

    logger.info(f"face_seq shape: {face_seq.shape}")

    pad = SEQ_LEN - face_seq.shape[0]
    if pad > 0:
        logger.warning(f"padding applied: {pad}")
        face_seq = np.vstack([face_seq, np.zeros((pad, FACE_DIM), dtype=np.float32)])
        face_mask = np.concatenate([face_mask, np.zeros(pad, dtype=np.float32)])

    audio_seq = np.zeros((SEQ_LEN, AUDIO_DIM), dtype=np.float32)
    audio_mask = np.zeros(SEQ_LEN, dtype=np.float32)

    return face_seq, audio_seq, face_mask, audio_mask


# CLEANUP
def cleanup():
    now = time.time()
    stale = [k for k, t in LAST_SEEN.items() if now - t > BUFFER_TTL]

    with _lock:
        for k in stale:
            STREAM_BUFFER.pop(k, None)
            FRAME_BUFFER.pop(k, None)
            WINDOW_BUFFER.pop(k, None)
            HTTP_FRAME_BUFFER.pop(k, None)
            EMOTION_HISTORY.pop(k, None)
            LAST_SEEN.pop(k, None)
            LAST_FRAME_TIME.pop(k, None)


# SCHEDULER
scheduler = AsyncIOScheduler()
_scheduler_started = False
_scheduler_lock = None


# SOCKET EVENTS
@sio.event
async def connect(sid, environ, auth):
    global _scheduler_started, _scheduler_lock

    CONNECTED.add(sid)

    logger.info(f"🔌 CONNECTED: {sid}")

    if _scheduler_lock is None:
        _scheduler_lock = asyncio.Lock()

    async with _scheduler_lock:
        if not _scheduler_started:
            scheduler.add_job(cleanup, "interval", seconds=30)
            scheduler.start()
            _scheduler_started = True


@sio.event
async def disconnect(sid):
    CONNECTED.discard(sid)
    logger.info(f"DISCONNECTED: {sid}")



@sio.on("frame")
async def on_frame(sid, data):
    if sid not in CONNECTED:
        return

    try:
        frame_bytes = data.get("frame")
        if frame_bytes is None:
            return

        loop = asyncio.get_running_loop()

        frame = await loop.run_in_executor(face_executor, decode_frame, frame_bytes)
        if frame is None:
            return



        FRAME_BUFFER[sid].append((frame, time.time()))
        frames = list(FRAME_BUFFER[sid])  # list of (np.ndarray, float)

        fast = await loop.run_in_executor(face_executor, fast_face, frames)
        if fast is None:
            return

        xf, xa, fm, am = fast

        pred = await loop.run_in_executor(
            inference_executor, predictor.predict, xf, xa, fm, am
        )

        if pred.get("probs"):
            label = max(pred["probs"], key=pred["probs"].get)
            score = float(pred["probs"][label])
        else:
            label = pred.get("emotion", "neutral")
            score = float(pred.get("confidence", 0))

        logger.info(f"🎯 SOCKET RESULT → {label} ({score:.3f})")

        await sio.emit(
            "emotion.result",
            {
                "result": {
                    "emotion": label,
                    "confidence": score,
                },
            },
            to=sid,
        )

    except Exception:
        logger.exception("socket error")


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/socket.io", socketio.ASGIApp(sio))


# HTTP ANALYZE
@app.post("/analyze")
async def analyze(
    meeting_id: str = Form(...),
    participant_id: str = Form(...),
    type: str = Form(...),
    file: UploadFile = File(...),
):
    try:
        key = f"{meeting_id}::{participant_id}"

        logger.info(f"\n ANALYZE → {key}")

        contents = await file.read()
        if not contents:
            logger.error("Empty frame")
            return {"result": {"emotion": "neutral", "confidence": 0}}

        frame = decode_frame(contents)
        if frame is None:
            logger.error("Decode failed")
            return {"result": {"emotion": "neutral", "confidence": 0}}


        HTTP_FRAME_BUFFER[key].append((frame, time.time()))

        size = len(HTTP_FRAME_BUFFER[key])
        logger.info(f" BUFFER → {size}/{SEQ_LEN}")

        if size < SEQ_LEN:
            logger.info(" WARMING UP")
            return {"result": {"emotion": "neutral", "confidence": 0}}


        frames = list(HTTP_FRAME_BUFFER[key])

        loop = asyncio.get_running_loop()

        fast = await loop.run_in_executor(face_executor, fast_face, frames)

        if fast is None:
            logger.error("NO FACE DETECTED")
            return {"result": {"emotion": "neutral", "confidence": 0}}

        xf, xa, fm, am = fast

        logger.info(" RUNNING MODEL")

        pred = await loop.run_in_executor(
            inference_executor, predictor.predict, xf, xa, fm, am
        )

        logger.info(f" RAW: {pred}")

        if pred.get("probs"):
            label = max(pred["probs"], key=pred["probs"].get)
            score = float(pred["probs"][label])
        else:
            label = pred.get("emotion", "neutral")
            score = float(pred.get("confidence", 0))

        logger.info(f" RESULT → {label} ({score:.3f})")

        return {
            "meeting_id": meeting_id,
            "participant_id": participant_id,
            "result": {
                "emotion": label,
                "confidence": score,
                "probs": pred.get("probs", {}),
            },
        }

    except Exception:
        logger.exception("HTTP analyze error")
        return {
            "result": {
                "emotion": "neutral",
                "confidence": 0,
                "probs": {},
            }
        }
