// The only module that touches the Firebase AI SDK's model API. It creates one model per
// inference mode and reuses it. It does NOT decide whether a mode is allowed: hybrid.js calls
// the policy gate (assertModeAllowed) before asking for a model here.
//
// Only the configuration that applies to each mode is passed:
//   only_on_device   -> onDeviceParams
//   only_in_cloud    -> inCloudParams
//   prefer_on_device -> both

import { getFirebaseAI } from "../../lib/firebase.js";
import { MODES } from "./policy.js";
import { SUMMARY_SCHEMA, buildCloudSchema } from "./prompt.js";

// Default taken from the installed SDK (DEFAULT_HYBRID_IN_CLOUD_MODEL). Override per build with
// VITE_FIREBASE_AI_CLOUD_MODEL.
export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

const TEXT_EN = [{ type: "text", languages: ["en"] }];

export function buildHybridParams(mode, { Schema, cloudModel = DEFAULT_CLOUD_MODEL }) {
  const onDeviceParams = {
    createOptions: { expectedInputs: TEXT_EN, expectedOutputs: TEXT_EN },
    promptOptions: { responseConstraint: SUMMARY_SCHEMA },
  };
  const inCloudParams = {
    model: cloudModel,
    generationConfig: { responseMimeType: "application/json", responseSchema: buildCloudSchema(Schema), temperature: 0.2 },
  };
  switch (mode) {
    case MODES.ONLY_ON_DEVICE:
      return { mode, onDeviceParams };
    case MODES.ONLY_IN_CLOUD:
      return { mode, inCloudParams };
    case MODES.PREFER_ON_DEVICE:
      return { mode, onDeviceParams, inCloudParams };
    default:
      throw new Error(`Unsupported inference mode: ${String(mode)}`);
  }
}

const cache = new Map();

/** Resolves to { status: "ready", model } | { status: "not-configured" } | { status: "error", error }. Never throws. */
export async function getModel(mode, { env = import.meta.env } = {}) {
  const fb = await getFirebaseAI(env);
  if (fb.status === "not-configured") return { status: "not-configured" };
  if (fb.status === "error") return { status: "error", error: fb.error };
  if (!cache.has(mode)) {
    cache.set(
      mode,
      (async () => {
        const { getGenerativeModel, Schema } = await import("firebase/ai");
        const cloudModel = (typeof env?.VITE_FIREBASE_AI_CLOUD_MODEL === "string" && env.VITE_FIREBASE_AI_CLOUD_MODEL.trim()) || DEFAULT_CLOUD_MODEL;
        return getGenerativeModel(fb.ai, buildHybridParams(mode, { Schema, cloudModel }));
      })()
    );
  }
  try {
    return { status: "ready", model: await cache.get(mode) };
  } catch (error) {
    cache.delete(mode);
    return { status: "error", error };
  }
}

export function resetModelsForTests() {
  cache.clear();
}
