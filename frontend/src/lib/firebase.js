// Lazy Firebase AI Logic initialisation.
//
// Importing this module never throws and never loads the Firebase SDK. The SDK is only
// imported (dynamically) the first time getFirebaseAI() is called with a complete config, so
// builds and users without Firebase variables are unaffected.

const ENV_KEYS = {
  apiKey: "VITE_FIREBASE_API_KEY",
  authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
  projectId: "VITE_FIREBASE_PROJECT_ID",
  storageBucket: "VITE_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "VITE_FIREBASE_MESSAGING_SENDER_ID",
  appId: "VITE_FIREBASE_APP_ID",
};
export const REQUIRED_KEYS = ["apiKey", "projectId", "appId"];

export function readFirebaseConfig(env = import.meta.env) {
  const config = {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const v = env?.[envName];
    if (typeof v === "string" && v.trim()) config[key] = v.trim();
  }
  const missing = REQUIRED_KEYS.filter((k) => !config[k]);
  return { configured: missing.length === 0, missing, config };
}

export function isFirebaseConfigured(env = import.meta.env) {
  return readFirebaseConfig(env).configured;
}

let aiPromise = null;

/**
 * Resolves to { status: "not-configured" | "ready" | "error", ai, error? }. Never throws.
 * The AI instance is created once and reused; a failed initialisation can be retried.
 */
export async function getFirebaseAI(env = import.meta.env) {
  const { configured, config } = readFirebaseConfig(env);
  if (!configured) return { status: "not-configured", ai: null };
  if (!aiPromise) {
    aiPromise = (async () => {
      const [{ initializeApp, getApps, getApp }, { getAI, GoogleAIBackend }] = await Promise.all([
        import("firebase/app"),
        import("firebase/ai"),
      ]);
      const app = getApps().length ? getApp() : initializeApp(config);
      return getAI(app, { backend: new GoogleAIBackend() });
    })();
  }
  try {
    return { status: "ready", ai: await aiPromise };
  } catch (error) {
    aiPromise = null;
    return { status: "error", ai: null, error };
  }
}

export function resetFirebaseForTests() {
  aiPromise = null;
}
