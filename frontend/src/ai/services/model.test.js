import { describe, it, expect, vi, beforeEach } from "vitest";

const getFirebaseAI = vi.fn();
const getGenerativeModel = vi.fn();
const Schema = {
  string: (o) => ({ t: "string", ...o }),
  array: (o) => ({ t: "array", ...o }),
  object: (o) => ({ t: "object", ...o }),
};

vi.mock("../../lib/firebase.js", () => ({ getFirebaseAI: (...a) => getFirebaseAI(...a) }));
vi.mock("firebase/ai", () => ({ getGenerativeModel: (...a) => getGenerativeModel(...a), Schema }));

const { buildHybridParams, getModel, resetModelsForTests, DEFAULT_CLOUD_MODEL } = await import("./model.js");
const { MODES } = await import("./policy.js");

beforeEach(() => {
  vi.clearAllMocks();
  resetModelsForTests();
  getFirebaseAI.mockResolvedValue({ status: "ready", ai: { id: "ai" } });
  getGenerativeModel.mockImplementation((_ai, params) => ({ params }));
});

describe("buildHybridParams: only the configuration that applies to each mode", () => {
  it("only_on_device carries onDeviceParams and no cloud params", () => {
    const p = buildHybridParams(MODES.ONLY_ON_DEVICE, { Schema });
    expect(p.mode).toBe("only_on_device");
    expect(p.onDeviceParams.promptOptions.responseConstraint.required).toContain("summary");
    expect(p.onDeviceParams.createOptions.expectedInputs).toEqual([{ type: "text", languages: ["en"] }]);
    expect(p.inCloudParams).toBeUndefined();
  });
  it("only_in_cloud carries inCloudParams and no on-device params", () => {
    const p = buildHybridParams(MODES.ONLY_IN_CLOUD, { Schema, cloudModel: "m-1" });
    expect(p.mode).toBe("only_in_cloud");
    expect(p.inCloudParams.model).toBe("m-1");
    expect(p.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
    expect(p.inCloudParams.generationConfig.responseSchema.t).toBe("object");
    expect(p.onDeviceParams).toBeUndefined();
  });
  it("prefer_on_device carries both", () => {
    const p = buildHybridParams(MODES.PREFER_ON_DEVICE, { Schema });
    expect(p.onDeviceParams).toBeDefined();
    expect(p.inCloudParams.model).toBe(DEFAULT_CLOUD_MODEL);
  });
  it("rejects modes the service never uses", () => {
    expect(() => buildHybridParams(MODES.PREFER_IN_CLOUD, { Schema })).toThrow(/Unsupported/);
    expect(() => buildHybridParams("nope", { Schema })).toThrow(/Unsupported/);
  });
});

describe("getModel", () => {
  it("passes through not-configured without loading the SDK model API", async () => {
    getFirebaseAI.mockResolvedValue({ status: "not-configured", ai: null });
    expect(await getModel(MODES.ONLY_ON_DEVICE)).toEqual({ status: "not-configured" });
    expect(getGenerativeModel).not.toHaveBeenCalled();
  });
  it("reports an initialisation error", async () => {
    const error = new Error("init failed");
    getFirebaseAI.mockResolvedValue({ status: "error", ai: null, error });
    expect(await getModel(MODES.ONLY_ON_DEVICE)).toEqual({ status: "error", error });
  });
  it("creates one model per mode and reuses it", async () => {
    const a = await getModel(MODES.ONLY_ON_DEVICE);
    const b = await getModel(MODES.ONLY_ON_DEVICE);
    const c = await getModel(MODES.ONLY_IN_CLOUD);
    expect(a.status).toBe("ready");
    expect(b.model).toBe(a.model);
    expect(c.model).not.toBe(a.model);
    expect(getGenerativeModel).toHaveBeenCalledTimes(2);
  });
  it("shares one creation between concurrent callers", async () => {
    const [a, b] = await Promise.all([getModel(MODES.ONLY_ON_DEVICE), getModel(MODES.ONLY_ON_DEVICE)]);
    expect(a.model).toBe(b.model);
    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
  });
  it("uses the cloud model from the environment when set", async () => {
    const r = await getModel(MODES.ONLY_IN_CLOUD, { env: { VITE_FIREBASE_AI_CLOUD_MODEL: " custom-model " } });
    expect(r.model.params.inCloudParams.model).toBe("custom-model");
  });
  it("a failed creation is reported and can be retried", async () => {
    getGenerativeModel.mockImplementationOnce(() => { throw new Error("nope"); });
    const bad = await getModel(MODES.ONLY_ON_DEVICE);
    expect(bad.status).toBe("error");
    const good = await getModel(MODES.ONLY_ON_DEVICE);
    expect(good.status).toBe("ready");
  });
});
