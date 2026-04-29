import whisper
import torch
from pyannote.audio import Pipeline
from transformers import pipeline
from utils.emotion import normalize_emotion, get_emoji
from collections import Counter
import re
import os

print("Loading Whisper model...")
asr_model = whisper.load_model("small")

print("Loading emotion model...")
emotion_pipeline = pipeline(
    "text-classification",
    model="j-hartmann/emotion-english-distilroberta-base",
    top_k=1,
)

print("Loading diarization model...")
diarization_pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token=os.getenv("HF_API_TOKEN"),
)
diarization_pipeline.to(torch.device("cpu"))

CUSTOM_NAMES = {"Speaker 0": "Anupam"}

MAX_AUDIO_LENGTH = 300

emotion_cache = {}


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


MERGE_GAP_SEC = 2.0
MERGE_MAX_WORDS = 60


def _clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.strip()
    text = text[0].upper() + text[1:] if len(text) > 1 else text.upper()
    text = " ".join(text.split())
    if text[-1] not in ".!?":
        text += "."
    return text


def _merge_raw_segments(raw_segs):
    if not raw_segs:
        return []

    merged = []
    buf = {
        "start": raw_segs[0].get("start", 0),
        "end": raw_segs[0].get("end", 0),
        "text": (raw_segs[0].get("text") or "").strip(),
        "speaker": raw_segs[0].get("speaker", "Unknown"),
    }

    for seg in raw_segs[1:]:
        text = (seg.get("text") or "").strip()
        if not text:
            continue

        gap = seg.get("start", 0) - buf["end"]
        combined_words = len((buf["text"] + " " + text).split())
        ends_clean = buf["text"].strip().endswith((".", "!", "?"))
        same_speaker = seg.get("speaker", "Unknown") == buf["speaker"]

        if not same_speaker:
            if buf["text"]:
                merged.append(buf)
            buf = {
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "text": text,
                "speaker": seg.get("speaker", "Unknown"),
            }
            continue

        if (
            gap <= MERGE_GAP_SEC
            and combined_words <= MERGE_MAX_WORDS
            and not ends_clean
        ):
            buf["text"] += " " + text
            buf["end"] = seg.get("end", buf["end"])
        else:
            if buf["text"]:
                merged.append(buf)
            buf = {
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "text": text,
                "speaker": seg.get("speaker", "Unknown"),
            }

    if buf["text"]:
        merged.append(buf)

    return merged


def _get_emotion(text: str) -> str:
    if text in emotion_cache:
        return emotion_cache[text]

    words = text.split()
    if len(words) < 4:
        emo = "neutral"
    else:
        try:
            raw = emotion_pipeline(text, top_k=1)
            emo = normalize_emotion(_extract_label(raw))
        except Exception as e:
            print(f"asr_service: emotion detection failed — {e}")
            emo = "neutral"

    emotion_cache[text] = emo
    return emo


def get_speaker_segments(wav_path):
    diarization = diarization_pipeline(wav_path, num_speakers=None)

    speaker_segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_segments.append(
            {
                "start": turn.start,
                "end": turn.end,
                "speaker": speaker,
            }
        )

    return speaker_segments


def assign_speaker_to_segments(asr_segments, speaker_segments):
    for seg in asr_segments:
        best_spk = "Unknown"
        best_overlap = 0

        for spk in speaker_segments:
            overlap = max(
                0, min(seg["end"], spk["end"]) - max(seg["start"], spk["start"])
            )

            if overlap > best_overlap:
                best_overlap = overlap
                best_spk = spk["speaker"]

        seg["speaker"] = (
            best_spk
            if best_overlap >= min(0.3, (seg["end"] - seg["start"]) * 0.5)
            else "Unknown"
        )

    return asr_segments


STOP_WORDS = {
    "this",
    "that",
    "with",
    "have",
    "from",
    "they",
    "were",
    "been",
    "will",
    "would",
    "could",
    "should",
    "about",
    "there",
    "their",
    "what",
    "when",
    "where",
    "which",
    "while",
    "your",
    "just",
    "also",
    "then",
    "than",
    "into",
    "some",
    "very",
    "more",
    "like",
    "really",
    "okay",
    "yeah",
    "well",
    "know",
    "think",
    "said",
    "going",
    "thing",
}


def _score_segment(seg):
    score = 0
    words = seg["text"].split()
    word_count = len(words)

    if 10 <= word_count <= 35:
        score += 3
    elif 5 <= word_count < 10 or 35 < word_count <= 50:
        score += 1

    if seg["emotion"] not in ("neutral",):
        score += 3

    if any(
        w in seg["text"].lower()
        for w in [
            "important",
            "key",
            "main",
            "critical",
            "problem",
            "solution",
            "decide",
            "agree",
            "conclusion",
            "summary",
            "action",
            "next",
            "plan",
        ]
    ):
        score += 2

    if seg["text"].strip().endswith("?"):
        score += 1

    duration = seg.get("end", 0) - seg.get("start", 0)
    if duration > 5:
        score += 1

    return score


def _build_narrative_summary(segments, full_text):
    words = full_text.split()
    total_words = len(words)

    if total_words == 0:
        return ""

    if total_words <= 40:
        return full_text

    num_segs = len(segments)

    if num_segs <= 3:
        return full_text if total_words < 80 else " ".join(words[:80]) + "..."

    third = num_segs // 3
    opening = segments[: max(1, third)]
    middle = segments[max(1, third) : max(2, 2 * third)]
    closing = segments[max(2, 2 * third) :]

    def best_from(group):
        if not group:
            return ""
        scored = sorted(group, key=_score_segment, reverse=True)
        return scored[0]["text"]

    parts = []
    o = best_from(opening)
    m = best_from(middle)
    c = best_from(closing)

    if o:
        parts.append(o.rstrip(".") + ".")
    if m and m != o:
        parts.append(m.rstrip(".") + ".")
    if c and c not in (o, m):
        parts.append(c.rstrip(".") + ".")

    summary = " ".join(parts)
    summary_words = summary.split()
    if len(summary_words) > 80:
        summary = " ".join(summary_words[:80]) + "..."

    return summary


def build_intelligent_summary(segments):
    if not segments:
        return {"summary": "", "key_points": [], "insights": {}}

    full_text = " ".join([s["text"] for s in segments])

    summary = _build_narrative_summary(segments, full_text)

    scored_segs = sorted(segments, key=_score_segment, reverse=True)
    seen_texts = set()
    key_points = []
    for seg in scored_segs:
        txt = seg["text"].strip()
        if txt not in seen_texts and len(txt.split()) >= 5:
            key_points.append(txt)
            seen_texts.add(txt)
        if len(key_points) == 5:
            break

    emotions = [s["emotion"] for s in segments]
    counts = Counter(emotions)
    total = len(emotions)
    emotion_distribution = {k: round(v / total * 100) for k, v in counts.items()}
    dominant_emotion = counts.most_common(1)[0][0]

    emotional_moments = []
    for seg in segments:
        if seg["emotion"] not in ("neutral",):
            emotional_moments.append(
                {
                    "text": seg["text"][:80],
                    "emotion": seg["emotion"],
                    "start": seg.get("start", 0),
                }
            )
    emotional_moments = emotional_moments[:3]

    raw_words = re.findall(r"\b[a-zA-Z]{5,}\b", full_text.lower())
    filtered_words = [w for w in raw_words if w not in STOP_WORDS]
    word_freq = Counter(filtered_words)
    top_topics = [w for w, _ in word_freq.most_common(8)]

    speakers = list({s.get("speaker", "Unknown") for s in segments})
    speaker_stats = {}
    for spk in speakers:
        spk_segs = [s for s in segments if s.get("speaker") == spk]
        spk_emotions = Counter(s["emotion"] for s in spk_segs)
        speaker_stats[spk] = {
            "turns": len(spk_segs),
            "dominant_emotion": (
                spk_emotions.most_common(1)[0][0] if spk_emotions else "neutral"
            ),
            "word_count": sum(len(s["text"].split()) for s in spk_segs),
        }

    total_duration = segments[-1].get("end", 0) if segments else 0
    total_words_spoken = sum(len(s["text"].split()) for s in segments)
    speaking_pace = (
        round(total_words_spoken / (total_duration / 60)) if total_duration > 0 else 0
    )

    return {
        "summary": summary,
        "key_points": key_points,
        "insights": {
            "dominant_emotion": dominant_emotion,
            "emotion_distribution": emotion_distribution,
            "emotional_moments": emotional_moments,
            "top_topics": top_topics,
            "speaker_stats": speaker_stats,
            "total_words": total_words_spoken,
            "speaking_pace_wpm": speaking_pace,
            "total_duration_sec": round(total_duration),
        },
    }


def detect_primary_speaker(segments):
    duration_map = {}

    for seg in segments:
        spk = seg.get("speaker")
        if not spk or spk == "Unknown":
            continue
        duration = seg.get("end", 0) - seg.get("start", 0)
        duration_map[spk] = duration_map.get(spk, 0) + duration

    if not duration_map:
        return None

    return max(duration_map, key=duration_map.get)


def transcribe_and_emotion(wav_path, speaker_map=None):
    try:
        asr = asr_model.transcribe(wav_path, language="en", fp16=False)
    except Exception as e:
        print(f"asr_service: transcription failed for {wav_path} — {e}")
        return {"segments": [], "analysis": build_intelligent_summary([])}

    raw_segs = asr.get("segments", [])

    if raw_segs and raw_segs[-1].get("end", 0) > MAX_AUDIO_LENGTH:
        print(f"asr_service: audio exceeds {MAX_AUDIO_LENGTH}s, skipping diarization")
        speaker_segments = []
    else:
        speaker_segments = get_speaker_segments(wav_path)


    if speaker_segments:
        raw_segs = assign_speaker_to_segments(raw_segs, speaker_segments)
    else:
        for seg in raw_segs:
            seg["speaker"] = "Speaker 0"

    if not speaker_map:
        seen = []
        for seg in raw_segs:
            spk = seg.get("speaker")
            if spk and spk != "Unknown" and spk not in seen:
                seen.append(spk)
        speaker_map = {spk: f"User {i+1}" for i, spk in enumerate(seen)}


        for k, v in CUSTOM_NAMES.items():
            if k in speaker_map:
                speaker_map[k] = v

        host = detect_primary_speaker(raw_segs)
        if host and speaker_map.get(host, "").startswith("User"):
            speaker_map[host] = "Host"

    unknown_map = {}
    unknown_counter = 1
    for seg in raw_segs:
        spk = seg.get("speaker")
        if spk in speaker_map:
            seg["speaker"] = speaker_map[spk]
        else:
            if spk not in unknown_map:
                unknown_map[spk] = f"Guest {unknown_counter}"
                unknown_counter += 1
            seg["speaker"] = unknown_map[spk]

    merged_segs = _merge_raw_segments(raw_segs)

    segments = []

    for seg in merged_segs:
        text = _clean_text(seg["text"])
        if len(text) < 3:
            continue

        words = text.split()
        if len(words) > 80:
            text = " ".join(words[:80]) + "..."

        emo = _get_emotion(text)

        segments.append(
            {
                "start": seg["start"],
                "end": seg["end"],
                "text": text,
                "emotion": emo,
                "emoji": get_emoji(emo),
                "speaker": seg.get("speaker", "Unknown"),
            }
        )

    analysis = build_intelligent_summary(segments)
    return {"segments": segments, "analysis": analysis}
