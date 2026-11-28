// Adapter to Hoovik's stored summary format (`Transcript.aiSummary`, read by SummaryPanel).
// Adds decisions, action_items and a provenance block. Old summaries lack the new fields,
// so readers below always return safe defaults.

import { isKnownMode, isKnownPolicy, normalizeSource } from "./policy.js";

export const SCHEMA_VERSION = 1;

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/**
 * validated: value from validateSummary. insights: from computeInsights (or merged with model topics).
 * provenance: { source, policy, mode, chunkCount?, receipt? }. `issues` are reduced to codes only.
 */
export function toStoredSummary({ validated, insights, provenance, issues = [], now = () => new Date() }) {
  if (!validated || typeof validated.summary !== "string" || !validated.summary) throw new AdapterError("INVALID_SUMMARY", "A validated summary is required");
  const source = normalizeSource(provenance?.source);
  if (!source) throw new AdapterError("INVALID_PROVENANCE", "Provenance source must be on-device or cloud");
  if (!isKnownPolicy(provenance.policy)) throw new AdapterError("INVALID_PROVENANCE", "Provenance policy is unknown");
  if (!isKnownMode(provenance.mode)) throw new AdapterError("INVALID_PROVENANCE", "Provenance mode is unknown");
  return {
    summary: validated.summary,
    key_points: [...(validated.key_points || [])],
    insights: { ...(insights || {}) },
    decisions: (validated.decisions || []).map((d) => ({ ...d })),
    action_items: (validated.action_items || []).map((a) => ({ ...a })),
    provenance: {
      schemaVersion: SCHEMA_VERSION,
      source,
      policy: provenance.policy,
      mode: provenance.mode,
      chunkCount: Number.isInteger(provenance.chunkCount) ? provenance.chunkCount : 1,
      generatedAt: now().toISOString(),
      validationIssues: [...new Set(issues.map((i) => i.code))],
      receipt: provenance.receipt ?? null,
    },
  };
}

export const getDecisions = (a) => (Array.isArray(a?.decisions) ? a.decisions : []);
export const getActionItems = (a) => (Array.isArray(a?.action_items) ? a.action_items : []);
export const getProvenance = (a) => (a && typeof a.provenance === "object" && a.provenance !== null ? a.provenance : null);

// Fields SummaryPanel destructures from `insights`. A drift test keeps this list in sync with the viewer.
export const PANEL_INSIGHT_FIELDS = [
  "dominant_emotion", "emotion_distribution", "emotional_moments", "top_topics",
  "speaker_stats", "discrepancies", "total_words", "speaking_pace_wpm", "total_duration_sec",
];

const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Does this analysis satisfy what SummaryPanel relies on? Works for old and new summaries. */
export function checkPanelShape(a) {
  const problems = [];
  if (!isObj(a)) return { ok: false, problems: ["analysis is not an object"] };
  if (!isStr(a.summary) || !a.summary) problems.push("summary must be a non-empty string");
  if (a.key_points !== undefined && !(Array.isArray(a.key_points) && a.key_points.every(isStr))) problems.push("key_points must be an array of strings");
  const ins = a.insights;
  if (ins !== undefined) {
    if (!isObj(ins)) problems.push("insights must be an object");
    else {
      if (ins.dominant_emotion !== undefined && !isStr(ins.dominant_emotion)) problems.push("dominant_emotion must be a string");
      if (ins.emotion_distribution !== undefined && !(isObj(ins.emotion_distribution) && Object.values(ins.emotion_distribution).every(isNum))) problems.push("emotion_distribution must map to numbers");
      if (ins.top_topics !== undefined && !(Array.isArray(ins.top_topics) && ins.top_topics.every(isStr))) problems.push("top_topics must be an array of strings");
      if (ins.emotional_moments !== undefined && !(Array.isArray(ins.emotional_moments) && ins.emotional_moments.every((m) => isObj(m) && isStr(m.emotion) && isStr(m.text)))) problems.push("emotional_moments need string emotion and text");
      if (ins.speaker_stats !== undefined && !(isObj(ins.speaker_stats) && Object.values(ins.speaker_stats).every((s) => isObj(s) && isNum(s.turns) && isNum(s.word_count)))) problems.push("speaker_stats need numeric turns and word_count");
      if (ins.discrepancies !== undefined && !(Array.isArray(ins.discrepancies) && ins.discrepancies.every((d) => isObj(d) && isStr(d.participant) && isNum(d.at_sec) && isStr(d.said) && isStr(d.nlp_emotion) && isStr(d.live_emotion)))) problems.push("discrepancies need participant, at_sec, said, nlp_emotion, live_emotion");
      for (const k of ["total_words", "speaking_pace_wpm", "total_duration_sec"]) {
        if (ins[k] !== undefined && !isNum(ins[k])) problems.push(`${k} must be a number`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
