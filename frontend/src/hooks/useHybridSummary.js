import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getHybridService } from "../ai/services/hybrid.js";
import { SUMMARY_STATES, initialSummaryState, summaryReducer } from "../ai/services/summaryMachine.js";
import { buildCloudPreview } from "../ai/services/cloudPreview.js";

const UNKNOWN = { status: "failed", error: { code: "UNKNOWN", message: "Something went wrong while analysing the meeting." } };

/**
 * React binding for the hybrid summary service.
 *
 *   run({ segments, policy, redaction })  start (call from a click: the on-device model may need a user gesture);
 *                              redaction is optional: { names, terms } to always redact
 *   cloudPreview               while consent is required: what would leave the device (redacted rows,
 *                              counts, sensitivity); null otherwise. Built locally and kept in memory.
 *   approveCloud()             the ONLY way cloudConsent becomes true; valid only while consent is required
 *   declineCloud() / retry() / reset()
 *
 * `service` can be injected for tests; it defaults to the shared hybrid service.
 */
export function useHybridSummary({ service } = {}) {
  const [state, dispatch] = useReducer(summaryReducer, initialSummaryState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastArgs = useRef(null);
  const token = useRef(0);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const execute = useCallback(
    async (args) => {
      if (running.current) return; // duplicate-click guard; the service refuses overlapping runs as well
      running.current = true;
      const mine = ++token.current;
      const live = () => mounted.current && mine === token.current;
      dispatch({ type: "RUN_STARTED" });
      try {
        const svc = service ?? getHybridService();
        const result = await svc.summarize({
          ...args,
          onEvent: (e) => {
            if (!live()) return;
            if (e.type === "init-progress") dispatch({ type: "INIT_PROGRESS", value: e.value });
            else if (e.type === "stage" && (e.stage === "generating" || e.stage === "merging")) dispatch({ type: "GENERATING", chunk: e.chunk, total: e.total });
          },
        });
        if (live()) dispatch({ type: "RESULT", result });
      } catch {
        if (live()) dispatch({ type: "RESULT", result: UNKNOWN });
      } finally {
        running.current = false;
      }
    },
    [service]
  );

  const run = useCallback(
    ({ segments, policy, redaction }) => {
      lastArgs.current = { segments, policy, redaction };
      return execute({ segments, policy, redaction, phase: "local", cloudConsent: false });
    },
    [execute]
  );

  const retry = useCallback(() => {
    if (!lastArgs.current) return undefined;
    return execute({ ...lastArgs.current, phase: "local", cloudConsent: false });
  }, [execute]);

  const approveCloud = useCallback(() => {
    if (stateRef.current.status !== SUMMARY_STATES.CONSENT_REQUIRED || !lastArgs.current) return undefined;
    return execute({ ...lastArgs.current, phase: "cloud", cloudConsent: true });
  }, [execute]);

  const declineCloud = useCallback(() => dispatch({ type: "DECLINE_CLOUD" }), []);

  const reset = useCallback(() => {
    token.current += 1;
    dispatch({ type: "RESET" });
  }, []);

  const consentRequired = state.status === SUMMARY_STATES.CONSENT_REQUIRED;
  const cloudPreview = useMemo(() => {
    if (!consentRequired || !lastArgs.current) return null;
    try {
      return buildCloudPreview(lastArgs.current.segments, lastArgs.current.redaction);
    } catch {
      return null;
    }
  }, [consentRequired]);

  return { state, cloudPreview, run, retry, approveCloud, declineCloud, reset };
}
