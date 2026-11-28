import { describe, it, expect, vi } from "vitest";

// Redaction itself breaks: nothing may be sent, and the original text must never be used instead.
vi.mock("./cloudPreview.js", () => ({
  redactTranscript: () => {
    throw new Error("redaction exploded");
  },
}));

import { createHybridService, RESULT_STATUS } from "./hybrid.js";
import { POLICIES, MODES } from "./policy.js";
import { newRequestId } from "./telemetry.js";
import { piiMeeting } from "../golden/index.js";

describe("redaction failure", () => {
  it("a cloud run is refused without creating a model or sending anything", async () => {
    const generateContent = vi.fn();
    const getModel = vi.fn(async () => ({ status: "ready", model: { generateContent } }));
    const svc = createHybridService({ getModel, telemetry: { recordRun: vi.fn(), newRequestId }, isOnline: () => true });
    const r = await svc.summarize({ segments: piiMeeting.segments, policy: POLICIES.CLOUD_ONLY });
    expect(r.status).toBe(RESULT_STATUS.FAILED);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(getModel).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a local-only run does not depend on redaction at all", async () => {
    const model = {
      initializeDeviceModel: vi.fn(async () => {}),
      generateContent: vi.fn(async () => ({ response: { text: () => JSON.stringify({ summary: "ok", key_points: [], decisions: [], action_items: [] }), inferenceSource: "on_device" } })),
    };
    const getModel = vi.fn(async (mode) => (mode === MODES.ONLY_ON_DEVICE ? { status: "ready", model } : { status: "not-configured" }));
    const svc = createHybridService({ getModel, telemetry: { recordRun: vi.fn(), newRequestId }, isOnline: () => true });
    const r = await svc.summarize({ segments: piiMeeting.segments, policy: POLICIES.LOCAL_ONLY });
    expect(r.status).toBe(RESULT_STATUS.DONE);
  });
});
