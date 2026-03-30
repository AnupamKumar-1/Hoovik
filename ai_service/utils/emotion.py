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

def normalize_emotion(label):
    label = label.lower()
    if label in ["happy", "happiness"]:
        return "joy"
    if label in ["sad"]:
        return "sadness"
    return label

def get_emoji(label):
    return EMOJI_MAP.get(label.lower(), "😐")