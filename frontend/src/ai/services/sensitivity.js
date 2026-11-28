// Rule-based sensitivity score for a transcript. Pure logic, no model, no storage.
//
// The score comes from two things only: how many redactable items the redaction rules find
// (contact details, ids, amounts, links) and how many words from a starter keyword list appear.
// It is a heuristic for choosing a safer default, never a classification of what is really in the
// meeting. The reasons it returns are counts and category names, never transcript text.

import { createRedactor } from "./redact.js";
import { POLICIES } from "./policy.js";

export const LEVELS = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });

// Starter lists covering legal, healthcare, HR and finance. Replace or extend them once the target
// user is chosen; the thresholds below do not depend on the exact words.
export const STRONG_KEYWORDS = Object.freeze([
  "privileged", "attorney-client", "attorney client", "lawsuit", "litigation", "settlement", "subpoena", "nda",
  "diagnosis", "patient", "medical record", "prescription", "hipaa", "therapy", "medication",
  "disciplinary", "termination", "harassment", "grievance", "redundancy", "layoff", "layoffs",
  "salary", "compensation", "social security", "passport", "confidential", "classified",
]);
export const GENERAL_KEYWORDS = Object.freeze([
  "contract", "claim", "claimant", "hearing", "counsel", "legal", "acquisition", "merger", "board", "investor",
  "performance review", "payroll", "invoice", "audit",
]);

// Weight per redaction category occurrence.
const WEIGHTS = Object.freeze({ id: 3, phone: 2, email: 2, money: 1, url: 1 });
const STRONG_CAP = 6; // strong keyword occurrences counted
const GENERAL_CAP = 3; // general keyword occurrences counted

export const THRESHOLDS = Object.freeze({ medium: 5, high: 12 });

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (list) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...list].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
const STRONG_RE = wordRe(STRONG_KEYWORDS);
const GENERAL_RE = wordRe(GENERAL_KEYWORDS);

const textOf = (input) => {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.map((s) => (s && typeof s.text === "string" ? s.text : "")).join("\n");
};

export function levelForScore(score) {
  if (score >= THRESHOLDS.high) return LEVELS.HIGH;
  if (score >= THRESHOLDS.medium) return LEVELS.MEDIUM;
  return LEVELS.LOW;
}

/**
 * Score a transcript (segments array or string).
 * Returns { level, score, redactable, keywords: { strong, general }, reasons }.
 * Any id-like number forces at least "medium".
 */
export function assessSensitivity(input) {
  const text = textOf(input);
  const redactor = createRedactor();
  redactor.redactText(text);
  const { hits } = redactor.summary();

  let score = 0;
  for (const [cat, w] of Object.entries(WEIGHTS)) score += (hits[cat] || 0) * w;
  const strong = (text.match(STRONG_RE) || []).length;
  const general = (text.match(GENERAL_RE) || []).length;
  score += Math.min(strong, STRONG_CAP) * 3 + Math.min(general, GENERAL_CAP);

  let level = levelForScore(score);
  if (hits.id > 0 && level === LEVELS.LOW) level = LEVELS.MEDIUM;

  const redactable = Object.fromEntries(Object.keys(WEIGHTS).map((c) => [c, hits[c] || 0]));
  const reasons = [];
  if (redactable.id) reasons.push(`${redactable.id} id-like number${redactable.id === 1 ? "" : "s"}`);
  if (redactable.phone) reasons.push(`${redactable.phone} phone number${redactable.phone === 1 ? "" : "s"}`);
  if (redactable.email) reasons.push(`${redactable.email} email address${redactable.email === 1 ? "" : "es"}`);
  if (redactable.money) reasons.push(`${redactable.money} money amount${redactable.money === 1 ? "" : "s"}`);
  if (redactable.url) reasons.push(`${redactable.url} link${redactable.url === 1 ? "" : "s"}`);
  if (strong) reasons.push("words linked to confidential topics");
  else if (general) reasons.push("words linked to legal or business topics");

  return { level, score, redactable, keywords: { strong, general }, reasons };
}

/**
 * Which policy to preselect, and whether the cloud option needs a warning.
 *  - high sensitivity preselects local-only, unless the user has explicitly chosen a policy;
 *  - medium and high both show a warning before cloud is offered.
 * `preferred` is the policy the user (or the app default) would otherwise use.
 */
export function recommendPolicy({ level, preferred = POLICIES.ASK_BEFORE_CLOUD, userChose = false } = {}) {
  const warnCloud = level === LEVELS.HIGH || level === LEVELS.MEDIUM;
  if (level === LEVELS.HIGH && !userChose) {
    return { policy: POLICIES.LOCAL_ONLY, defaulted: preferred !== POLICIES.LOCAL_ONLY, warnCloud };
  }
  return { policy: preferred, defaulted: false, warnCloud };
}

export const SENSITIVITY_NOTE = "Estimated from simple rules. It can miss sensitive content and can flag harmless content.";
