import os

UPLOAD_FOLDER = "uploads"
OUTPUT_FOLDER = "outputs"

ALLOWED_EXT = {"webm", "wav", "mp3", "m4a", "ogg", "aac", "mp4"}

CLEANUP_DELAY_SEC = 120

NODE_API = os.getenv("NODE_API", "http://localhost:8000/api/v1/transcript")
