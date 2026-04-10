import asyncio
import logging
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import socketio
import torch
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware

from embeddings.extract_embeddings_data import build_face_sequence, load_models
from inference.predict import EmotionPredictor

SEQ_LEN = 8
FACE_DIM = 27
AUDIO_DIM = 1024
WINDOW_SIZE = 5
SMOOTHING_ALPHA = 0.6
BUFFER_TTL = 60
FRAME_HISTORY = 8
MAX_FRAME_SIZE = 2 * 1024 * 1024
FPS_LIMIT = 30

DEVICE = (
    "mps"
    if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available() else "cpu"
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("emotion_socket")

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_timeout=20,
    ping_interval=10,
)

face_executor = ThreadPoolExecutor(max_workers=2)
inference_executor = ThreadPoolExecutor(max_workers=1)

logger.info("Loading models...")
load_models()
predictor = EmotionPredictor()
logger.info("Models ready")

_lock = threading.Lock()

FRAME_BUFFER = defaultdict(lambda: deque(maxlen=FRAME_HISTORY))
HTTP_FRAME_BUFFER = defaultdict(lambda: deque(maxlen=SEQ_LEN))

EMOTION_HISTORY = {}
LAST_SEEN = {}
CONNECTED = set()
INFERENCE_RUNNING = set()
LAST_INFERENCE_TIME = {}

MIN_INFERENCE_INTERVAL = 2.0

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

def fast_face(frames):
    face_seq, _, face_mask = build_face_sequence(frames)
    if face_seq is None:
        return None
    audio_seq = np.zeros((SEQ_LEN, AUDIO_DIM), dtype=np.float32)
    audio_mask = np.zeros(SEQ_LEN, dtype=np.float32)
    return face_seq, audio_seq, face_mask, audio_mask

def cleanup():
    now = time.time()
    stale = [k for k, t in LAST_SEEN.items() if now - t > BUFFER_TTL]
    with _lock:
        for k in stale:
            FRAME_BUFFER.pop(k, None)
            HTTP_FRAME_BUFFER.pop(k, None)
            EMOTION_HISTORY.pop(k, None)
            LAST_SEEN.pop(k, None)
            LAST_INFERENCE_TIME.pop(k, None)
            INFERENCE_RUNNING.discard(k)

scheduler = AsyncIOScheduler()
_scheduler_started = False
_scheduler_lock = None

@sio.event
async def connect(sid, environ, auth):
    global _scheduler_started, _scheduler_lock
    CONNECTED.add(sid)
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
    FRAME_BUFFER.pop(sid, None)
    LAST_INFERENCE_TIME.pop(sid, None)
    INFERENCE_RUNNING.discard(sid)

@sio.on("frame")
async def on_frame(sid, data):
    if sid not in CONNECTED:
        return
    try:
        frame_bytes = data.get("frame")
        if frame_bytes is None:
            return

        now = time.time()
        last = LAST_INFERENCE_TIME.get(sid, 0)
        if now - last < MIN_INFERENCE_INTERVAL:
            return

        if sid in INFERENCE_RUNNING:
            return

        loop = asyncio.get_running_loop()
        frame = await loop.run_in_executor(face_executor, decode_frame, frame_bytes)
        if frame is None:
            return

        FRAME_BUFFER[sid].append((frame, time.time()))

        if len(FRAME_BUFFER[sid]) < SEQ_LEN:
            return

        frames = list(FRAME_BUFFER[sid])

        INFERENCE_RUNNING.add(sid)
        LAST_INFERENCE_TIME[sid] = now

        fast = await loop.run_in_executor(face_executor, fast_face, frames)
        if fast is None:
            INFERENCE_RUNNING.discard(sid)
            return

        xf, xa, fm, am = fast

        pred = await loop.run_in_executor(
            inference_executor, predictor.predict, xf, xa, fm, am
        )

        INFERENCE_RUNNING.discard(sid)

        if pred.get("probs"):
            label = max(pred["probs"], key=pred["probs"].get)
            score = float(pred["probs"][label])
        else:
            label = pred.get("emotion", "neutral")
            score = float(pred.get("confidence", 0))

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
        INFERENCE_RUNNING.discard(sid)
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

@app.post("/analyze")
async def analyze(
    meeting_id: str = Form(...),
    participant_id: str = Form(...),
    type: str = Form(...),
    file: UploadFile = File(...),
):
    try:
        key = f"{meeting_id}::{participant_id}"

        contents = await file.read()
        if not contents:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        frame = decode_frame(contents)
        if frame is None:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        HTTP_FRAME_BUFFER[key].append((frame, time.time()))

        if len(HTTP_FRAME_BUFFER[key]) < SEQ_LEN:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        frames = list(HTTP_FRAME_BUFFER[key])

        loop = asyncio.get_running_loop()

        fast = await loop.run_in_executor(face_executor, fast_face, frames)
        if fast is None:
            return {"result": {"emotion": "neutral", "confidence": 0}}

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