// Privacy policy engine. Pure logic, no SDK imports.
//
// `checkMode` / `assertModeAllowed` are the ONLY gate that may approve a model call.
// Any code that creates or calls a model must pass its mode through here first.
// `auditSource` is the after-the-fact check on where inference actually ran, using the
// source reported by the SDK response (never the mode that was requested).

export const POLICIES = Object.freeze({
  LOCAL_ONLY: "local-only",
  ASK_BEFORE_CLOUD: "ask-before-cloud",
  AUTO_FALLBACK: "auto-fallback",
  CLOUD_ONLY: "cloud-only",
});

// Names mirror Firebase AI Logic hybrid inference modes.
export const MODES = Object.freeze({
  ONLY_ON_DEVICE: "only_on_device",
  PREFER_ON_DEVICE: "prefer_on_device",
  ONLY_IN_CLOUD: "only_in_cloud",
  PREFER_IN_CLOUD: "prefer_in_cloud",
});

export const SOURCES = Object.freeze({ ON_DEVICE: "on-device", CLOUD: "cloud" });

// Which modes can ever send data off the device.
const CLOUD_CAPABLE = new Set([MODES.PREFER_ON_DEVICE, MODES.ONLY_IN_CLOUD, MODES.PREFER_IN_CLOUD]);

// allowed: modes the policy permits. consentModes: allowed modes that also need explicit consent.
const RULES = Object.freeze({
  [POLICIES.LOCAL_ONLY]: { allowed: [MODES.ONLY_ON_DEVICE], consentModes: [] },
  // prefer_* modes are rejected here on purpose: they could reach the cloud without a separate approval step.
  [POLICIES.ASK_BEFORE_CLOUD]: { allowed: [MODES.ONLY_ON_DEVICE, MODES.ONLY_IN_CLOUD], consentModes: [MODES.ONLY_IN_CLOUD] },
  // Choosing this policy is the user's standing approval for cloud fallback.
  [POLICIES.AUTO_FALLBACK]: { allowed: [MODES.ONLY_ON_DEVICE, MODES.PREFER_ON_DEVICE], consentModes: [] },
  [POLICIES.CLOUD_ONLY]: { allowed: [MODES.ONLY_IN_CLOUD, MODES.PREFER_IN_CLOUD], consentModes: [] },
});

export const POLICY_INFO = Object.freeze({
  [POLICIES.LOCAL_ONLY]: {
    label: "Local only",
    description: "The transcript is analysed on this device. It is never sent to a cloud model.",
  },
  [POLICIES.ASK_BEFORE_CLOUD]: {
    label: "Local, ask before cloud",
    description: "Runs on this device. If that is not possible, you are asked before anything is sent to the cloud.",
  },
  [POLICIES.AUTO_FALLBACK]: {
    label: "Local, fall back to cloud",
    description: "Runs on this device when possible and automatically uses the cloud model otherwise.",
  },
  [POLICIES.CLOUD_ONLY]: {
    label: "Cloud",
    description: "Always uses the cloud model. The transcript is sent to Google's Gemini service.",
  },
});

export const POLICY_ERRORS = Object.freeze({
  UNKNOWN_POLICY: "UNKNOWN_POLICY",
  UNKNOWN_MODE: "UNKNOWN_MODE",
  MODE_NOT_ALLOWED: "MODE_NOT_ALLOWED",
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  CLOUD_FORBIDDEN: "CLOUD_FORBIDDEN",
});

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export const isKnownPolicy = (p) => typeof p === "string" && Object.prototype.hasOwnProperty.call(RULES, p);
export const isKnownMode = (m) => Object.values(MODES).includes(m);
export const canReachCloud = (mode) => CLOUD_CAPABLE.has(mode);

/** Pure decision: may this policy run this mode? Consent must be exactly `true`. */
export function checkMode(policy, mode, { cloudConsent = false } = {}) {
  if (!isKnownPolicy(policy)) return { allowed: false, code: POLICY_ERRORS.UNKNOWN_POLICY, reason: `Unknown policy: ${String(policy)}` };
  if (!isKnownMode(mode)) return { allowed: false, code: POLICY_ERRORS.UNKNOWN_MODE, reason: `Unknown mode: ${String(mode)}` };
  const rule = RULES[policy];
  if (!rule.allowed.includes(mode)) {
    return { allowed: false, code: POLICY_ERRORS.MODE_NOT_ALLOWED, reason: `Policy "${policy}" does not allow mode "${mode}"` };
  }
  if (rule.consentModes.includes(mode) && cloudConsent !== true) {
    return { allowed: false, code: POLICY_ERRORS.CONSENT_REQUIRED, reason: `Policy "${policy}" requires explicit consent before cloud mode "${mode}"` };
  }
  return { allowed: true, code: null, reason: null };
}

export function assertModeAllowed(policy, mode, opts) {
  const r = checkMode(policy, mode, opts);
  if (!r.allowed) throw new PolicyError(r.code, r.reason);
  return mode;
}

/**
 * Mode to request for a policy. phase "local" is the first attempt; phase "cloud" is the separate,
 * consented second attempt used only by ask-before-cloud.
 */
export function modeFor(policy, phase = "local") {
  if (!isKnownPolicy(policy)) throw new PolicyError(POLICY_ERRORS.UNKNOWN_POLICY, `Unknown policy: ${String(policy)}`);
  if (phase !== "local" && phase !== "cloud") throw new PolicyError(POLICY_ERRORS.UNKNOWN_MODE, `Unknown phase: ${String(phase)}`);
  switch (policy) {
    case POLICIES.LOCAL_ONLY:
      if (phase === "cloud") throw new PolicyError(POLICY_ERRORS.CLOUD_FORBIDDEN, "Local-only policy never runs a cloud phase");
      return MODES.ONLY_ON_DEVICE;
    case POLICIES.ASK_BEFORE_CLOUD:
      return phase === "cloud" ? MODES.ONLY_IN_CLOUD : MODES.ONLY_ON_DEVICE;
    case POLICIES.AUTO_FALLBACK:
      return MODES.PREFER_ON_DEVICE;
    default:
      return MODES.ONLY_IN_CLOUD;
  }
}

/** Map the SDK's reported source (various spellings) to "on-device" | "cloud" | null. */
export function normalizeSource(source) {
  if (typeof source !== "string") return null;
  const s = source.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "on_device" || s === "ondevice") return SOURCES.ON_DEVICE;
  if (s === "in_cloud" || s === "cloud" || s === "incloud") return SOURCES.CLOUD;
  return null;
}

/** Audit where inference actually ran against the policy. */
export function auditSource(policy, observedSource, { cloudConsent = false } = {}) {
  if (!isKnownPolicy(policy)) return { ok: false, code: POLICY_ERRORS.UNKNOWN_POLICY, source: null, reason: `Unknown policy: ${String(policy)}` };
  const source = normalizeSource(observedSource);
  if (source === null) return { ok: false, code: "UNVERIFIABLE_SOURCE", source: null, reason: "The response did not report a recognisable inference source" };
  if (source === SOURCES.ON_DEVICE) return { ok: true, code: null, source, reason: null };
  if (policy === POLICIES.LOCAL_ONLY) {
    return { ok: false, code: "CLOUD_UNDER_LOCAL_ONLY", source, reason: "Inference ran in the cloud under a local-only policy" };
  }
  if (policy === POLICIES.ASK_BEFORE_CLOUD && cloudConsent !== true) {
    return { ok: false, code: "CLOUD_WITHOUT_CONSENT", source, reason: "Inference ran in the cloud without consent" };
  }
  return { ok: true, code: null, source, reason: null };
}

/** Combine sources of several calls: any cloud call makes the whole result cloud. Unknown stays unknown. */
export function combineSources(sources) {
  const normalized = (sources || []).map(normalizeSource);
  if (normalized.length === 0 || normalized.some((s) => s === null)) return null;
  return normalized.includes(SOURCES.CLOUD) ? SOURCES.CLOUD : SOURCES.ON_DEVICE;
}
