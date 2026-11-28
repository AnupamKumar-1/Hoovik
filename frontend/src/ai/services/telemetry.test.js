import { describe, it, expect, beforeEach, vi } from "vitest";
import { sanitizeRecord, recordRun, getRecords, clearRecords, subscribe, newRequestId } from "./telemetry.js";

const CANARY = "CANARY-Zebediah-Quillfeather-4417";

beforeEach(() => clearRecords());

describe("telemetry sanitiser", () => {
  it("keeps whitelisted metrics", () => {
    const r = sanitizeRecord({ requestId: "abc-123", source: "on-device", policy: "local-only", mode: "only_on_device", phase: "local", latencyMs: 12.4, inputChars: 900, outputChars: 300, chunkCount: 2, failedChunks: 0, calls: 3, success: true, fallback: false, errorCode: "TOO_LONG", status: "done" });
    expect(r).toMatchObject({ requestId: "abc-123", source: "on-device", latencyMs: 12, chunkCount: 2, success: true, fallback: false, errorCode: "TOO_LONG" });
  });

  it("drops unknown keys, free text, objects and non-finite numbers", () => {
    const r = sanitizeRecord({ text: CANARY, transcript: CANARY, speaker: CANARY, error: new Error(CANARY), errorCode: `bad code ${CANARY}`, source: { x: CANARY }, latencyMs: NaN, inputChars: Infinity, success: "yes" });
    expect(r).toEqual({});
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });

  it("rejects strings that are not short identifiers (spaces, long text)", () => {
    expect(sanitizeRecord({ errorCode: "has space" })).toEqual({});
    expect(sanitizeRecord({ errorCode: "x".repeat(49) })).toEqual({});
    expect(sanitizeRecord({ errorCode: "OK_CODE" })).toEqual({ errorCode: "OK_CODE" });
  });

  it("handles non-objects", () => {
    expect(sanitizeRecord(null)).toEqual({});
    expect(sanitizeRecord("x")).toEqual({});
  });
});

describe("telemetry store", () => {
  it("stores sanitised records and returns copies", () => {
    recordRun({ policy: "local-only", text: CANARY, success: true });
    const a = getRecords();
    expect(a).toEqual([{ policy: "local-only", success: true }]);
    a[0].policy = "changed";
    expect(getRecords()[0].policy).toBe("local-only");
    expect(JSON.stringify(getRecords())).not.toContain("CANARY");
  });

  it("caps the number of records", () => {
    for (let i = 0; i < 250; i++) recordRun({ calls: i });
    const recs = getRecords();
    expect(recs).toHaveLength(200);
    expect(recs[199].calls).toBe(249);
  });

  it("notifies subscribers, supports unsubscribe, survives a throwing listener", () => {
    const fn = vi.fn();
    const bad = vi.fn(() => { throw new Error("x"); });
    const off = subscribe(fn);
    subscribe(bad);
    recordRun({ calls: 1 });
    expect(fn).toHaveBeenCalledWith({ calls: 1 });
    off();
    recordRun({ calls: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getRecords()).toHaveLength(2);
  });

  it("request ids are unique identifiers that pass the sanitiser", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(sanitizeRecord({ requestId: a })).toEqual({ requestId: a });
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      const id = newRequestId();
      expect(id).toMatch(/^req-/);
      expect(sanitizeRecord({ requestId: id })).toEqual({ requestId: id });
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
});
