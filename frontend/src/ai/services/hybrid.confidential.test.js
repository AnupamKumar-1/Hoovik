import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHybridService, RESULT_STATUS } from "./hybrid.js";
import { POLICIES, MODES } from "./policy.js";
import { ERROR_CODES } from "./errors.js";
import { clearRecords, recordRun, newRequestId } from "./telemetry.js";
import { shortMeeting } from "../golden/index.js";
import { goodJson } from "../golden/modelOutputs.js";

const reply = (text, source = "on_device") => ({ response: { text: () => text, inferenceSource: source } });
const aiError = (code, message) => Object.assign(new Error(`AI: ${message} (ai/${code})`), { name: "FirebaseError", code });
function fakeModel(impl, { init } = {}) {
  return { initializeDeviceModel: vi.fn(init ?? (async () => {})), generateContent: vi.fn(async (p) => impl(p)) };
}
const serviceWith = (models) => {
  const getModel = vi.fn(async (mode) => (models[mode] ? { status: "ready", model: models[mode] } : { status: "not-configured" }));
  const witness = { start: vi.fn(() => ({ stop: () => ({ requests: [], methods: { fetch: true } }) })) };
  return { svc: createHybridService({ getModel, telemetry: { recordRun: vi.fn(recordRun), newRequestId }, isOnline: () => true, witness }), getModel, witness };
};
const run = (svc, o = {}) => svc.summarize({ segments: shortMeeting.segments, policy: POLICIES.LOCAL_ONLY, ...o });

beforeEach(() => clearRecords());

describe("confidential meetings never reach a cloud-capable mode", () => {
  it.each([
    [POLICIES.CLOUD_ONLY, {}],
    [POLICIES.AUTO_FALLBACK, {}],
    [POLICIES.ASK_BEFORE_CLOUD, { phase: "cloud", cloudConsent: true }],
  ])("%s with privacy=confidential is blocked before redaction, the witness or any model", async (policy, extra) => {
    const cloud = fakeModel(() => reply(goodJson("short"), "in_cloud"));
    const { svc, getModel, witness } = serviceWith({ [MODES.ONLY_IN_CLOUD]: cloud, [MODES.PREFER_ON_DEVICE]: cloud });
    const r = await run(svc, { policy, privacy: "confidential", ...extra });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe(ERROR_CODES.CONFIDENTIAL_BLOCKED);
    expect(getModel).not.toHaveBeenCalled();
    expect(witness.start).not.toHaveBeenCalled();
    expect(cloud.generateContent).not.toHaveBeenCalled();
  });

  it("confidential: true works the same as privacy=confidential", async () => {
    const { svc, getModel } = serviceWith({});
    const r = await run(svc, { policy: POLICIES.CLOUD_ONLY, confidential: true });
    expect(r.error.code).toBe(ERROR_CODES.CONFIDENTIAL_BLOCKED);
    expect(getModel).not.toHaveBeenCalled();
  });

  it("is fail-safe: an unknown or mistyped privacy value is treated as confidential", async () => {
    for (const privacy of ["Confidential", "secret", "", 5, false]) {
      const { svc, getModel } = serviceWith({});
      const r = await run(svc, { policy: POLICIES.CLOUD_ONLY, privacy });
      expect(r.error?.code, String(privacy)).toBe(ERROR_CODES.CONFIDENTIAL_BLOCKED);
      expect(getModel).not.toHaveBeenCalled();
    }
  });

  it("privacy=standard or no privacy value keeps the old behaviour", async () => {
    for (const extra of [{ privacy: "standard" }, {}]) {
      const cloud = fakeModel(() => reply(goodJson("short"), "in_cloud"));
      const { svc } = serviceWith({ [MODES.ONLY_IN_CLOUD]: cloud });
      const r = await run(svc, { policy: POLICIES.CLOUD_ONLY, ...extra });
      expect(r.status).toBe(RESULT_STATUS.DONE);
      expect(r.meta.source).toBe("cloud");
    }
  });

  it("local-only still works for a confidential meeting and reports on-device", async () => {
    const local = fakeModel(() => reply(goodJson("short")));
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc, { policy: POLICIES.LOCAL_ONLY, privacy: "confidential" });
    expect(r.status).toBe(RESULT_STATUS.DONE);
    expect(r.analysis.provenance.source).toBe("on-device");
  });

  it("ask-before-cloud + confidential: local unavailable is unsupported, never a consent prompt", async () => {
    const local = fakeModel(() => reply("unused"), { init: async () => { throw aiError("api-not-enabled", "Local LanguageModel API not available in this environment."); } });
    const { svc, getModel } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, privacy: "confidential" });
    expect(r.status).toBe(RESULT_STATUS.UNSUPPORTED);
    expect(getModel.mock.calls.map((c) => c[0])).toEqual([MODES.ONLY_ON_DEVICE]);
  });

  it("ask-before-cloud + standard keeps the consent prompt", async () => {
    const local = fakeModel(() => reply("unused"), { init: async () => { throw aiError("api-not-enabled", "Local LanguageModel API not available in this environment."); } });
    const { svc } = serviceWith({ [MODES.ONLY_ON_DEVICE]: local });
    const r = await run(svc, { policy: POLICIES.ASK_BEFORE_CLOUD, privacy: "standard" });
    expect(r.status).toBe(RESULT_STATUS.CONSENT_REQUIRED);
  });

  it("telemetry records the block as a failure with the error code and no source", async () => {
    const { svc } = serviceWith({});
    const recordRunSpy = vi.fn(recordRun);
    const svc2 = createHybridService({ getModel: vi.fn(), telemetry: { recordRun: recordRunSpy, newRequestId }, isOnline: () => true });
    await run(svc2, { policy: POLICIES.CLOUD_ONLY, privacy: "confidential" });
    expect(recordRunSpy.mock.calls[0][0]).toMatchObject({ success: false, errorCode: ERROR_CODES.CONFIDENTIAL_BLOCKED });
    expect(svc).toBeTruthy();
  });
});
