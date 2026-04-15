import asyncio
import base64
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
# from fastapi.middleware.cors import CORSMiddleware

import embeddings.extract_embeddings_data as _emo_mod
from embeddings.extract_embeddings_data import load_models
from inference.predict import EmotionPredictor


SEQ_LEN = 8
AUDIO_DIM = 1024
SMOOTHING_ALPHA = 0.7
CONFIDENCE_THRESHOLD = 0.5
EMOTION_HISTORY_TTL = 1.0
BUFFER_TTL = 60
MAX_FRAME_SIZE = 2 * 1024 * 1024
FACE_DIM = 27


MIN_INFERENCE_INTERVAL = 0.35

FRAME_SKIP = 7

DEVICE = (
    "mps"
    if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available() else "cpu"
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("emotion_socket")

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=["https://skymeetai.onrender.com"],
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


EMBEDDING_BUFFER: dict[str, deque] = defaultdict(lambda: deque(maxlen=SEQ_LEN))
HTTP_EMBEDDING_BUFFER: dict[str, deque] = defaultdict(lambda: deque(maxlen=SEQ_LEN))

EMOTION_HISTORY: dict = {}
EMOTION_HISTORY_LAST_RESET: dict = {}
LAST_SEEN: dict = {}
CONNECTED: set = set()
LAST_INFERENCE_TIME: dict = {}
PARTICIPANT_ID_MAP: dict = {}

LATEST_FRAME: dict[str, bytes] = {}
PUMP_RUNNING: set = set()


def to_bytes(data) -> bytes:
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if isinstance(data, str):
        try:
            return base64.b64decode(data)
        except Exception:
            return data.encode("latin-1")
    if isinstance(data, list):
        return bytes(data)
    raise TypeError(f"Cannot convert {type(data)} to bytes")


def decode_frame(data) -> np.ndarray | None:
    raw = to_bytes(data)
    arr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def smooth(key: str, probs: dict) -> dict:
    now = time.time()


    last_reset = EMOTION_HISTORY_LAST_RESET.get(key, 0)
    if now - last_reset > EMOTION_HISTORY_TTL:
        EMOTION_HISTORY.pop(key, None)
        EMOTION_HISTORY_LAST_RESET[key] = now
        logger.info("emotion history reset key=%s", key)


    raw_top = max(probs, key=probs.get)
    logger.info(
        "raw_probs key=%s top=%s(%.3f) all=%s",
        key,
        raw_top,
        probs[raw_top],
        {k: f"{v:.3f}" for k, v in sorted(probs.items(), key=lambda x: -x[1])},
    )

    prev = EMOTION_HISTORY.get(key, probs)
    sm = {
        k: SMOOTHING_ALPHA * probs[k] + (1 - SMOOTHING_ALPHA) * prev.get(k, 0)
        for k in probs
    }
    total = sum(sm.values()) + 1e-6
    sm = {k: v / total for k, v in sm.items()}
    EMOTION_HISTORY[key] = sm
    return sm


def extract_embedding(frame_bgr: np.ndarray) -> np.ndarray | None:
    """
    Extract AU/emotion/pose embedding from a BGR frame.
    py-feat's detect_image only accepts file paths — write to a tempfile,
    detect, then delete immediately. BytesIO is not supported by the library.
    """
    import os
    import tempfile

    tmp_path = None
    try:
        t0 = time.perf_counter()

        ok, buf = cv2.imencode(".jpg", frame_bgr)
        if not ok:
            logger.warning("cv2.imencode failed")
            return None

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(buf.tobytes())

        results = _emo_mod.face_detector.detect_image([tmp_path])
        logger.info("latency face_detect=%.3fs", time.perf_counter() - t0)

        if results.aus is None or len(results.aus) == 0:
            return None
        if results.emotions is None or len(results.emotions) == 0:
            return None

        aus = results.aus.values[0][:17].astype(np.float32)
        emotions = results.emotions.values[0][:7].astype(np.float32)

        pose = np.zeros(3, dtype=np.float32)
        try:
            if results.poses is not None and hasattr(results.poses, "values"):
                pose_vals = results.poses.values
                if pose_vals.shape[0] > 0 and pose_vals.shape[1] >= 3:
                    pose = pose_vals[0][:3].astype(np.float32)
        except Exception as e:
            logger.warning("pose extraction failed, using zeros: %s", e)

        emb = np.concatenate([aus, emotions, pose])
        if emb.shape[0] != FACE_DIM:
            logger.warning(
                "unexpected embedding dim=%d expected=%d", emb.shape[0], FACE_DIM
            )
            return None
        return emb

    except Exception:
        logger.exception("extract_embedding failed")
        return None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def run_inference(embedding_deque: deque) -> dict:
    t0 = time.perf_counter()
    frames = list(embedding_deque)
    n_real = len(frames)


    while len(frames) < SEQ_LEN:
        frames.insert(0, frames[0])

    xf = np.stack(frames, axis=0)  # (SEQ_LEN, FACE_DIM)
    xa = np.zeros((SEQ_LEN, AUDIO_DIM), dtype=np.float32)

    fm = np.zeros(SEQ_LEN, dtype=np.float32)
    fm[-n_real:] = 1.0

    am = np.zeros(SEQ_LEN, dtype=np.float32)

    result = predictor.predict(xf, xa, fm, am)
    logger.info("latency inference=%.3fs", time.perf_counter() - t0)
    return result


def cleanup():
    now = time.time()
    stale = [k for k, t in LAST_SEEN.items() if now - t > BUFFER_TTL]
    with _lock:
        for k in stale:
            EMBEDDING_BUFFER.pop(k, None)
            HTTP_EMBEDDING_BUFFER.pop(k, None)
            EMOTION_HISTORY.pop(k, None)
            EMOTION_HISTORY_LAST_RESET.pop(k, None)
            LAST_SEEN.pop(k, None)
            LAST_INFERENCE_TIME.pop(k, None)
            PUMP_RUNNING.discard(k)
            LATEST_FRAME.pop(k, None)
            PARTICIPANT_ID_MAP.pop(k, None)


scheduler = AsyncIOScheduler()
_scheduler_started = False
_scheduler_lock = None


async def _pump(sid: str, participant_id: str):
    """
    Background task per connected user.

    Design:
    - Pops the latest frame slot each iteration (never queues).
    - FRAME_SKIP applied here (after rate-limit sleep) so we always skip
      toward the *freshest* available frame, not the one that arrived first.
    - Reconnect guard: exits immediately if sid leaves CONNECTED.
    - Small yield sleep when loop is busy to avoid starving the event loop.
    """
    loop = asyncio.get_running_loop()
    skip_counter = 0

    try:
        while True:

            if sid not in CONNECTED:
                logger.info("pump exit: sid=%s no longer connected", sid)
                return


            frame_bytes = LATEST_FRAME.pop(sid, None)
            if frame_bytes is None:

                return

            now = time.time()
            LAST_SEEN[sid] = now
            frame_received_at = time.perf_counter()


            elapsed = now - LAST_INFERENCE_TIME.get(sid, 0)
            if elapsed < MIN_INFERENCE_INTERVAL:
                sleep_for = MIN_INFERENCE_INTERVAL - elapsed
                await asyncio.sleep(sleep_for)

                if sid not in CONNECTED:
                    logger.info("pump exit after sleep: sid=%s disconnected", sid)
                    return
                # Grab the freshest frame that arrived during the sleep
                frame_bytes = LATEST_FRAME.pop(sid, frame_bytes)


            skip_counter += 1
            if skip_counter % FRAME_SKIP != 1:
                await asyncio.sleep(0.001)
                continue

            LAST_INFERENCE_TIME[sid] = time.time()


            t0 = time.perf_counter()
            frame = await loop.run_in_executor(face_executor, decode_frame, frame_bytes)
            logger.info("latency decode=%.3fs sid=%s", time.perf_counter() - t0, sid)

            if frame is None:
                logger.warning("frame decode returned None sid=%s", sid)
                await asyncio.sleep(0.005)
                continue


            if sid not in CONNECTED:
                logger.info("pump exit post-decode: sid=%s disconnected", sid)
                return


            t0 = time.perf_counter()
            try:
                embedding = await loop.run_in_executor(
                    face_executor, extract_embedding, frame
                )
            except Exception:
                logger.exception("extraction executor error sid=%s", sid)
                await asyncio.sleep(0.005)
                continue
            logger.info("latency extract=%.3fs sid=%s", time.perf_counter() - t0, sid)

            if embedding is None:
                logger.info("no face detected sid=%s", sid)
                await asyncio.sleep(0.005)
                continue


            buf = EMBEDDING_BUFFER[sid]
            buf.append(embedding)

            buf_snapshot = deque(buf, maxlen=SEQ_LEN)


            if sid not in CONNECTED:
                logger.info("pump exit post-extract: sid=%s disconnected", sid)
                return


            t0 = time.perf_counter()
            try:
                pred = await loop.run_in_executor(
                    inference_executor, run_inference, buf_snapshot
                )
            except Exception:
                logger.exception("inference executor error sid=%s", sid)
                await asyncio.sleep(0.005)
                continue
            logger.info(
                "latency infer_total=%.3fs sid=%s", time.perf_counter() - t0, sid
            )

            if not pred:
                logger.warning("empty pred returned sid=%s", sid)
                await asyncio.sleep(0.005)
                continue


            try:
                if pred.get("probs"):
                    smoothed = smooth(sid, pred["probs"])
                    raw_label = max(smoothed, key=smoothed.get)
                    score = float(smoothed[raw_label])

                    if score < CONFIDENCE_THRESHOLD:
                        logger.info(
                            "low confidence=%.3f raw=%s → neutral sid=%s",
                            score,
                            raw_label,
                            sid,
                        )
                        label = "neutral"
                    else:
                        label = raw_label
                else:
                    raw_label = pred.get("emotion") or "neutral"
                    raw_conf = pred.get("confidence")
                    score = float(raw_conf) if raw_conf is not None else 0.0
                    label = "neutral" if score < CONFIDENCE_THRESHOLD else raw_label
            except Exception:
                logger.exception("result parsing error sid=%s pred=%s", sid, pred)
                await asyncio.sleep(0.005)
                continue

            total_latency = time.perf_counter() - frame_received_at
            logger.info(
                "infer sid=%s pid=%s emotion=%s conf=%.3f buf=%d latency_total=%.3fs",
                sid,
                participant_id,
                label,
                score,
                len(buf),
                total_latency,
            )


            if sid not in CONNECTED:
                logger.info("pump exit pre-emit: sid=%s disconnected", sid)
                return

            await sio.emit(
                "emotion.result",
                {
                    "participantId": participant_id,
                    "result": {"emotion": label, "confidence": score},
                    "ts": int(time.time() * 1000),
                },
                to=sid,
            )


            await asyncio.sleep(0.005)

    finally:
        PUMP_RUNNING.discard(sid)


def _store_frame(sid: str, frame_bytes: bytes) -> None:

    """Overwrite the latest frame slot. No skip logic here — pump handles it."""

    LATEST_FRAME[sid] = frame_bytes


async def _process_frame(sid: str, frame_bytes: bytes, participant_id: str):
    if not frame_bytes or len(frame_bytes) > MAX_FRAME_SIZE:
        logger.warning(
            "invalid frame size sid=%s size=%d",
            sid,
            len(frame_bytes) if frame_bytes else 0,
        )
        return


    _store_frame(sid, frame_bytes)


    if sid in PUMP_RUNNING:
        return

    PUMP_RUNNING.add(sid)
    asyncio.create_task(_pump(sid, participant_id))


def _parse_frame_payload(sid, data):
    frame_bytes = None
    participant_id = PARTICIPANT_ID_MAP.get(sid, sid)

    if isinstance(data, (bytes, bytearray, list)):
        try:
            frame_bytes = to_bytes(data)
        except Exception:
            logger.warning("raw bytes conversion failed sid=%s", sid)
            return None, participant_id

    elif isinstance(data, dict):
        pid = data.get("participantId") or data.get("participant_id")
        if pid:
            participant_id = pid
            if sid not in PARTICIPANT_ID_MAP:
                PARTICIPANT_ID_MAP[sid] = pid

        raw_buf = data.get("buffer") or data.get("data")
        if raw_buf is None:
            logger.warning("dict payload missing buffer/data key sid=%s", sid)
            return None, participant_id
        try:
            frame_bytes = to_bytes(raw_buf)
        except Exception:
            logger.warning("dict buffer conversion failed sid=%s", sid)
            return None, participant_id

    else:
        logger.warning("unexpected data type sid=%s type=%s", sid, type(data).__name__)
        return None, participant_id

    return frame_bytes, participant_id


@sio.event
async def connect(sid, environ, auth):
    global _scheduler_started, _scheduler_lock
    CONNECTED.add(sid)
    if auth:
        pid = auth.get("participant_id") or auth.get("participantId")
        if pid:
            PARTICIPANT_ID_MAP[sid] = pid
    logger.info(
        "connect sid=%s pid=%s total=%d",
        sid,
        PARTICIPANT_ID_MAP.get(sid),
        len(CONNECTED),
    )

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
    EMBEDDING_BUFFER.pop(sid, None)
    LAST_INFERENCE_TIME.pop(sid, None)
    PUMP_RUNNING.discard(sid)
    LATEST_FRAME.pop(sid, None)
    PARTICIPANT_ID_MAP.pop(sid, None)
    logger.info("disconnect sid=%s", sid)


@sio.on("frame")
async def on_frame(sid, data):
    if sid not in CONNECTED:
        return
    logger.info("frame received sid=%s type=%s", sid, type(data).__name__)
    frame_bytes, participant_id = _parse_frame_payload(sid, data)
    if frame_bytes:
        await _process_frame(sid, frame_bytes, participant_id)


@sio.on("emotion.frame")
async def on_emotion_frame(sid, data):
    if sid not in CONNECTED:
        return
    logger.info("emotion.frame received sid=%s type=%s", sid, type(data).__name__)
    frame_bytes, participant_id = _parse_frame_payload(sid, data)
    if frame_bytes:
        await _process_frame(sid, frame_bytes, participant_id)


app = FastAPI()

app.mount("/socket.io", socketio.ASGIApp(sio))


@app.post("/analyze")
async def analyze(
    meeting_id: str = Form(...),
    participant_id: str = Form(...),
    type: str = Form(...),
    file: UploadFile = File(...),
):
    request_received_at = time.perf_counter()
    key = f"{meeting_id}::{participant_id}"
    try:
        contents = await file.read()
        if not contents:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        t_decode = time.perf_counter()
        frame = decode_frame(contents)
        logger.info(
            "latency http_decode=%.3fs key=%s", time.perf_counter() - t_decode, key
        )

        if frame is None:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        loop = asyncio.get_running_loop()

        t_extract = time.perf_counter()
        embedding = await loop.run_in_executor(face_executor, extract_embedding, frame)
        logger.info(
            "latency http_extract=%.3fs key=%s", time.perf_counter() - t_extract, key
        )

        if embedding is None:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        http_buf = HTTP_EMBEDDING_BUFFER[key]
        http_buf.append(embedding)

        buf_snapshot = deque(http_buf, maxlen=SEQ_LEN)

        t_infer = time.perf_counter()
        pred = await loop.run_in_executor(
            inference_executor, run_inference, buf_snapshot
        )
        logger.info(
            "latency http_infer=%.3fs key=%s", time.perf_counter() - t_infer, key
        )

        if not pred:
            return {"result": {"emotion": "neutral", "confidence": 0}}

        if pred.get("probs"):
            smoothed = smooth(key, pred["probs"])
            raw_label = max(smoothed, key=smoothed.get)
            score = float(smoothed[raw_label])
            label = "neutral" if score < CONFIDENCE_THRESHOLD else raw_label
        else:
            raw_label = pred.get("emotion") or "neutral"
            raw_conf = pred.get("confidence")
            score = float(raw_conf) if raw_conf is not None else 0.0
            label = "neutral" if score < CONFIDENCE_THRESHOLD else raw_label

        total_latency = time.perf_counter() - request_received_at
        logger.info(
            "http_analyze key=%s emotion=%s conf=%.3f latency_total=%.3fs",
            key,
            label,
            score,
            total_latency,
        )

        return {
            "meeting_id": meeting_id,
            "participant_id": participant_id,
            "latencyMs": round(total_latency * 1000, 2),
            "result": {
                "emotion": label,
                "confidence": score,
                "probs": pred.get("probs", {}),
            },
        }

    except Exception:
        logger.exception("HTTP analyze error key=%s", key)
        return {"result": {"emotion": "neutral", "confidence": 0, "probs": {}}}
