import whisper
from transformers import pipeline
from utils.emotion import normalize_emotion, get_emoji
from collections import Counter
import re
import math

print("Loading Whisper model...")
asr_model = whisper.load_model("small")

print("Loading emotion model...")
emotion_pipeline = pipeline(
    "text-classification",
    model="j-hartmann/emotion-english-distilroberta-base",
    top_k=1,
)

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
        "speaker": raw_segs[0].get("speaker", "Speaker 1"),
    }

    for seg in raw_segs[1:]:
        text = (seg.get("text") or "").strip()
        if not text:
            continue

        gap = seg.get("start", 0) - buf["end"]
        combined_words = len((buf["text"] + " " + text).split())
        ends_clean = buf["text"].strip().endswith((".", "!", "?"))
        same_speaker = seg.get("speaker", "Speaker 1") == buf["speaker"]

        if (
            gap <= MERGE_GAP_SEC
            and combined_words <= MERGE_MAX_WORDS
            and not ends_clean
            and same_speaker
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
                "speaker": seg.get("speaker", "Speaker 1"),
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

    speakers = list({s.get("speaker", "Speaker 1") for s in segments})
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


def transcribe_and_emotion(wav_path):
    try:
        asr = asr_model.transcribe(wav_path, language="en")
    except Exception as e:
        print(f"asr_service: transcription failed for {wav_path} — {e}")
        return {"segments": [], "analysis": build_intelligent_summary([])}

    raw_segs = asr.get("segments", [])
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
                "speaker": seg.get("speaker", "Speaker 1"),
            }
        )

    analysis = build_intelligent_summary(segments)
    return {"segments": segments, "analysis": analysis}
