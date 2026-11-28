// Deterministic insights computed from transcript segments. No model involved.
// Output is shaped exactly as SummaryPanel in TranscriptViewer.jsx reads `insights`.
// top_topics and discrepancies are left empty here: topics come from the model (or stay empty),
// discrepancies are produced by the local discrepancy module (Part 8).

import { normalizeSegments, mergeTurns } from "./prepare.js";

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

function mostFrequent(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = "neutral";
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** Integer percentages that sum to exactly 100 (largest remainder), ordered by share. */
export function percentages(counts, total) {
  const entries = Object.entries(counts);
  if (!total || entries.length === 0) return {};
  const rows = entries.map(([k, n]) => {
    const exact = (n * 100) / total;
    return { k, n, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = 100 - rows.reduce((a, r) => a + r.floor, 0);
  [...rows].sort((a, b) => b.rem - a.rem || b.n - a.n || a.k.localeCompare(b.k)).forEach((r) => {
    if (left > 0) { r.floor += 1; left -= 1; }
  });
  return Object.fromEntries(rows.sort((a, b) => b.floor - a.floor || b.n - a.n || a.k.localeCompare(b.k)).map((r) => [r.k, r.floor]));
}

export function computeInsights(input) {
  const segments = normalizeSegments(input);
  if (segments.length === 0) {
    return {
      dominant_emotion: "neutral",
      emotion_distribution: {},
      emotional_moments: [],
      top_topics: [],
      speaker_stats: {},
      discrepancies: [],
      total_words: 0,
      speaking_pace_wpm: 0,
      total_duration_sec: 0,
    };
  }

  const counts = {};
  for (const s of segments) counts[s.emotion] = (counts[s.emotion] || 0) + 1;

  const turns = mergeTurns(segments);
  const speaker_stats = {};
  for (const name of new Set(segments.map((s) => s.speaker))) {
    const mine = segments.filter((s) => s.speaker === name);
    speaker_stats[name] = {
      turns: turns.filter((t) => t.speaker === name).length,
      word_count: mine.reduce((a, s) => a + wordCount(s.text), 0),
      dominant_emotion: mostFrequent(mine.map((s) => s.emotion)),
    };
  }

  const total_words = segments.reduce((a, s) => a + wordCount(s.text), 0);
  const total_duration_sec = Math.max(0, Math.round(Math.max(...segments.map((s) => s.end)) - Math.min(...segments.map((s) => s.start))));

  return {
    dominant_emotion: mostFrequent(segments.map((s) => s.emotion)),
    emotion_distribution: percentages(counts, segments.length),
    emotional_moments: segments
      .filter((s) => s.emotion !== "neutral")
      .slice(0, 5)
      .map((s) => ({ emotion: s.emotion, text: s.text.slice(0, 80), start: s.start })),
    top_topics: [],
    speaker_stats,
    discrepancies: [],
    total_words,
    speaking_pace_wpm: total_duration_sec > 0 ? Math.round(total_words / (total_duration_sec / 60)) : 0,
    total_duration_sec,
  };
}
