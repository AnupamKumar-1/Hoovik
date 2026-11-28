import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHybridService, LIMITS, RESULT_STATUS, MAX_SPLIT_DEPTH } from "./hybrid.js";
import { POLICIES, MODES } from "./policy.js";
import { ERROR_CODES } from "./errors.js";
import { checkPanelShape } from "./adapter.js";
import { prepareTranscript } from "./prepare.js";
import { createSerialQueue } from "./queue.js";
import { clearRecords, getRecords, recordRun, newRequestId } from "./telemetry.js";
import { shortMeeting, mediumMeeting, longMeeting, piiMeeting } from "../golden/index.js";
import { goodJson, truncatedOutput } from "../golden/modelOutputs.js";

const named = (name, message) => Object.assign(new Error(message), { name });
const aiError = (code, message) => Object.assign(new Error(`AI: ${message} (ai/${code})`), { name: "FirebaseError", code });
const unavailable = () => aiError("api-not-enabled", "Local LanguageModel API not available in this environment.");

const reply = (text, source = "on_device") => ({ response: { text: () => text, inferenceSource: source } });
const partialJson = (n = 1) => JSON.stringify({ summary: `Part ${n} summary.`, key_points: [`Point ${n}`], decisions: [{ text: `Decision ${n}` }], action_items: [{ task: `Task ${n}`, owner: null, deadline: null }] });

// A fake SDK model. `impl` receives (prompt, callIndex).
function fakeModel(impl, { init } = {}) {
  let n = 0;
  return {
    initializeDeviceModel: vi.fn(init ?? (async (cb) => { cb?.(0.5); cb?.(1); })),
    generateContent: vi.fn(async (prompt) => impl(prompt, n++)),
  };
}
const serviceWith = (models, extra = {}) => {
  const getModel = vi.fn(async (mode) => (models[mode] ? { status: "ready", model: models[mode] } : { status: "not-configured" }));
  const telemetry = { recordRun: vi.fn(recordRun), newRequestId };
  return { svc: createHybridService({ getModel, telemetry, isOnline: () => true, ...extra }), getModel, telemetry };
};
const run = (svc, o = {}) => svc.summarize({ segments: shortMeeting.segments, policy: POLICIES.LOCAL_ONLY, ...o });

beforeEach(() => clearRecords());

describe("policy enforcement before any model call", () => {
  it("local-only only ever requests the on-device mode and reports on-device", async () => {
    const local = fakeModel(() => reply(goodJson("short")));
    const { svc, getModel } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(getModel.mock.calls.map((c) => c[0])).toEqual([MODES.ONLY_ON_DEVICE]);
    expect(r.analysis.provenance).toMatchObject({ source: "on-device", policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE });
  });

  it("local-only refuses a cloud phase even with consent, without creating a model", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { phase: "cloud", cloudConsent: true });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.POLICY_VIOLATION);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("an unknown policy is refused without creating a model", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { policy: "yolo" });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("ask-before-cloud: a cloud phase without consent never reaches a model", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, phase: "cloud", cloudConsent: false });
    expect(r.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("cloud consent must be exactly true", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, phase: "cloud", cloudConsent: "yes" });
    expect(r.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
    expect(getModel).not.toHaveBeenCalled();
  });
});

describe("ask-before-cloud flow", () => {
  const cloud = () => fakeModel(() => reply(goodJson("short"), "in_cloud"));

  it("local unavailable -> consent required, cloud never touched; approval -> cloud result labelled cloud", async () => {
    const local = fakeModel(() => reply("unused"), { init: async () => { throw unavailable(); } });
    const cl = cloud();
    const { svc, getModel } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local, [MODES.ONLY_IN_CLOUD]: cl });

    const first = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD });
    expect(first.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
    expect(first.reason).toBe("local-unavailable");
    expect(getModel.mock.calls.map((c) => c[0])).toEqual([MODES.ONLY_ON_DEVICE]);
    expect(cl.generateContent).not.toHaveBeenCalled();

    const second = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, phase: "cloud", cloudConsent: true });
    expect(second.status).toBe(RESULT_STATUS.DONE);
    expect(second.analysis.provenance.source).toBe("cloud");
    expect(second.analysis.provenance.mode).toBe(MODES.ONLY_IN_CLOUD);
    expect(cl.generateContent).toHaveBeenCalledTimes(1);
  });

  it("local too long -> consent required with reason too-long", async () => {
    const local = fakeModel(() => { throw named("QuotaExceededError", "The input is too large."); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local }, { limits: { ...LIMITS, onDevice: { chunkChars: 24000, maxChunks: 1 } } });
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
    expect(r.reason).toBe("too-long");
  });

  it("local success never asks for consent and is labelled on-device", async () => {
    const local = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.source).toBe("on-device");
  });

  it("local-only with an unavailable model is unsupported, not a consent prompt", async () => {
    const local = fakeModel(() => reply("unused"), { init: async () => { throw unavailable(); } });
    const { svc, getModel } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.UNSUPPORTED);
    expect(r.error.code).toBe(ERROR_CODES.LOCAL_UNAVAILABLE);
    expect(getModel.mock.calls.every((c) => c[0] === MODES.ONLY_ON_DEVICE)).toBe(true);
  });
});

describe("source comes from the response, never from the requested mode", () => {
  it("auto-fallback requests prefer_on_device; a cloud response makes the result cloud and flags fallback", async () => {
    const m = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc, getModel, telemetry } = serviceWith({ [MODES.PREFER_ON_DEVICE]: m });
    const r = await run(svc, { policy: POLICIES.AUTO_FALLBACK });
    expect(getModel.mock.calls.map((c) => c[0])).toEqual([MODES.PREFER_ON_DEVICE]);
    expect(r.analysis.provenance.source).toBe("cloud");
    expect(telemetry.recordRun.mock.calls[0][0]).toMatchObject({ source: "cloud", fallback: true, success: true });
  });

  it("local-only whose response says in_cloud is rejected, with no analysis returned", async () => {
    const m = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe("CLOUD_UNDER_LOCAL_ONLY");
    expect(r.analysis).toBeUndefined();
  });

  it("a response with no reported source is unverifiable and rejected", async () => {
    const m = fakeModel(() => ({ response: { text: () => goodJson("short") } }));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe("UNVERIFIABLE_SOURCE");
  });

  it("mixed sources across chunk calls produce cloud", async () => {
    const m = fakeModel((_p, i) => reply(partialJson(i), i === 0 ? "on_device" : "in_cloud"));
    const { svc } = serviceWith({ [MODES.PREFER_ON_DEVICE]: m });
    const r = await run(svc, { policy: POLICIES.AUTO_FALLBACK, segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.source).toBe("cloud");
  });

  it("cloud-only is labelled cloud and is not counted as a fallback", async () => {
    const m = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc, telemetry } = serviceWith({ [MODES.ONLY_IN_CLOUD]: m });
    const r = await run(svc, { policy: POLICIES.CLOUD_ONLY });
    expect(r.analysis.provenance.source).toBe("cloud");
    expect(telemetry.recordRun.mock.calls[0][0].fallback).toBe(false);
  });
});

describe("result shape", () => {
  it("passes the panel shape check and carries decisions and action items", async () => {
    const m = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(checkPanelShape(r.analysis)).toEqual({ ok: true, problems: [] });
    expect(r.analysis.decisions.length).toBeGreaterThan(0);
    expect(r.analysis.action_items.map((a) => a.owner)).toContain("Marcus");
    expect(r.analysis.insights.total_words).toBeGreaterThan(0);
    expect(r.meta).toMatchObject({ source: "on-device", chunkCount: 1, failedChunks: 0 });
  });

  it("sends the instructions and the transcript in one user prompt", async () => {
    const m = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    await run(svc);
    const prompt = m.generateContent.mock.calls[0][0];
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("ONE JSON object");
    expect(prompt).toContain("Marcus: Backend is stable.");
  });

  it("emits progress and stage events", async () => {
    const m = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const events = [];
    await run(svc, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type + (e.stage ? `:${e.stage}` : ""))).toEqual(["stage:initialising", "init-progress", "init-progress", "stage:generating"]);
    expect(events.filter((e) => e.type === "init-progress").map((e) => e.value)).toEqual([0.5, 1]);
  });

  it("a throwing event listener does not break the run", async () => {
    const m = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { onEvent: () => { throw new Error("ui bug"); } });
    expect(r.status).toBe(RESULT_STATUS.DONE);
  });

  it("does not initialise a device model for cloud-only", async () => {
    const m = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: m });
    await run(svc, { policy: POLICIES.CLOUD_ONLY });
    expect(m.initializeDeviceModel).not.toHaveBeenCalled();
  });
});

describe("chunking and merging", () => {
  it("short and medium transcripts take one call", async () => {
    for (const g of [shortMeeting, mediumMeeting]) {
      const m = fakeModel(() => reply(partialJson()));
      const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
      const r = await run(svc, { segments: g.segments });
      expect(r.status).toBe(RESULT_STATUS.DONE);
      expect(m.generateContent).toHaveBeenCalledTimes(1);
    }
  });

  it("the long transcript makes one call per chunk plus one merge, and the merge prompt has no transcript text", async () => {
    const chunks = prepareTranscript(longMeeting.segments, { maxChunkChars: LIMITS.onDevice.chunkChars }).chunks.length;
    expect(chunks).toBe(2);
    const m = fakeModel((_p, i) => reply(i < chunks ? partialJson(i + 1) : JSON.stringify({ summary: "Merged.", key_points: ["k"], decisions: [{ text: "Merged decision" }], action_items: [] })));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(m.generateContent).toHaveBeenCalledTimes(chunks + 1);
    const mergePrompt = m.generateContent.mock.calls[chunks][0];
    expect(mergePrompt).toContain("Part 1 summary.");
    expect(mergePrompt).not.toContain(longMeeting.segments[5].text);
    expect(r.analysis.summary).toBe("Merged.");
    expect(r.analysis.provenance.chunkCount).toBe(chunks);
    expect(m.generateContent.mock.calls[0][0]).toContain("part 1 of 2");
  });

  it("a failing merge falls back to a deterministic merge and says so", async () => {
    const m = fakeModel((_p, i) => (i < 2 ? reply(partialJson(i + 1)) : reply("not json at all")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.validationIssues).toContain("MERGE_FALLBACK");
    expect(r.analysis.key_points).toEqual(["Point 1", "Point 2"]);
    expect(r.analysis.action_items.map((a) => a.task)).toEqual(["Task 1", "Task 2"]);
  });

  it("a throwing merge call also falls back when the error is tolerable", async () => {
    const m = fakeModel((_p, i) => { if (i < 2) return reply(partialJson(i + 1)); throw named("QuotaExceededError", "The input is too large."); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.validationIssues).toContain("MERGE_FALLBACK");
  });

  it("a fatal error during merge aborts the run", async () => {
    const m = fakeModel((_p, i) => { if (i < 2) return reply(partialJson(i + 1)); throw aiError("fetch-error", "Failed to fetch"); });
    const { svc } = serviceWith({ [MODES.PREFER_ON_DEVICE]: m });
    const r = await run(svc, { policy: POLICIES.AUTO_FALLBACK, segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.NETWORK);
  });

  it("one failing chunk does not kill the run; the failure is recorded, not hidden", async () => {
    const m = fakeModel((_p, i) => (i === 0 ? reply("garbage") : reply(partialJson(2))));
    const { svc, telemetry } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.meta.failedChunks).toBe(1);
    expect(r.analysis.provenance.validationIssues).toContain("CHUNK_FAILED");
    expect(m.generateContent).toHaveBeenCalledTimes(2); // one good part: no merge call
    expect(telemetry.recordRun.mock.calls[0][0]).toMatchObject({ failedChunks: 1, success: true });
  });

  it("all chunks malformed -> failed with MALFORMED_OUTPUT", async () => {
    const m = fakeModel(() => reply("garbage"));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.MALFORMED_OUTPUT);
  });

  it("more chunks than the limit -> too-long, with no model call", async () => {
    const m = fakeModel(() => reply(partialJson()));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { limits: { ...LIMITS, onDevice: { chunkChars: 24000, maxChunks: 1 } } });
    const r = await run(svc, { segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.TOO_LONG);
    expect(m.generateContent).not.toHaveBeenCalled();
  });

  it("cloud uses the larger chunk budget (one call for the long fixture)", async () => {
    const m = fakeModel(() => reply(partialJson(), "in_cloud"));
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: m });
    const r = await run(svc, { policy: POLICIES.CLOUD_ONLY, segments: longMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("too-long retries and interrupted sessions", () => {
  it("a QuotaExceededError splits the chunk and retries, then succeeds with a merge", async () => {
    const m = fakeModel((_p, i) => {
      if (i === 0) throw named("QuotaExceededError", "The input is too large.");
      return reply(partialJson(i));
    });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: mediumMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(m.generateContent.mock.calls.length).toBeGreaterThanOrEqual(4); // fail, two halves, merge
    expect(r.meta.chunkCount).toBe(2);
    expect(r.meta.failedChunks).toBe(0);
  });

  it("repeated too-long failures stop at the split depth and end as too-long", async () => {
    const m = fakeModel(() => { throw named("QuotaExceededError", "The input is too large."); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc, { segments: mediumMeeting.segments });
    expect(r.status).toBe(RESULT_STATUS.TOO_LONG);
    // 1 + 2 + 4 attempts at depths 0, 1, 2 for a transcript that always splits
    expect(m.generateContent).toHaveBeenCalledTimes(2 ** (MAX_SPLIT_DEPTH + 1) - 1);
  });

  it("an interrupted session (InvalidStateError) is retried once", async () => {
    const m = fakeModel((_p, i) => { if (i === 0) throw named("InvalidStateError", "The model execution session has been destroyed."); return reply(goodJson("short")); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
  });

  it("an interrupted session twice in a row is a failed chunk, not an infinite loop", async () => {
    const m = fakeModel(() => { throw named("InvalidStateError", "The model execution session has been destroyed."); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.SESSION_DESTROYED);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
  });

  it("on-device calls from two callers sharing one queue never overlap (strict serialisation)", async () => {
    let active = 0;
    let maxActive = 0;
    const m = fakeModel(async (_p, i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return reply(partialJson(i));
    });
    const shared = createSerialQueue();
    const a = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { queue: shared }).svc;
    const b = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { queue: shared }).svc;
    const results = await Promise.all([run(a, { segments: longMeeting.segments }), run(b, { segments: longMeeting.segments })]);
    expect(results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(m.generateContent.mock.calls.length).toBe(6);
    expect(maxActive).toBe(1);
  });
});

describe("failure handling", () => {
  it("malformed output -> failed (not a crash) and a retry works afterwards", async () => {
    let bad = true;
    const m = fakeModel(() => (bad ? reply(truncatedOutput("short")) : reply(goodJson("short"))));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const first = await run(svc);
    expect(first.status).toBe(RESULT_STATUS.FAILED);
    expect(first.error.code).toBe(ERROR_CODES.MALFORMED_OUTPUT);
    expect(svc.isBusy()).toBe(false);
    bad = false;
    expect((await run(svc)).status).toBe(RESULT_STATUS.DONE);
  });

  it("not configured -> unsupported", async () => {
    const { svc } = serviceWith({});
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.UNSUPPORTED);
    expect(r.error.code).toBe(ERROR_CODES.NOT_CONFIGURED);
  });

  it("a model creation error is classified", async () => {
    const getModel = vi.fn(async () => ({ status: "error", error: aiError("fetch-error", "Failed to fetch") }));
    const svc = createHybridService({ getModel, isOnline: () => true });
    const r = await run(svc, { policy: POLICIES.CLOUD_ONLY });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.NETWORK);
  });

  it("cloud while offline fails fast without calling the SDK", async () => {
    const m = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc, getModel } = serviceWith({ [MODES.ONLY_IN_CLOUD]: m }, { isOnline: () => false });
    const r = await run(svc, { policy: POLICIES.CLOUD_ONLY });
    expect(r.error.code).toBe(ERROR_CODES.OFFLINE);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("an empty transcript is rejected before any model call", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { segments: [{ speaker: "A", text: "   " }] });
    expect(r.error.code).toBe(ERROR_CODES.EMPTY_TRANSCRIPT);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("invalid input is rejected", async () => {
    const { svc } = serviceWith({});
    const r = await run(svc, { segments: 42 });
    expect(r.error.code).toBe(ERROR_CODES.INVALID_INPUT);
  });

  it("a non-recoverable error from a call aborts immediately", async () => {
    const m = fakeModel(() => { throw aiError("fetch-error", "Failed to fetch"); });
    const { svc } = serviceWith({ [MODES.PREFER_ON_DEVICE]: m });
    const r = await run(svc, { policy: POLICIES.AUTO_FALLBACK, segments: longMeeting.segments });
    expect(r.error.code).toBe(ERROR_CODES.NETWORK);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
  });

  it("a malformed SDK result (no response) is an unknown failure, not a crash", async () => {
    const m = fakeModel(() => ({}));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.UNKNOWN);
  });
});

describe("duplicate-request guard", () => {
  it("a second call during the first is refused and the first is unaffected", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = fakeModel(async () => { await gate; return reply(goodJson("short")); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m });
    const first = run(svc);
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.isBusy()).toBe(true);
    const second = await run(svc);
    expect(second.status).toBe(RESULT_STATUS.FAILED);
    expect(second.error.code).toBe(ERROR_CODES.BUSY);
    release();
    expect((await first).status).toBe(RESULT_STATUS.DONE);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
    expect(svc.isBusy()).toBe(false);
  });
});

describe("telemetry never contains transcript text", () => {
  const CANARY = "CANARY-Zebediah-Quillfeather-4417";
  const canarySegments = [
    { speaker: CANARY, start: 0, end: 4, text: `${CANARY} says the launch code is ${CANARY}.`, emotion: "neutral", emoji: "" },
    { speaker: "Priya", start: 4, end: 8, text: `Thanks ${CANARY}, I will send the notes on Friday.`, emotion: "neutral", emoji: "" },
  ];

  it("a successful run records metrics only", async () => {
    const m = fakeModel(() => reply(JSON.stringify({ summary: `About ${CANARY}.`, key_points: [CANARY], decisions: [], action_items: [] })));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { telemetry: { recordRun, newRequestId } });
    const r = await run(svc, { segments: canarySegments });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    const recs = getRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ policy: POLICIES.LOCAL_ONLY, source: "on-device", success: true, chunkCount: 1 });
    expect(JSON.stringify(recs)).not.toContain("CANARY");
  });

  it("a failed run whose SDK error echoes the transcript records only a code", async () => {
    const m = fakeModel(() => { throw new Error(`Model choked on ${CANARY}`); });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { telemetry: { recordRun, newRequestId } });
    const r = await run(svc, { segments: canarySegments });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(JSON.stringify(r)).not.toContain("CANARY");
    expect(JSON.stringify(getRecords())).not.toContain("CANARY");
    expect(getRecords()[0]).toMatchObject({ success: false, errorCode: ERROR_CODES.UNKNOWN });
  });

  it("records latency, sizes and a request id for each run", async () => {
    let t = 1000;
    const m = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { telemetry: { recordRun, newRequestId }, now: () => (t += 50) });
    await run(svc);
    const rec = getRecords()[0];
    expect(rec.requestId).toBeTruthy();
    expect(rec.latencyMs).toBeGreaterThan(0);
    expect(rec.inputChars).toBeGreaterThan(1000);
    expect(rec.outputChars).toBeGreaterThan(0);
    expect(rec.calls).toBe(1);
  });

  it("PII golden transcript: no canary PII appears in telemetry", async () => {
    const m = fakeModel(() => reply(partialJson()));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: m }, { telemetry: { recordRun, newRequestId } });
    await run(svc, { segments: piiMeeting.segments });
    const dump = JSON.stringify(getRecords());
    for (const c of piiMeeting.expected.piiCanaries ?? []) expect(dump).not.toContain(c);
  });
});

describe("default singleton", () => {
  it("getHybridService returns one shared instance", async () => {
    const { getHybridService } = await import("./hybrid.js");
    expect(getHybridService()).toBe(getHybridService());
  });
});
