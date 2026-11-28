import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHybridService, RESULT_STATUS } from "./hybrid.js";
import { POLICIES, MODES } from "./policy.js";
import { clearRecords, getRecords, recordRun, newRequestId } from "./telemetry.js";
import { redactTranscript } from "./cloudPreview.js";
import { piiMeeting, shortMeeting } from "../golden/index.js";
import { PII_CANARIES } from "../golden/piiMeeting.js";

const reply = (text, source) => ({ response: { text: () => text, inferenceSource: source } });

// Records every prompt it is sent. `answer(prompt)` builds the JSON text to return.
function recordingModel(answer, source) {
  const prompts = [];
  return {
    prompts,
    initializeDeviceModel: vi.fn(async () => {}),
    generateContent: vi.fn(async (prompt) => {
      prompts.push(prompt);
      return reply(answer(prompt), source);
    }),
  };
}
const serviceWith = (models, extra = {}) => {
  const getModel = vi.fn(async (mode) => (models[mode] ? { status: "ready", model: models[mode] } : { status: "not-configured" }));
  const telemetry = { recordRun: vi.fn(recordRun), newRequestId };
  return { svc: createHybridService({ getModel, telemetry, isOnline: () => true, ...extra }), getModel, telemetry };
};
const run = (svc, o = {}) => svc.summarize({ segments: piiMeeting.segments, policy: POLICIES.CLOUD_ONLY, ...o });

// Placeholders as the service will assign them (same function, same input, same order).
const { redacted } = redactTranscript(piiMeeting.segments);
const MARCUS = redacted[1].speaker; // speaker of "Her direct line is ..." (second turn)
const AMOUNT = redacted[3].text.match(/<AMOUNT_\d+>/)[0];

const answerWithPlaceholders = () =>
  JSON.stringify({
    summary: `The team discussed an offer of ${AMOUNT} and agreed on next steps.`,
    key_points: [`${MARCUS} will follow up`],
    decisions: [{ text: "reject the first offer and counter above the proposed figure" }],
    action_items: [{ task: "send the counter proposal", owner: MARCUS, deadline: "Thursday" }],
  });

beforeEach(() => clearRecords());

describe("redaction before any cloud call", () => {
  it("cloud-only: the prompt contains placeholders and none of the PII canaries", async () => {
    const cloud = recordingModel(answerWithPlaceholders, "in_cloud");
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: cloud });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(cloud.prompts.length).toBe(1);
    for (const canary of PII_CANARIES) expect(cloud.prompts[0], canary).not.toContain(canary);
    expect(cloud.prompts[0]).toContain("<EMAIL_1>");
    expect(cloud.prompts[0]).toContain(MARCUS);
    expect(cloud.prompts[0]).toContain("by Thursday"); // deadlines stay groundable
  });

  it("restores the originals in the result, on this device", async () => {
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: recordingModel(answerWithPlaceholders, "in_cloud") });
    const r = await run(svc);
    expect(r.analysis.summary).toContain("$48,500");
    expect(r.analysis.summary).not.toMatch(/<[A-Z]+_\d+>/);
    expect(r.analysis.key_points[0]).toBe("Marcus will follow up");
    expect(r.analysis.action_items[0]).toMatchObject({ task: "send the counter proposal", owner: "Marcus", deadline: "Thursday" });
  });

  it("insights and speaker statistics come from the original segments, never from placeholders", async () => {
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: recordingModel(answerWithPlaceholders, "in_cloud") });
    const r = await run(svc);
    expect(Object.keys(r.analysis.insights.speaker_stats).sort()).toEqual(["Dev", "Elena", "Marcus", "Priya"]);
    expect(JSON.stringify(r.analysis.insights)).not.toMatch(/<[A-Z]+_\d+>/);
  });

  it("auto-fallback can reach the cloud, so its prompt is redacted even when the device answers", async () => {
    const m = recordingModel(answerWithPlaceholders, "on_device");
    const { svc } = serviceWith({ [MODES.PREFER_ON_DEVICE]: m });
    const r = await run(svc, { policy: POLICIES.AUTO_FALLBACK });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.source).toBe("on-device");
    for (const canary of PII_CANARIES) expect(m.prompts[0], canary).not.toContain(canary);
    expect(r.analysis.summary).toContain("$48,500");
  });

  it("local-only never redacts (nothing leaves the device) and records no redaction", async () => {
    const local = recordingModel(() => JSON.stringify({ summary: "A local summary.", key_points: [], decisions: [], action_items: [] }), "on_device");
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc, { policy: POLICIES.LOCAL_ONLY });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(local.prompts[0]).toContain("maria.lopez@northwind-legal.example");
    expect(r.analysis.provenance.redaction).toBeNull();
    expect(getRecords()[0].redacted).toBeUndefined();
  });

  it("ask-before-cloud: the local phase sees the original text, the approved cloud phase only redacted text", async () => {
    const local = recordingModel(() => "{}", "on_device");
    local.initializeDeviceModel = vi.fn(async () => {
      throw Object.assign(new Error("AI: Local LanguageModel API not available (ai/api-not-enabled)"), { name: "FirebaseError", code: "api-not-enabled" });
    });
    const cloud = recordingModel(answerWithPlaceholders, "in_cloud");
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local, [MODES.ONLY_IN_CLOUD]: cloud });
    const ask = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD });
    expect(ask.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
    expect(cloud.prompts.length).toBe(0);
    const done = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, phase: "cloud", cloudConsent: true });
    expect(done.status).toBe(RESULT_STATUS.DONE);
    for (const canary of PII_CANARIES) expect(cloud.prompts[0], canary).not.toContain(canary);
  });

  it("every chunk prompt of a multi-chunk cloud run is redacted, and so is the merge prompt", async () => {
    const partial = (n) => JSON.stringify({ summary: `Part ${n} covered ${AMOUNT}.`, key_points: [], decisions: [], action_items: [{ task: "send it", owner: MARCUS, deadline: null }] });
    let n = 0;
    const cloud = recordingModel(() => partial(++n), "in_cloud");
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: cloud }, { limits: { onDevice: { chunkChars: 24000, maxChunks: 6 }, cloud: { chunkChars: 300, maxChunks: 50 } } });
    const r = await run(svc);
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(cloud.prompts.length).toBeGreaterThan(2); // several chunks plus the merge
    for (const prompt of cloud.prompts) for (const canary of PII_CANARIES) expect(prompt, canary).not.toContain(canary);
    expect(r.analysis.summary).not.toMatch(/<[A-Z]+_\d+>/);
  });

  it("provenance and telemetry carry counts only", async () => {
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: recordingModel(answerWithPlaceholders, "in_cloud") });
    const r = await run(svc);
    const red = r.analysis.provenance.redaction;
    expect(red).toMatchObject({ applied: true });
    expect(red.total).toBeGreaterThan(5);
    expect(red.byCategory).toMatchObject({ email: 1, phone: 1, money: 1, url: 1 });
    const rec = getRecords()[0];
    expect(rec).toMatchObject({ redacted: true });
    expect(rec.redactedItems).toBe(red.total);
    const dump = JSON.stringify([r.analysis.provenance, getRecords()]);
    for (const canary of PII_CANARIES) expect(dump, canary).not.toContain(canary);
  });

  it("caller-supplied terms are redacted too", async () => {
    const cloud = recordingModel(answerWithPlaceholders, "in_cloud");
    const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: cloud });
    await run(svc, { segments: shortMeeting.segments, redaction: { terms: ["pricing page"] } });
    expect(cloud.prompts[0]).not.toContain("pricing page");
    expect(cloud.prompts[0]).toContain("<TERM_1>");
  });

  it("an invalid transcript still fails the same way under a cloud policy", async () => {
    const { svc, getModel } = serviceWith({ [MODES.ONLY_IN_CLOUD]: recordingModel(() => "{}", "in_cloud") });
    expect((await run(svc, { segments: [] })).error.code).toBe("EMPTY_TRANSCRIPT");
    expect((await run(svc, { segments: 42 })).error.code).toBe("INVALID_INPUT");
    expect(getModel).not.toHaveBeenCalled();
  });
});
