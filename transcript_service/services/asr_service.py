import whisper
from transformers import pipeline
from utils.emotion import normalize_emotion, get_emoji

print("Loading Whisper model...")
asr_model = whisper.load_model("small")

print("Loading emotion model...")
emotion_pipeline = pipeline(
    "text-classification",
    model="j-hartmann/emotion-english-distilroberta-base",
    top_k=1,
)


def _extract_label(raw):
    try:
        if isinstance(raw, dict):
            return raw.get("label", "neutral")
        if isinstance(raw, list) and len(raw) > 0:
            if isinstance(raw[0], dict):
                return raw[0].get("label", "neutral")
            if isinstance(raw[0], list) and len(raw[0]) > 0:
                return raw[0][0].get("label", "neutral")
    except Exception:
        pass
    return "neutral"


def transcribe_and_emotion(wav_path):
    try:
        asr = asr_model.transcribe(wav_path, language="en")
    except Exception as e:
        print(f"asr_service: transcription failed for {wav_path} — {e}")
        return []

    segments = []

    for seg in asr.get("segments", []):
        text = (seg.get("text") or "").strip()
        if len(text) < 3:
            continue

        try:
            raw = emotion_pipeline(text, top_k=1)
            emo = normalize_emotion(_extract_label(raw))
        except Exception as e:
            print(f"asr_service: emotion detection failed for segment — {e}")
            emo = "neutral"

        segments.append(
            {
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "text": text,
                "emotion": emo,
                "emoji": get_emoji(emo),
            }
        )

    return segments
