// Error classification for model calls. Pure logic, no SDK imports.
//
// Shapes below were observed in Part 1 (docs/hybrid-part1-findings.md) or read from the installed
// Firebase AI SDK (AIError.code is the bare code, e.g. "unsupported"; the message carries "(ai/<code>)"):
//   QuotaExceededError (DOMException)  "The input is too large."
//   InvalidStateError  (DOMException)  "The model execution session has been destroyed."
//   AIError unsupported / api-not-enabled with an on-device message (model or Prompt API unavailable)
// The unsupported-browser and offline shapes are still to be confirmed on real machines; the
// patterns below are deliberately broad and are covered by tests with those message texts.

import { POLICY_ERRORS } from "./policy.js";

export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  LOCAL_UNAVAILABLE: "LOCAL_UNAVAILABLE",
  TOO_LONG: "TOO_LONG",
  SESSION_DESTROYED: "SESSION_DESTROYED",
  OFFLINE: "OFFLINE",
  NETWORK: "NETWORK",
  CLOUD_NOT_ENABLED: "CLOUD_NOT_ENABLED",
  MALFORMED_OUTPUT: "MALFORMED_OUTPUT",
  POLICY_VIOLATION: "POLICY_VIOLATION",
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  EMPTY_TRANSCRIPT: "EMPTY_TRANSCRIPT",
  INVALID_INPUT: "INVALID_INPUT",
  BUSY: "BUSY",
  CONFIDENTIAL_BLOCKED: "CONFIDENTIAL_BLOCKED",
  UNKNOWN: "UNKNOWN",
});

// Fixed, user-safe wording. Raw SDK messages are never surfaced or stored, so a message that
// happens to echo prompt text cannot leak into the UI or telemetry.
export const USER_MESSAGES = Object.freeze({
  NOT_CONFIGURED: "AI features are not configured in this build.",
  LOCAL_UNAVAILABLE: "The on-device model is not available in this browser.",
  TOO_LONG: "This meeting is too long to analyse here.",
  SESSION_DESTROYED: "The on-device model session was interrupted.",
  OFFLINE: "You appear to be offline.",
  NETWORK: "The request could not reach the cloud service.",
  CLOUD_NOT_ENABLED: "The cloud AI service is not enabled for this project.",
  MALFORMED_OUTPUT: "The model returned an answer that could not be used.",
  POLICY_VIOLATION: "This action is not allowed by the selected privacy policy.",
  CONSENT_REQUIRED: "Sending this transcript to the cloud needs your approval.",
  EMPTY_TRANSCRIPT: "There is no transcript text to analyse.",
  INVALID_INPUT: "The transcript could not be read.",
  BUSY: "An analysis is already running.",
  CONFIDENTIAL_BLOCKED: "This meeting is confidential, so it can only be analysed on this device.",
  UNKNOWN: "Something went wrong while analysing the meeting.",
});

const LOCAL_MSG = /LanguageModel|on-device|on device|Chrome AI/i;
const TOO_LONG_MSG = /input is too large|input token count|exceeds the maximum number of tokens|too many tokens/i;
const DESTROYED_MSG = /session has been destroyed/i;

/**
 * Classify anything thrown while preparing, initialising or calling a model.
 * Returns { code, message } where message is fixed user-safe text.
 */
export function classifyError(err, { online = true } = {}) {
  const name = typeof err?.name === "string" ? err.name : "";
  const rawCode = typeof err?.code === "string" ? err.code.replace(/^ai\//, "") : err?.code;
  const msg = String(err?.message ?? "");
  const out = (code) => ({ code, message: USER_MESSAGES[code] });

  if (name === "PolicyError") {
    return out(rawCode === POLICY_ERRORS.CONSENT_REQUIRED ? ERROR_CODES.CONSENT_REQUIRED : ERROR_CODES.POLICY_VIOLATION);
  }
  if (name === "TranscriptError") {
    return out(rawCode === "EMPTY_TRANSCRIPT" ? ERROR_CODES.EMPTY_TRANSCRIPT : ERROR_CODES.INVALID_INPUT);
  }
  if (name === "QuotaExceededError" || TOO_LONG_MSG.test(msg)) return out(ERROR_CODES.TOO_LONG);
  if (name === "InvalidStateError" || DESTROYED_MSG.test(msg)) return out(ERROR_CODES.SESSION_DESTROYED);
  if ((rawCode === "unsupported" || rawCode === "api-not-enabled") && LOCAL_MSG.test(msg)) return out(ERROR_CODES.LOCAL_UNAVAILABLE);
  if (name === "NotSupportedError" || name === "NotAllowedError") return out(ERROR_CODES.LOCAL_UNAVAILABLE);
  if (rawCode === "api-not-enabled") return out(ERROR_CODES.CLOUD_NOT_ENABLED);
  if (["no-api-key", "no-app-id", "no-project-id", "no-model"].includes(rawCode)) return out(ERROR_CODES.NOT_CONFIGURED);
  if (rawCode === "fetch-error" || (name === "TypeError" && /failed to fetch|network/i.test(msg))) {
    return out(online ? ERROR_CODES.NETWORK : ERROR_CODES.OFFLINE);
  }
  if (rawCode === "parse-failed") return out(ERROR_CODES.MALFORMED_OUTPUT);
  return out(ERROR_CODES.UNKNOWN);
}
