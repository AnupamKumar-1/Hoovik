def merge_segments(results: dict) -> list[dict]:
    """Flatten per-speaker segment dicts into a single chronologically sorted list.

    Extracts the ``segments`` list from each entry in ``results``, casts
    ``start`` and ``end`` timestamps to ``float``, and sorts the combined
    list by ``(start, end)``.

    Args:
        results: Dict mapping an arbitrary speaker key to a dict containing
            a ``segments`` key whose value is a list of segment dicts. Each
            segment must have ``start``, ``end``, ``speaker``, ``text``,
            ``emotion``, and ``emoji`` fields.

    Returns:
        Flat list of segment dicts sorted by ``(start, end)``, with
        timestamps cast to ``float``.
    """
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


def _format_time(sec) -> str:
    """Convert a float second value to a zero-padded ``MM:SS`` string.

    Args:
        sec: Timestamp in seconds. ``None`` and falsy values are treated as 0.

    Returns:
        String in ``MM:SS`` format with zero-padded minutes and seconds.
    """
    sec = sec or 0
    m = int(sec // 60)
    s = int(sec % 60)
    return f"{m:02d}:{s:02d}"


def build_transcript_text(merged: list[dict]) -> str:
    """Format a flat, sorted segment list into a human-readable transcript string.

    Groups consecutive segments by speaker into turn blocks. Each block is
    rendered as ``[Speaker] (MM:SS) <dominant_emoji> <text>``, where the
    dominant emoji is the most frequent emoji across the block's segments
    (defaulting to 🙂 when none are present). Blocks are separated by a
    blank line. The final trailing newline is stripped.

    Args:
        merged: Flat, chronologically sorted list of segment dicts as
            returned by ``merge_segments``. Each dict must contain
            ``speaker``, ``start``, ``text``, and ``emoji`` keys.

    Returns:
        Formatted transcript string, or an empty string if ``merged`` is
        empty.
    """
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
