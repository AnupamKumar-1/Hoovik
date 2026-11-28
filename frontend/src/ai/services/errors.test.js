import { describe, it, expect } from "vitest";
import { classifyError, ERROR_CODES, USER_MESSAGES } from "./errors.js";
import { PolicyError, POLICY_ERRORS } from "./policy.js";
import { TranscriptError } from "./prepare.js";

const named = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });
const aiError = (code, message) => Object.assign(new Error(`AI: ${message} (ai/${code})`), { name: "FirebaseError", code });

describe("classifyError: shapes observed in Part 1", () => {
  it("QuotaExceededError is too long", () => {
    expect(classifyError(named("QuotaExceededError", "The input is too large.", { code: 22 })).code).toBe(ERROR_CODES.TOO_LONG);
  });
  it("InvalidStateError is a destroyed session (retryable)", () => {
    expect(classifyError(named("InvalidStateError", "The model execution session has been destroyed.", { code: 11 })).code).toBe(ERROR_CODES.SESSION_DESTROYED);
  });
  it("matches by message when the name is lost", () => {
    expect(classifyError(new Error("The input is too large.")).code).toBe(ERROR_CODES.TOO_LONG);
    expect(classifyError(new Error("The model execution session has been destroyed.")).code).toBe(ERROR_CODES.SESSION_DESTROYED);
  });
});

describe("classifyError: SDK errors", () => {
  it.each([
    ["unsupported", "Inference mode is ONLY_ON_DEVICE, but an on-device model is not available."],
    ["unsupported", "Chrome AI requested for unsupported browser version."],
    ["api-not-enabled", "Local LanguageModel API not available in this environment."],
  ])("%s with an on-device message is local-unavailable", (code, msg) => {
    expect(classifyError(aiError(code, msg)).code).toBe(ERROR_CODES.LOCAL_UNAVAILABLE);
  });
  it("api-not-enabled without an on-device message is the cloud project setting", () => {
    expect(classifyError(aiError("api-not-enabled", "Firebase AI Logic API has not been used in project")).code).toBe(ERROR_CODES.CLOUD_NOT_ENABLED);
  });
  it("accepts a prefixed code", () => {
    expect(classifyError({ name: "FirebaseError", code: "ai/unsupported", message: "on-device model is not available" }).code).toBe(ERROR_CODES.LOCAL_UNAVAILABLE);
  });
  it("NotSupportedError and NotAllowedError are local-unavailable", () => {
    expect(classifyError(named("NotSupportedError", "x")).code).toBe(ERROR_CODES.LOCAL_UNAVAILABLE);
    expect(classifyError(named("NotAllowedError", "needs user activation")).code).toBe(ERROR_CODES.LOCAL_UNAVAILABLE);
  });
  it("fetch errors are network when online and offline when not", () => {
    expect(classifyError(aiError("fetch-error", "Failed to fetch"), { online: true }).code).toBe(ERROR_CODES.NETWORK);
    expect(classifyError(aiError("fetch-error", "Failed to fetch"), { online: false }).code).toBe(ERROR_CODES.OFFLINE);
    expect(classifyError(named("TypeError", "Failed to fetch"), { online: false }).code).toBe(ERROR_CODES.OFFLINE);
  });
  it("missing configuration codes are not-configured", () => {
    for (const c of ["no-api-key", "no-app-id", "no-project-id", "no-model"]) expect(classifyError(aiError(c, "x")).code).toBe(ERROR_CODES.NOT_CONFIGURED);
  });
  it("parse-failed is malformed output", () => {
    expect(classifyError(aiError("parse-failed", "x")).code).toBe(ERROR_CODES.MALFORMED_OUTPUT);
  });
  it("cloud token-limit messages are too long", () => {
    expect(classifyError(aiError("fetch-error", "The input token count exceeds the maximum number of tokens allowed")).code).toBe(ERROR_CODES.TOO_LONG);
  });
});

describe("classifyError: app errors and fallbacks", () => {
  it("policy errors", () => {
    expect(classifyError(new PolicyError(POLICY_ERRORS.CONSENT_REQUIRED, "x")).code).toBe(ERROR_CODES.CONSENT_REQUIRED);
    expect(classifyError(new PolicyError(POLICY_ERRORS.MODE_NOT_ALLOWED, "x")).code).toBe(ERROR_CODES.POLICY_VIOLATION);
    expect(classifyError(new PolicyError(POLICY_ERRORS.CLOUD_FORBIDDEN, "x")).code).toBe(ERROR_CODES.POLICY_VIOLATION);
  });
  it("transcript errors", () => {
    expect(classifyError(new TranscriptError("EMPTY_TRANSCRIPT", "x")).code).toBe(ERROR_CODES.EMPTY_TRANSCRIPT);
    expect(classifyError(new TranscriptError("INVALID_INPUT", "x")).code).toBe(ERROR_CODES.INVALID_INPUT);
  });
  it("unknown and nullish inputs never throw", () => {
    for (const v of [undefined, null, 42, "text", {}, new Error("boom")]) expect(classifyError(v).code).toBe(ERROR_CODES.UNKNOWN);
  });
  it("returns fixed user-safe text, never the raw message", () => {
    const r = classifyError(new Error("CANARY-RAW-TEXT-123"));
    expect(r.message).toBe(USER_MESSAGES.UNKNOWN);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  it("every code has a message", () => {
    for (const c of Object.values(ERROR_CODES)) expect(USER_MESSAGES[c]).toBeTruthy();
  });
});
