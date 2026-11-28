// Summary state machine as a pure reducer, so every transition is testable without React.
//
// idle -> initialising -> generating -> done
//                     \-> consent-required | unsupported | too-long | failed
// Late events (progress or results arriving after a reset or in the wrong state) are ignored.

export const SUMMARY_STATES = Object.freeze({
  IDLE: "idle",
  INITIALISING: "initialising",
  GENERATING: "generating",
  DONE: "done",
  CONSENT_REQUIRED: "consent-required",
  UNSUPPORTED: "unsupported",
  TOO_LONG: "too-long",
  FAILED: "failed",
});

export const initialSummaryState = Object.freeze({
  status: SUMMARY_STATES.IDLE,
  progress: null, // 0..1 while the on-device model downloads, otherwise null
  chunk: null, // { index, total } while generating
  analysis: null,
  error: null, // { code, message }
  consent: null, // { reason } while consent is required
});

const RUNNING = new Set([SUMMARY_STATES.INITIALISING, SUMMARY_STATES.GENERATING]);
const clamp01 = (n) => Math.min(1, Math.max(0, n));

export function summaryReducer(state, action) {
  switch (action.type) {
    case "RUN_STARTED":
      return { ...initialSummaryState, status: SUMMARY_STATES.INITIALISING };
    case "INIT_PROGRESS":
      if (state.status !== SUMMARY_STATES.INITIALISING || typeof action.value !== "number" || !Number.isFinite(action.value)) return state;
      return { ...state, progress: clamp01(action.value) };
    case "GENERATING":
      if (!RUNNING.has(state.status)) return state;
      return { ...state, status: SUMMARY_STATES.GENERATING, progress: null, chunk: action.chunk ? { index: action.chunk, total: action.total ?? 1 } : state.chunk };
    case "RESULT": {
      if (!RUNNING.has(state.status)) return state;
      const r = action.result || {};
      const base = { ...initialSummaryState };
      switch (r.status) {
        case "done":
          return { ...base, status: SUMMARY_STATES.DONE, analysis: r.analysis };
        case "consent-required":
          return { ...base, status: SUMMARY_STATES.CONSENT_REQUIRED, consent: { reason: r.reason ?? "local-unavailable" }, error: r.error ?? null };
        case "unsupported":
          return { ...base, status: SUMMARY_STATES.UNSUPPORTED, error: r.error ?? null };
        case "too-long":
          return { ...base, status: SUMMARY_STATES.TOO_LONG, error: r.error ?? null };
        default:
          return { ...base, status: SUMMARY_STATES.FAILED, error: r.error ?? { code: "UNKNOWN", message: "Something went wrong while analysing the meeting." } };
      }
    }
    case "DECLINE_CLOUD":
      return state.status === SUMMARY_STATES.CONSENT_REQUIRED ? { ...initialSummaryState } : state;
    case "RESET":
      return { ...initialSummaryState };
    default:
      return state;
  }
}
