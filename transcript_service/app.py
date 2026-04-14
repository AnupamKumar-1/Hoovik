from dotenv import load_dotenv

load_dotenv()

import os
import json
import requests

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from werkzeug.utils import secure_filename

from config import *
from utils.audio import convert_to_wav
from utils.helpers import allowed_file, clean_speaker, schedule_file_cleanup
from services.asr_service import transcribe_and_emotion
from services.processing_service import merge_segments, build_transcript_text

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/process_meeting")
async def process_meeting(
    audio_files: list[UploadFile] = File(...),
    meeting_code: str = Form(default="UNKNOWN"),
    speaker_map: str = Form(default="{}"),
    host_secret: str = Header(default="", alias="x-host-secret"),
    user_token: str = Header(default="", alias="x-user-token"),
):
    meeting_code = meeting_code.upper()

    try:
        speaker_map_dict = json.loads(speaker_map)
    except Exception:
        speaker_map_dict = {}

    print("HOST SECRET RECEIVED IN FASTAPI:", host_secret)
    if not host_secret:
        print("process_meeting: host_secret missing from request")

    results = {}
    created_files = []

    for f in audio_files:
        if not (f and allowed_file(f.filename, ALLOWED_EXT)):
            continue

        filename = secure_filename(f.filename)
        base = os.path.splitext(filename)[0]

        save_path = os.path.join(UPLOAD_FOLDER, filename)
        contents = await f.read()
        with open(save_path, "wb") as out:
            out.write(contents)
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
            "speaker": clean_speaker(speaker_map_dict.get(base, base)),
            "segments": segments,
        }

    merged = merge_segments(results)
    transcript_text = build_transcript_text(merged)

    if not merged:
        print(f"process_meeting: no valid audio segments for meeting {meeting_code}")
        schedule_file_cleanup(created_files, CLEANUP_DELAY_SEC)
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "No valid audio files processed",
                "transcript_text": "",
                "segments": [],
            },
        )

    transcript_saved = False
    node_error = None

    try:
        print("CALLING NODE API:", NODE_API)

        node_headers = {
            "Content-Type": "application/json",
            "x-host-secret": host_secret,
        }
        if user_token:
            node_headers["Authorization"] = f"Bearer {user_token}"

        res = requests.post(
            NODE_API,
            json={
                "meetingCode": meeting_code,
                "transcriptText": transcript_text,
                "metadata": {"segments": merged},
            },
            headers=node_headers,
            timeout=5,
        )
        print(" NODE RESPONSE STATUS:", res.status_code)
        print(" NODE RESPONSE BODY:", res.text[:300])
        if res.status_code in (200, 201):
            transcript_saved = True
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

    if not transcript_saved:
        return JSONResponse(
            status_code=502,
            content={
                "success": False,
                "error": node_error or "Node API call failed",
                "transcript_text": transcript_text,
                "segments": merged,
            },
        )

    return JSONResponse(
        content={
            "success": True,
            "transcript_text": transcript_text,
            "segments": merged,
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=5001, reload=False)
