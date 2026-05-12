"""Locust load-test script for the emotion inference WebSocket server."""

import os
import time
import uuid
import random
import logging
import threading
from pathlib import Path

import socketio
from locust import User, task, between, events

logging.basicConfig(level=logging.INFO)

SERVER_URL = os.getenv("EMOTION_SERVER_URL", "http://localhost:5002")

FAKE_AUDIO = b"\x00" * 6400

BASE_DIR = Path(__file__).resolve().parent
IMAGE_PATHS = list((BASE_DIR / "src").glob("*.jpg"))

if not IMAGE_PATHS:
    raise RuntimeError("No .jpg images found inside load_testing/src/ folder")

FRAMES = []

for path in IMAGE_PATHS:
    with open(path, "rb") as f:
        FRAMES.append(f.read())

print(f"[LOCUST] Loaded {len(FRAMES)} images")


def report_success(name: str, response_time: float, size: int):
    """Fire a successful Locust request event.

    Args:
        name: Event label shown in the Locust UI.
        response_time: Elapsed time in milliseconds.
        size: Response payload size in bytes.
    """
    events.request.fire(
        request_type="WS",
        name=name,
        response_time=response_time,
        response_length=size,
        exception=None,
    )


def report_failure(name: str, exc: Exception):
    """Fire a failed Locust request event.

    Args:
        name: Event label shown in the Locust UI.
        exc: Exception that caused the failure.
    """
    events.request.fire(
        request_type="WS",
        name=name,
        response_time=0,
        response_length=0,
        exception=exc,
    )


class EmotionUser(User):
    """Simulated WebSocket user that sends audio chunks, video frames, and media-state toggles."""

    wait_time = between(0.05, 0.25)

    def on_start(self):
        """Connect to the server and register Socket.IO event handlers."""
        self.pid = str(uuid.uuid4())

        self.pending_requests = {}
        self.pending_lock = threading.Lock()

        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=10,
            reconnection_delay=1,
            logger=False,
            engineio_logger=False,
        )

        self.connected = False
        self.mic_enabled = True
        self.camera_enabled = True

        @self.sio.event
        def connect():
            self.connected = True

        @self.sio.event
        def disconnect():
            self.connected = False

        @self.sio.on("emotion.result")
        def on_result(payload):
            request_id = payload.get("requestId")

            if not request_id:
                return

            with self.pending_lock:
                start = self.pending_requests.pop(request_id, None)

            if start is None:
                return

            latency_ms = (time.time() - start) * 1000

            report_success(
                "emotion_inference",
                latency_ms,
                0,
            )

        self.sio.connect(
            SERVER_URL,
            auth={"participantId": self.pid},
            socketio_path="socket.io",
            transports=["websocket"],
        )

    def on_stop(self):
        """Disconnect from the server."""
        try:
            self.sio.disconnect()
        except Exception:
            pass

    @task(5)
    def send_audio(self):
        """Emit a fake audio chunk with a tracked request ID."""
        if not self.connected:
            return

        if not self.mic_enabled:
            return

        try:

            request_id = str(uuid.uuid4())

            with self.pending_lock:
                self.pending_requests[request_id] = time.time()

            self.sio.emit(
                "audio_chunk",
                {
                    "participantId": self.pid,
                    "requestId": request_id,
                    "buffer": FAKE_AUDIO,
                },
            )

        except Exception as e:
            report_failure("audio_chunk", e)

    @task(3)
    def send_frame(self):
        """Emit a randomly selected JPEG frame with a tracked request ID."""
        if not self.connected:
            return

        if not self.camera_enabled:
            return

        try:

            frame = random.choice(FRAMES)

            request_id = str(uuid.uuid4())

            with self.pending_lock:
                self.pending_requests[request_id] = time.time()

            self.sio.emit(
                "emotion.frame",
                {
                    "participantId": self.pid,
                    "requestId": request_id,
                    "buffer": frame,
                },
            )

        except Exception as e:
            report_failure("emotion.frame", e)

    @task(1)
    def toggle_mic(self):
        """Toggle microphone state and emit a media-state update."""
        if not self.connected:
            return

        self.mic_enabled = not self.mic_enabled

        start = time.time()

        try:

            self.sio.emit(
                "participant.media_state",
                {
                    "participantId": self.pid,
                    "micEnabled": self.mic_enabled,
                    "cameraEnabled": self.camera_enabled,
                },
            )

            report_success(
                "toggle_mic",
                (time.time() - start) * 1000,
                0,
            )

        except Exception as e:
            report_failure("toggle_mic", e)

    @task(1)
    def toggle_camera(self):
        """Toggle camera state and emit a media-state update."""
        if not self.connected:
            return

        self.camera_enabled = not self.camera_enabled

        start = time.time()

        try:

            self.sio.emit(
                "participant.media_state",
                {
                    "participantId": self.pid,
                    "micEnabled": self.mic_enabled,
                    "cameraEnabled": self.camera_enabled,
                },
            )

            report_success(
                "toggle_camera",
                (time.time() - start) * 1000,
                0,
            )

        except Exception as e:
            report_failure("toggle_camera", e)

    @task(1)
    def random_pause(self):
        """Introduce random network jitter by sleeping for a short duration."""
        time.sleep(random.uniform(0.05, 0.30))
