export const EMOTION_DISPLAY_MIN_SCORE = 0.12;

function normalizeLabel(raw) {
  if (!raw && raw !== 0) return "";
  const s = String(raw).trim().toLowerCase();
  return s.replace(/[_\s]+/g, " ").trim();
}

function titleCaseLabel(label) {
  if (!label) return "";
  return label
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function normalizeScore(rawScore) {
  if (rawScore == null || Number.isNaN(Number(rawScore))) return null;
  const n = Number(rawScore);
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  if (n > 100) return 1;
  return Math.max(0, Math.min(1, n));
}

export function formatTopEmotion(emotion) {
  if (emotion == null) return null;

  try {
    if (typeof emotion === "string") {
      return { label: normalizeLabel(emotion), score: 0 };
    }

    if (Array.isArray(emotion)) {
      const mapped = emotion
        .map((e) => {
          if (!e) return null;
          if (Array.isArray(e)) return [normalizeLabel(e[0]), normalizeScore(e[1]) ?? 0];
          if (typeof e === "object") {
            const lbl = e.label ?? e.name;
            const sc = e.score ?? e.confidence ?? e.probability;
            if (lbl) return [normalizeLabel(lbl), normalizeScore(sc) ?? 0];
          }
          if (typeof e === "string") return [normalizeLabel(e), 0];
          return null;
        })
        .filter(Boolean);

      if (mapped.length) {
        mapped.sort((a, b) => b[1] - a[1]);
        return { label: mapped[0][0], score: mapped[0][1] };
      }
    }

    if (typeof emotion === "object") {
      const entries = Object.entries(emotion).filter(
        ([_, v]) => typeof v === "number" || !Number.isNaN(Number(v))
      );

      if (entries.length) {
        entries.sort((a, b) => Number(b[1]) - Number(a[1]));
        return {
          label: normalizeLabel(entries[0][0]),
          score: normalizeScore(entries[0][1]) ?? 0,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function getTopEmotionLabel(emotion) {
  const top = formatTopEmotion(emotion);
  if (!top) return null;

  const score = typeof top.score === "number" ? top.score : 0;

  if (score > 0 && score < EMOTION_DISPLAY_MIN_SCORE)
    return null;

  return String(top.label).toLowerCase();
}

export const EMOJI_MAP = {
  happy: "😊",
  sad: "😢",
  angry: "😠",
  neutral: "😐",
  surprised: "😲",
  fear: "😨",
  disgust: "🤢",
};

export function renderEmojiLabelForEmotion(emotion) {
  const top = formatTopEmotion(emotion);
  if (!top || !top.label) return null;

  const score = typeof top.score === "number" ? top.score : 0;
  if (score > 0 && score < EMOTION_DISPLAY_MIN_SCORE) return null;

  const label = normalizeLabel(top.label);
  const emoji = EMOJI_MAP[label] || "🫥";
  const displayLabel = titleCaseLabel(label);

  let percent = null;
  const norm = normalizeScore(score);
  if (norm != null && norm > 0) {
    percent = Math.round(norm * 100);
  }

  return percent
    ? `${emoji} ${displayLabel} (${percent}%)`
    : `${emoji} ${displayLabel}`;
}