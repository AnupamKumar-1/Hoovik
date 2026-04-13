def merge_segments(results):
    merged = []

    for _, info in results.items():
        for seg in info["segments"]:
            merged.append(
                {
                    "start": seg["start"],
                    "end": seg.get("end", 0),
                    "speaker": info["speaker"],
                    "text": seg["text"],
                    "emotion": seg["emotion"],
                    "emoji": seg["emoji"],
                }
            )

    merged.sort(key=lambda x: x["start"])
    return merged


def build_transcript_text(merged):
    return "\n".join(
        [f"[{e['speaker']}] {e['emoji']} ({e['emotion']}) {e['text']}" for e in merged]
    )
