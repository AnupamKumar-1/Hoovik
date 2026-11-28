// What would leave the device? Builds the before/after view shown ahead of any cloud call.
// Pure logic. The returned object holds the original text (needed to show the comparison locally)
// and must stay in memory: do not store it, log it or send it anywhere.

import { createRedactor, safeRedactionSummary, REDACTION_NOTE } from "./redact.js";
import { assessSensitivity, SENSITIVITY_NOTE } from "./sensitivity.js";
import { normalizeSegments } from "./prepare.js";

/**
 * The one place a transcript is redacted for the cloud, used by the hybrid service and the preview
 * so both always agree. Segments are normalised first (the same step the model input goes through),
 * then redacted. Anything that is not an array or string is passed through for the caller to reject.
 * Returns { original, redacted, redactor }.
 */
export function redactTranscript(segments, { names = [], terms = [] } = {}) {
  const redactor = createRedactor({ names, terms });
  if (typeof segments !== "string" && !Array.isArray(segments)) return { original: segments, redacted: segments, redactor };
  const original = normalizeSegments(typeof segments === "string" ? [{ speaker: "Unknown", start: 0, end: 0, text: segments }] : segments);
  return { original, redacted: redactor.redactSegments(original), redactor };
}

/**
 * segments: transcript segments (or a string). Returns
 *   { rows: [{ index, start, original: {speaker,text}, redacted: {speaker,text}, changed }],
 *     summary, sensitivity, changedRows, note, sensitivityNote }
 * Rows follow the same normalisation the model input goes through (empty and duplicate segments are
 * dropped), so the preview matches what the service would send.
 */
export function buildCloudPreview(segments, { names = [], terms = [] } = {}) {
  const { original, redacted, redactor } = redactTranscript(segments, { names, terms });
  const rows = original.map((o, i) => {
    const r = redacted[i];
    return {
      index: i,
      start: o.start,
      original: { speaker: o.speaker, text: o.text },
      redacted: { speaker: r.speaker, text: r.text },
      changed: o.speaker !== r.speaker || o.text !== r.text,
    };
  });
  return {
    rows,
    changedRows: rows.filter((r) => r.changed).length,
    summary: safeRedactionSummary(redactor.summary()),
    sensitivity: assessSensitivity(original),
    note: REDACTION_NOTE,
    sensitivityNote: SENSITIVITY_NOTE,
  };
}
