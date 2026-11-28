import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeApp = vi.fn(() => ({ name: "app" }));
const getApps = vi.fn(() => []);
const getApp = vi.fn(() => ({ name: "existing" }));
const getAI = vi.fn(() => ({ name: "ai" }));
class GoogleAIBackend {}

vi.mock("firebase/app", () => ({ initializeApp, getApps, getApp }));
vi.mock("firebase/ai", () => ({ getAI, GoogleAIBackend }));

const FULL = {
  VITE_FIREBASE_API_KEY: "k",
  VITE_FIREBASE_PROJECT_ID: "p",
  VITE_FIREBASE_APP_ID: "a",
  VITE_FIREBASE_AUTH_DOMAIN: " d.firebaseapp.com ",
};

let mod;
beforeEach(async () => {
  vi.clearAllMocks();
  getApps.mockReturnValue([]);
  mod = await import("./firebase.js");
  mod.resetFirebaseForTests();
});

describe("readFirebaseConfig", () => {
  it("reports not configured and lists the missing required keys when variables are absent", () => {
    const r = mod.readFirebaseConfig({});
    expect(r.configured).toBe(false);
    expect(r.missing).toEqual(["apiKey", "projectId", "appId"]);
  });
  it("treats blank and whitespace-only values as missing", () => {
    const r = mod.readFirebaseConfig({ ...FULL, VITE_FIREBASE_API_KEY: "   " });
    expect(r.configured).toBe(false);
    expect(r.missing).toEqual(["apiKey"]);
  });
  it("is configured with the three required keys and trims values", () => {
    const r = mod.readFirebaseConfig(FULL);
    expect(r.configured).toBe(true);
    expect(r.config.authDomain).toBe("d.firebaseapp.com");
  });
  it("tolerates a missing env object", () => {
    expect(mod.readFirebaseConfig(undefined).configured).toBe(false);
    expect(mod.isFirebaseConfigured({})).toBe(false);
    expect(mod.isFirebaseConfigured(FULL)).toBe(true);
  });
});

describe("getFirebaseAI", () => {
  it("importing the module does not load or initialise Firebase", () => {
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getAI).not.toHaveBeenCalled();
  });

  it("with no keys returns not-configured, does not throw and never touches the SDK", async () => {
    const r = await mod.getFirebaseAI({});
    expect(r).toEqual({ status: "not-configured", ai: null });
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getAI).not.toHaveBeenCalled();
  });

  it("with keys initialises once and reuses the instance across calls", async () => {
    const [a, b, c] = await Promise.all([mod.getFirebaseAI(FULL), mod.getFirebaseAI(FULL), mod.getFirebaseAI(FULL)]);
    expect(a.status).toBe("ready");
    expect(b.ai).toBe(a.ai);
    expect(c.ai).toBe(a.ai);
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(getAI).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledWith({ apiKey: "k", projectId: "p", appId: "a", authDomain: "d.firebaseapp.com" });
  });

  it("reuses an already-initialised Firebase app instead of creating a second", async () => {
    getApps.mockReturnValue([{ name: "existing" }]);
    const r = await mod.getFirebaseAI(FULL);
    expect(r.status).toBe("ready");
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getApp).toHaveBeenCalledTimes(1);
  });

  it("returns status error instead of throwing, and allows a retry", async () => {
    getAI.mockImplementationOnce(() => { throw new Error("boom"); });
    const first = await mod.getFirebaseAI(FULL);
    expect(first.status).toBe("error");
    expect(first.error.message).toBe("boom");
    const second = await mod.getFirebaseAI(FULL);
    expect(second.status).toBe("ready");
  });
});
