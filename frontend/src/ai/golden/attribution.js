// Label-integrity checks for golden fixtures. These verify that a hand-written
// label is consistent with the transcript. They do NOT measure model accuracy.
//
// attribution types for an expected action item:
//   explicit   - owner is named in the quote ("Marcus will redline ...")
//   self       - speaker of the quote's segment is the owner and uses first person ("I will ...")
//   contextual - quote does not name the owner; a EARLIER segment (contextQuote) addresses the
//                owner, and the quote's speaker is the owner (a reply like "Sure, I will take that").
//                Models that only look at the quote sentence will miss these.
//   none       - no owner stated anywhere (owner must be null)

import { findTimeMarkers } from "./deadlinePhrases.js";

export const ATTRIBUTION_TYPES = ["explicit", "self", "contextual", "none"];

export const norm = (s) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

const hasWord = (text, word) => new RegExp(`\\b${word.toLowerCase()}\\b`).test(norm(text));

export function findSegmentIndex(segments, quote) {
  const q = norm(quote);
  return segments.findIndex((s) => norm(s.text).includes(q));
}

/** Returns { ok, reason } for one expected action item against its transcript. */
export function checkAttribution(segments, item, ownerOverride = item.owner) {
  const att = item.attribution;
  if (!att || !ATTRIBUTION_TYPES.includes(att.type)) return { ok: false, reason: "missing or unknown attribution type" };

  const qi = findSegmentIndex(segments, item.quote);
  if (qi < 0) return { ok: false, reason: "quote not found in any single segment" };
  const speaker = segments[qi].speaker;
  const speakers = [...new Set(segments.map((s) => s.speaker))];

  if (att.type === "none") {
    if (ownerOverride !== null) return { ok: false, reason: "type none but an owner is set" };
    const named = speakers.filter((n) => hasWord(item.quote, n));
    return named.length ? { ok: false, reason: `quote names ${named.join(",")} but no owner expected` } : { ok: true };
  }
  if (ownerOverride === null) return { ok: false, reason: "owner is null but attribution is not none" };

  if (att.type === "explicit") {
    return hasWord(item.quote, ownerOverride) ? { ok: true } : { ok: false, reason: "owner not named in quote" };
  }
  if (att.type === "self") {
    if (speaker !== ownerOverride) return { ok: false, reason: `quote spoken by ${speaker}, not ${ownerOverride}` };
    return /\bi\b/.test(norm(item.quote)) ? { ok: true } : { ok: false, reason: "no first-person commitment in quote" };
  }
  // contextual
  if (!att.contextQuote) return { ok: false, reason: "contextual item needs contextQuote" };
  if (hasWord(item.quote, ownerOverride)) return { ok: false, reason: "contextual item's quote names the owner; use explicit" };
  const ci = findSegmentIndex(segments, att.contextQuote);
  if (ci < 0) return { ok: false, reason: "contextQuote not found" };
  if (ci >= qi) return { ok: false, reason: "context must come before the quote" };
  if (!hasWord(att.contextQuote, ownerOverride)) return { ok: false, reason: "context does not address the owner" };
  if (speaker !== ownerOverride) return { ok: false, reason: `reply spoken by ${speaker}, not ${ownerOverride}` };
  return { ok: true };
}

/**
 * Deadline label check.
 *  - non-null deadline: must appear in the quote.
 *  - null deadline: neither the quote, nor its whole segment, nor the contextual
 *    request turn may contain a HARD time marker (see deadlinePhrases.js).
 *    SOFT markers (once/after/by <x>/before <x>) do not fail, but are returned as warnings.
 */
export function checkDeadline(item, segments = []) {
  if (item.deadline !== null) {
    return hasWord(item.quote, item.deadline) ? { ok: true, warnings: [] } : { ok: false, reason: "deadline not in quote", warnings: [] };
  }
  const texts = [item.quote];
  const qi = findSegmentIndex(segments, item.quote);
  if (qi >= 0) texts.push(segments[qi].text);
  if (item.attribution?.contextQuote) {
    const ci = findSegmentIndex(segments, item.attribution.contextQuote);
    if (ci >= 0) texts.push(segments[ci].text);
  }
  const hard = new Set();
  const soft = new Set();
  for (const t of texts) {
    const m = findTimeMarkers(t);
    m.hard.forEach((x) => hard.add(x));
    m.soft.forEach((x) => soft.add(x));
  }
  if (hard.size) return { ok: false, reason: `null deadline but text has time marker(s): ${[...hard].join(", ")}`, warnings: [...soft] };
  return { ok: true, warnings: [...soft] };
}
