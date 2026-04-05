from dotenv import load_dotenv

load_dotenv()

import os
import json
import requests

from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename

from config import *
from utils.audio import convert_to_wav
from utils.helpers import allowed_file, clean_speaker, schedule_file_cleanup
from services.asr_service import transcribe_and_emotion
from services.processing_service import merge_segments, build_transcript_text

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app = Flask(__name__)
CORS(app)


@app.route("/process_meeting", methods=["POST"])
def process_meeting():
    files = request.files.getlist("audio_files")
    meeting_code = request.form.get("meeting_code", "UNKNOWN").upper()
    speaker_map_raw = request.form.get("speaker_map", "{}")

    try:
        speaker_map = json.loads(speaker_map_raw)
    except Exception:
        speaker_map = {}

    host_secret = request.headers.get("x-host-secret", "") or request.form.get(
        "hostSecret", ""
    )

    if not host_secret:
        print("process_meeting: host_secret missing from request")

    results = {}
    created_files = []

    for f in files:
        if not (f and allowed_file(f.filename, ALLOWED_EXT)):
            continue

        filename = secure_filename(f.filename)
        base = os.path.splitext(filename)[0]

        save_path = os.path.join(UPLOAD_FOLDER, filename)
        f.save(save_path)
        created_files.append(save_path)

        wav_path = os.path.join(UPLOAD_FOLDER, f"{base}.wav")

        try:
            convert_to_wav(save_path, wav_path)
            created_files.append(wav_path)
        except Exception as e:
            print(
                f"process_meeting: wav conversion failed for {filename}, using original — {e}"
            )
            wav_path = save_path

        segments = transcribe_and_emotion(wav_path)

        results[base] = {
            "speaker": clean_speaker(speaker_map.get(base, base)),
            "segments": segments,
        }

    merged = merge_segments(results)
    transcript_text = build_transcript_text(merged)

    if not merged:
        print(f"process_meeting: no valid audio segments for meeting {meeting_code}")
        schedule_file_cleanup(created_files, CLEANUP_DELAY_SEC)
        return (
            jsonify(
                {
                    "success": False,
                    "error": "No valid audio files processed",
                    "transcript_text": "",
                    "segments": [],
                }
            ),
            400,
        )

    node_ok = False
    node_error = None

    try:
        res = requests.post(
            NODE_API,
            json={
                "meetingCode": meeting_code,
                "transcriptText": transcript_text,
                "metadata": {"segments": merged},
            },
            headers={
                "Content-Type": "application/json",
                "x-host-secret": host_secret,
            },
            timeout=5,
        )

        if res.status_code in (200, 201):
            node_ok = True
            print(f"process_meeting: transcript saved for meeting {meeting_code}")
        else:
            node_error = f"Node rejected with status {res.status_code}"
            print(f"process_meeting: {node_error} — {res.text[:200]}")

    except requests.exceptions.Timeout:
        node_error = "Node API timed out"
        print(f"process_meeting: Node API timed out for meeting {meeting_code}")
    except requests.exceptions.ConnectionError:
        node_error = "Node API unreachable"
        print(f"process_meeting: Node API unreachable for meeting {meeting_code}")
    except Exception as e:
        node_error = str(e)
        print(f"process_meeting: unexpected error calling Node API — {e}")

    schedule_file_cleanup(created_files, CLEANUP_DELAY_SEC)

    if not node_ok:
        return (
            jsonify(
                {
                    "success": False,
                    "error": node_error or "Node API call failed",
                    "transcript_text": transcript_text,
                    "segments": merged,
                }
            ),
            502,
        )

    return jsonify(
        {
            "success": True,
            "transcript_text": transcript_text,
            "segments": merged,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True, use_reloader=False)
