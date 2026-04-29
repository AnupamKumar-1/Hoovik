def merge_segments(results):
    merged = []

    for _, info in results.items():
        for seg in info["segments"]:
            merged.append(
                {
                    "start": float(seg["start"]),
                    "end": float(seg.get("end", 0)),
                    "speaker": seg.get("speaker", "Unknown"),
                    "text": seg["text"].strip(),
                    "emotion": seg["emotion"],
                    "emoji": seg["emoji"],
                }
            )

    merged.sort(key=lambda x: (x["start"], x["end"]))
    return merged


def _format_time(sec):
    sec = sec or 0
    m = int(sec // 60)
    s = int(sec % 60)
    return f"{m:02d}:{s:02d}"


def build_transcript_text(merged):
    lines = []
    prev_speaker = None
    buffer = []
    start_time = 0
    block_emotions = []

    for e in merged:
        speaker = e["speaker"]

        if speaker != prev_speaker:
            if buffer:

                emoji = (
                    max(set(block_emotions), key=block_emotions.count)
                    if block_emotions
                    else "🙂"
                )
                lines.append(
                    f"[{prev_speaker}] ({_format_time(start_time)}) {emoji} "
                    + " ".join(buffer)
                )
                lines.append("")
                buffer = []
                block_emotions = []

            prev_speaker = speaker
            start_time = e["start"]

        buffer.append(e["text"])
        block_emotions.append(e["emoji"])

    if buffer:
        emoji = (
            max(set(block_emotions), key=block_emotions.count)
            if block_emotions
            else "🙂"
        )
        lines.append(
            f"[{prev_speaker}] ({_format_time(start_time)}) {emoji} " + " ".join(buffer)
        )

    return "\n".join(lines).strip()
