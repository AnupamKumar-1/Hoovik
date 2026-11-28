import { describe, it, expect } from "vitest";
import {
  POLICIES, MODES, SOURCES, POLICY_INFO, PolicyError, POLICY_ERRORS,
  checkMode, assertModeAllowed, modeFor, normalizeSource, auditSource, combineSources, canReachCloud, isKnownMode, isKnownPolicy,
} from "./policy.js";

const CLOUD_MODES = [MODES.ONLY_IN_CLOUD, MODES.PREFER_IN_CLOUD, MODES.PREFER_ON_DEVICE];

describe("policy: local-only", () => {
  it.each(CLOUD_MODES)("rejects %s even with consent", (mode) => {
    const r = checkMode(POLICIES.LOCAL_ONLY, mode, { cloudConsent: true });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(POLICY_ERRORS.MODE_NOT_ALLOWED);
  });
  it("allows only_on_device", () => {
    expect(checkMode(POLICIES.LOCAL_ONLY, MODES.ONLY_ON_DEVICE).allowed).toBe(true);
  });
  it("never has a cloud phase", () => {
    expect(() => modeFor(POLICIES.LOCAL_ONLY, "cloud")).toThrowError(expect.objectContaining({ code: POLICY_ERRORS.CLOUD_FORBIDDEN }));
    expect(modeFor(POLICIES.LOCAL_ONLY)).toBe(MODES.ONLY_ON_DEVICE);
  });
});

describe("policy: ask-before-cloud", () => {
  it("allows local without consent", () => {
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.ONLY_ON_DEVICE).allowed).toBe(true);
  });
  it("rejects cloud without consent", () => {
    const r = checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.ONLY_IN_CLOUD);
    expect(r).toMatchObject({ allowed: false, code: POLICY_ERRORS.CONSENT_REQUIRED });
  });
  it.each([undefined, null, "true", 1, "yes"])("rejects non-boolean consent %s", (consent) => {
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.ONLY_IN_CLOUD, { cloudConsent: consent }).allowed).toBe(false);
  });
  it("allows cloud with consent === true", () => {
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.ONLY_IN_CLOUD, { cloudConsent: true }).allowed).toBe(true);
  });
  it("rejects prefer_* modes even with consent, since they could reach the cloud implicitly", () => {
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.PREFER_ON_DEVICE, { cloudConsent: true }).allowed).toBe(false);
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, MODES.PREFER_IN_CLOUD, { cloudConsent: true }).allowed).toBe(false);
  });
  it("uses local first, cloud only in the explicit cloud phase", () => {
    expect(modeFor(POLICIES.ASK_BEFORE_CLOUD, "local")).toBe(MODES.ONLY_ON_DEVICE);
    expect(modeFor(POLICIES.ASK_BEFORE_CLOUD, "cloud")).toBe(MODES.ONLY_IN_CLOUD);
  });
});

describe("policy: auto-fallback and cloud-only", () => {
  it("auto-fallback uses prefer_on_device and allows local modes", () => {
    expect(modeFor(POLICIES.AUTO_FALLBACK)).toBe(MODES.PREFER_ON_DEVICE);
    expect(checkMode(POLICIES.AUTO_FALLBACK, MODES.PREFER_ON_DEVICE).allowed).toBe(true);
    expect(checkMode(POLICIES.AUTO_FALLBACK, MODES.ONLY_ON_DEVICE).allowed).toBe(true);
    expect(checkMode(POLICIES.AUTO_FALLBACK, MODES.ONLY_IN_CLOUD).allowed).toBe(false);
  });
  it("cloud-only uses only_in_cloud and allows cloud-first modes", () => {
    expect(modeFor(POLICIES.CLOUD_ONLY)).toBe(MODES.ONLY_IN_CLOUD);
    expect(checkMode(POLICIES.CLOUD_ONLY, MODES.ONLY_IN_CLOUD).allowed).toBe(true);
    expect(checkMode(POLICIES.CLOUD_ONLY, MODES.PREFER_IN_CLOUD).allowed).toBe(true);
    expect(checkMode(POLICIES.CLOUD_ONLY, MODES.ONLY_ON_DEVICE).allowed).toBe(false);
  });
});

describe("policy: unknown inputs and assertion", () => {
  it("rejects unknown policies and modes", () => {
    expect(checkMode("anything-goes", MODES.ONLY_ON_DEVICE)).toMatchObject({ allowed: false, code: POLICY_ERRORS.UNKNOWN_POLICY });
    expect(checkMode(POLICIES.LOCAL_ONLY, "turbo")).toMatchObject({ allowed: false, code: POLICY_ERRORS.UNKNOWN_MODE });
    expect(checkMode(undefined, undefined).allowed).toBe(false);
  });
  it("does not treat inherited object keys as policies", () => {
    expect(isKnownPolicy("toString")).toBe(false);
    expect(isKnownPolicy("__proto__")).toBe(false);
    expect(checkMode("constructor", MODES.ONLY_ON_DEVICE).allowed).toBe(false);
  });
  it("modeFor rejects unknown policy and phase", () => {
    expect(() => modeFor("nope")).toThrow(PolicyError);
    expect(() => modeFor(POLICIES.ASK_BEFORE_CLOUD, "sideways")).toThrow(PolicyError);
  });
  it("assertModeAllowed returns the mode or throws a PolicyError with a code", () => {
    expect(assertModeAllowed(POLICIES.LOCAL_ONLY, MODES.ONLY_ON_DEVICE)).toBe(MODES.ONLY_ON_DEVICE);
    try {
      assertModeAllowed(POLICIES.LOCAL_ONLY, MODES.ONLY_IN_CLOUD, { cloudConsent: true });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      expect(e.code).toBe(POLICY_ERRORS.MODE_NOT_ALLOWED);
    }
  });
  it("every policy and mode combination is decided without throwing", () => {
    for (const p of Object.values(POLICIES)) for (const m of Object.values(MODES)) {
      for (const consent of [true, false]) expect(() => checkMode(p, m, { cloudConsent: consent })).not.toThrow();
    }
  });
  it("modeFor output is always allowed by checkMode for its own policy (with consent for the cloud phase)", () => {
    for (const p of Object.values(POLICIES)) {
      expect(checkMode(p, modeFor(p, "local"), { cloudConsent: true }).allowed).toBe(true);
    }
    expect(checkMode(POLICIES.ASK_BEFORE_CLOUD, modeFor(POLICIES.ASK_BEFORE_CLOUD, "cloud"), { cloudConsent: true }).allowed).toBe(true);
  });
  it("describes every policy for the UI", () => {
    for (const p of Object.values(POLICIES)) {
      expect(POLICY_INFO[p].label.length).toBeGreaterThan(0);
      expect(POLICY_INFO[p].description.length).toBeGreaterThan(10);
    }
  });
  it("knows which modes can reach the cloud", () => {
    expect(canReachCloud(MODES.ONLY_ON_DEVICE)).toBe(false);
    expect(canReachCloud(MODES.PREFER_ON_DEVICE)).toBe(true);
    expect(isKnownMode(MODES.ONLY_IN_CLOUD)).toBe(true);
    expect(isKnownMode("x")).toBe(false);
  });
});

describe("policy: source normalisation and audit", () => {
  it.each([["on_device", "on-device"], ["ON_DEVICE", "on-device"], ["on-device", "on-device"], ["IN_CLOUD", "cloud"], ["cloud", "cloud"], [" In Cloud ", "cloud"]])(
    "normalises %s", (raw, want) => expect(normalizeSource(raw)).toBe(want));
  it.each([undefined, null, 5, "", "local", "device"])("returns null for %s", (raw) => expect(normalizeSource(raw)).toBeNull());

  it("flags cloud under local-only as a violation", () => {
    expect(auditSource(POLICIES.LOCAL_ONLY, "IN_CLOUD")).toMatchObject({ ok: false, code: "CLOUD_UNDER_LOCAL_ONLY", source: SOURCES.CLOUD });
  });
  it("flags cloud under ask-before-cloud without consent, accepts it with consent", () => {
    expect(auditSource(POLICIES.ASK_BEFORE_CLOUD, "cloud")).toMatchObject({ ok: false, code: "CLOUD_WITHOUT_CONSENT" });
    expect(auditSource(POLICIES.ASK_BEFORE_CLOUD, "cloud", { cloudConsent: true }).ok).toBe(true);
  });
  it("accepts on-device under every policy", () => {
    for (const p of Object.values(POLICIES)) expect(auditSource(p, "on_device").ok).toBe(true);
  });
  it("accepts cloud under auto-fallback and cloud-only", () => {
    expect(auditSource(POLICIES.AUTO_FALLBACK, "cloud").ok).toBe(true);
    expect(auditSource(POLICIES.CLOUD_ONLY, "cloud").ok).toBe(true);
  });
  it("treats an unreadable source as unverifiable, never as ok", () => {
    expect(auditSource(POLICIES.LOCAL_ONLY, undefined)).toMatchObject({ ok: false, code: "UNVERIFIABLE_SOURCE" });
  });
  it("rejects an unknown policy", () => {
    expect(auditSource("x", "cloud")).toMatchObject({ ok: false, code: POLICY_ERRORS.UNKNOWN_POLICY });
  });
  it("combineSources: any cloud makes the result cloud; unknown stays unknown", () => {
    expect(combineSources(["on_device", "on_device"])).toBe("on-device");
    expect(combineSources(["on_device", "in_cloud"])).toBe("cloud");
    expect(combineSources(["on_device", "mystery"])).toBeNull();
    expect(combineSources([])).toBeNull();
    expect(combineSources(undefined)).toBeNull();
  });
});
