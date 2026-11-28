import { describe, it, expect } from "vitest";
import { summaryReducer, initialSummaryState, SUMMARY_STATES as S } from "./summaryMachine.js";

const step = (state, ...actions) => actions.reduce((s, a) => summaryReducer(s, a), state);
const running = () => step(initialSummaryState, { type: "RUN_STARTED" });
const err = { code: "X", message: "m" };

describe("summaryReducer", () => {
  it("starts idle", () => {
    expect(initialSummaryState.status).toBe(S.IDLE);
  });

  it("idle -> initialising -> generating -> done", () => {
    let s = running();
    expect(s.status).toBe(S.INITIALISING);
    s = step(s, { type: "INIT_PROGRESS", value: 0.4 });
    expect(s.progress).toBe(0.4);
    s = step(s, { type: "GENERATING", chunk: 1, total: 2 });
    expect(s).toMatchObject({ status: S.GENERATING, progress: null, chunk: { index: 1, total: 2 } });
    s = step(s, { type: "GENERATING", chunk: 2, total: 2 });
    expect(s.chunk).toEqual({ index: 2, total: 2 });
    s = step(s, { type: "RESULT", result: { status: "done", analysis: { summary: "x" } } });
    expect(s).toMatchObject({ status: S.DONE, analysis: { summary: "x" }, progress: null, chunk: null, error: null });
  });

  it("a merging event without a chunk keeps the current chunk info", () => {
    const s = step(running(), { type: "GENERATING", chunk: 2, total: 2 }, { type: "GENERATING", total: 2 });
    expect(s.chunk).toEqual({ index: 2, total: 2 });
  });

  it("clamps progress to 0..1 and ignores junk values", () => {
    expect(step(running(), { type: "INIT_PROGRESS", value: 7 }).progress).toBe(1);
    expect(step(running(), { type: "INIT_PROGRESS", value: -1 }).progress).toBe(0);
    expect(step(running(), { type: "INIT_PROGRESS", value: NaN }).progress).toBeNull();
    expect(step(running(), { type: "INIT_PROGRESS", value: "0.5" }).progress).toBeNull();
  });

  it.each([
    ["consent-required", { status: "consent-required", reason: "too-long", error: err }, S.CONSENT_REQUIRED],
    ["unsupported", { status: "unsupported", error: err }, S.UNSUPPORTED],
    ["too-long", { status: "too-long", error: err }, S.TOO_LONG],
    ["failed", { status: "failed", error: err }, S.FAILED],
  ])("%s result", (_n, result, expected) => {
    const s = step(running(), { type: "RESULT", result });
    expect(s.status).toBe(expected);
    expect(s.error).toEqual(err);
  });

  it("consent state carries the reason, defaulting to local-unavailable", () => {
    expect(step(running(), { type: "RESULT", result: { status: "consent-required", reason: "too-long" } }).consent).toEqual({ reason: "too-long" });
    expect(step(running(), { type: "RESULT", result: { status: "consent-required" } }).consent).toEqual({ reason: "local-unavailable" });
  });

  it("an unknown or empty result becomes a failed state with a message", () => {
    expect(step(running(), { type: "RESULT", result: undefined }).status).toBe(S.FAILED);
    expect(step(running(), { type: "RESULT", result: { status: "weird" } }).error.code).toBe("UNKNOWN");
  });

  it("failed -> retry -> initialising clears the old error", () => {
    const failed = step(running(), { type: "RESULT", result: { status: "failed", error: err } });
    const again = step(failed, { type: "RUN_STARTED" });
    expect(again).toMatchObject({ status: S.INITIALISING, error: null });
  });

  it("consent-required -> run again (approval) -> initialising -> done", () => {
    const c = step(running(), { type: "RESULT", result: { status: "consent-required" } });
    const s = step(c, { type: "RUN_STARTED" }, { type: "RESULT", result: { status: "done", analysis: {} } });
    expect(s.status).toBe(S.DONE);
    expect(s.consent).toBeNull();
  });

  it("declining consent returns to idle, and is ignored in any other state", () => {
    const c = step(running(), { type: "RESULT", result: { status: "consent-required" } });
    expect(step(c, { type: "DECLINE_CLOUD" })).toEqual(initialSummaryState);
    const done = step(running(), { type: "RESULT", result: { status: "done", analysis: {} } });
    expect(step(done, { type: "DECLINE_CLOUD" })).toBe(done);
  });

  it("late events after reset, or in settled states, are ignored", () => {
    const done = step(running(), { type: "RESULT", result: { status: "done", analysis: { a: 1 } } });
    expect(step(done, { type: "INIT_PROGRESS", value: 0.5 })).toBe(done);
    expect(step(done, { type: "GENERATING", chunk: 1, total: 1 })).toBe(done);
    expect(step(done, { type: "RESULT", result: { status: "failed" } })).toBe(done);
    const idle = step(running(), { type: "RESET" });
    expect(idle).toEqual(initialSummaryState);
    expect(step(idle, { type: "RESULT", result: { status: "done", analysis: {} } })).toBe(idle);
  });

  it("unknown actions leave state unchanged", () => {
    const s = running();
    expect(summaryReducer(s, { type: "NOPE" })).toBe(s);
  });
});
