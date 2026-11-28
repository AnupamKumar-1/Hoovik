// Metrics-only telemetry. Records are rebuilt from a whitelist, so transcript text, speaker names
// and raw error messages cannot be stored even by mistake: numbers must be finite, booleans are
// booleans, and strings must look like short identifiers (codes, enum values, ids).

const MAX_RECORDS = 200;
const NUMBER_FIELDS = ["startedAt", "latencyMs", "inputChars", "outputChars", "chunkCount", "failedChunks", "calls", "aiRequests", "externalRequests"];
const BOOLEAN_FIELDS = ["success", "fallback"];
const IDENT_FIELDS = ["requestId", "source", "policy", "mode", "phase", "status", "errorCode", "verdict"];
const IDENT = /^[A-Za-z0-9_.:-]{1,48}$/;

let records = [];
const listeners = new Set();
let counter = 0;

export function newRequestId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  counter += 1;
  return `req-${Date.now().toString(36)}-${counter}`;
}

export function sanitizeRecord(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of NUMBER_FIELDS) if (typeof raw[k] === "number" && Number.isFinite(raw[k])) out[k] = Math.round(raw[k]);
  for (const k of BOOLEAN_FIELDS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  for (const k of IDENT_FIELDS) if (typeof raw[k] === "string" && IDENT.test(raw[k])) out[k] = raw[k];
  return out;
}

export function recordRun(raw) {
  const rec = sanitizeRecord(raw);
  records = [...records, rec].slice(-MAX_RECORDS);
  for (const fn of listeners) {
    try {
      fn(rec);
    } catch {
      /* a failing listener must not affect the run */
    }
  }
  return rec;
}

export const getRecords = () => records.map((r) => ({ ...r }));
export const clearRecords = () => { records = []; };
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const telemetry = Object.freeze({ recordRun, newRequestId });
