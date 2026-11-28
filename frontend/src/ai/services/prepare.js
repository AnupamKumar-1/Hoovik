// Transcript preparation: normalise, de-duplicate, merge turns, format, chunk. Pure and deterministic.
// Chunking never drops text: every sentence of the input appears in exactly one chunk line.

export const DEFAULT_MAX_CHUNK_CHARS = 6000; // placeholder until Part 1 measures the real on-device limit
export const MIN_CHUNK_CHARS = 120;
const MAX_SPEAKER_LABEL = 60;
const MIN_ROOM = 20;

export class TranscriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TranscriptError";
    this.code = code;
  }
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

export function formatTime(sec = 0) {
  const t = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const label = (speaker) => (speaker.length > MAX_SPEAKER_LABEL ? `${speaker.slice(0, MAX_SPEAKER_LABEL - 1)}…` : speaker);
export const formatLine = (speaker, start, text) => `[${formatTime(start)}] ${label(speaker)}: ${text}`;

/** Trim and collapse whitespace, canonicalise speaker casing, drop empty and duplicate segments, sort by start. */
export function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const canon = new Map();
  const seen = new Set();
  const out = [];
  let lastEnd = 0;
  for (const raw of segments) {
    if (!raw || typeof raw !== "object") continue;
    const text = clean(raw.text);
    if (!text) continue;
    const spoken = clean(raw.speaker) || "Unknown";
    const key = spoken.toLowerCase();
    if (!canon.has(key)) canon.set(key, spoken);
    const speaker = canon.get(key);
    const start = finite(raw.start) ?? lastEnd;
    const end = Math.max(finite(raw.end) ?? start, start);
    lastEnd = end;
    const dupKey = `${key}|${Math.round(start * 10)}|${text.toLowerCase()}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const prev = out[out.length - 1];
    if (prev && prev.speaker === speaker && prev.text.toLowerCase() === text.toLowerCase()) continue;
    out.push({ start, end, speaker, text, emotion: clean(raw.emotion).toLowerCase() || "neutral", emoji: typeof raw.emoji === "string" ? raw.emoji : "" });
  }
  return out.map((s, i) => [s, i]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map((x) => x[0]);
}

function dominant(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** Merge consecutive same-speaker segments into turns. segmentIndexes point into the normalised array. */
export function mergeTurns(segments) {
  const turns = [];
  segments.forEach((s, i) => {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.text += ` ${s.text}`;
      last.end = Math.max(last.end, s.end);
      last.segmentIndexes.push(i);
      last._emotions.push(s.emotion);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, text: s.text, segmentIndexes: [i], _emotions: [s.emotion] });
    }
  });
  return turns.map(({ _emotions, ...t }) => ({ ...t, emotion: dominant(_emotions) || "neutral" }));
}

export function splitSentences(text) {
  const parts = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

function hardSplit(piece, max) {
  const out = [];
  let cur = "";
  for (const word of piece.split(" ")) {
    if (word.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
      continue;
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= max) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out;
}

function turnToLines(turn, turnIndex, maxChars) {
  const whole = formatLine(turn.speaker, turn.start, turn.text);
  if (whole.length <= maxChars) return [{ text: whole, start: turn.start, end: turn.end, turnIndex }];
  const room = maxChars - formatLine(turn.speaker, turn.end, "").length;
  /* v8 ignore next 1 */ // unreachable while labels are clamped and limit >= MIN_CHUNK_CHARS; defensive
  if (room < MIN_ROOM) throw new TranscriptError("INVALID_LIMIT", "Chunk limit too small for this speaker label");
  const pieces = [];
  let cur = "";
  const push = () => { if (cur) { pieces.push(cur); cur = ""; } };
  for (const sentence of splitSentences(turn.text)) {
    const parts = sentence.length > room ? hardSplit(sentence, room) : [sentence];
    for (const part of parts) {
      if (!cur) cur = part;
      else if (cur.length + 1 + part.length <= room) cur += ` ${part}`;
      else { push(); cur = part; }
    }
  }
  push();
  const total = turn.text.length || 1;
  const span = turn.end - turn.start;
  let offset = 0;
  return pieces.map((p) => {
    const start = turn.start + (offset / total) * span;
    offset += p.length + 1;
    return { text: formatLine(turn.speaker, start, p), start, end: Math.min(turn.end, turn.start + (offset / total) * span), turnIndex };
  });
}

export function chunkLines(lines, maxChars) {
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    if (cur && cur.charCount + 1 + line.text.length <= maxChars) {
      cur.lines.push(line.text);
      cur.charCount += 1 + line.text.length;
      cur.endSec = Math.max(cur.endSec, line.end);
      if (!cur.turnIndexes.includes(line.turnIndex)) cur.turnIndexes.push(line.turnIndex);
    } else {
      cur = { index: chunks.length, lines: [line.text], charCount: line.text.length, startSec: line.start, endSec: line.end, turnIndexes: [line.turnIndex] };
      chunks.push(cur);
    }
  }
  return chunks.map(({ lines: ls, ...c }) => ({ ...c, text: ls.join("\n") }));
}

/**
 * input: segments array, or a plain string (treated as one "Unknown" segment).
 * Throws TranscriptError EMPTY_TRANSCRIPT / INVALID_INPUT / INVALID_LIMIT.
 */
export function prepareTranscript(input, { maxChunkChars = DEFAULT_MAX_CHUNK_CHARS } = {}) {
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < MIN_CHUNK_CHARS) {
    throw new TranscriptError("INVALID_LIMIT", `maxChunkChars must be an integer >= ${MIN_CHUNK_CHARS}`);
  }
  let raw = input;
  if (typeof input === "string") raw = [{ speaker: "Unknown", start: 0, end: 0, text: input }];
  else if (!Array.isArray(input)) throw new TranscriptError("INVALID_INPUT", "Transcript must be an array of segments or a string");
  const segments = normalizeSegments(raw);
  if (segments.length === 0) throw new TranscriptError("EMPTY_TRANSCRIPT", "Transcript has no usable text");
  const turns = mergeTurns(segments);
  const lines = turns.flatMap((t, i) => turnToLines(t, i, maxChunkChars));
  const chunks = chunkLines(lines, maxChunkChars);
  const text = lines.map((l) => l.text).join("\n");
  return {
    segments,
    turns,
    speakers: [...new Set(segments.map((s) => s.speaker))],
    lines: lines.map((l) => l.text),
    text,
    charCount: text.length,
    chunks,
  };
}
