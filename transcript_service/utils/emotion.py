EMOJI_MAP = {
    "joy": "😄",
    "happy": "😄",
    "sadness": "😢",
    "anger": "😡",
    "fear": "😨",
    "surprise": "😲",
    "neutral": "😐",
    "disgust": "🤢",
}


def normalize_emotion(label: str) -> str:
    """Normalise a raw model emotion label to a canonical form.

    Maps ``"happy"`` and ``"happiness"`` to ``"joy"``, and ``"sad"`` to
    ``"sadness"``. All other labels are returned lowercased and unchanged.

    Args:
        label: Raw emotion label string from the classification model.

    Returns:
        Canonical emotion label string.
    """
    label = label.lower()
    if label in ["happy", "happiness"]:
        return "joy"
    if label in ["sad"]:
        return "sadness"
    if label == "disgust":
        return "disgust"
    return label


def get_emoji(label: str) -> str:
    """Return the emoji corresponding to an emotion label.

    Looks up ``label`` (case-insensitive) in ``EMOJI_MAP``. Falls back
    to ``"😐"`` for unrecognised labels.

    Args:
        label: Canonical emotion label string.

    Returns:
        Emoji string for the given label.
    """
    return EMOJI_MAP.get(label.lower(), "😐")
