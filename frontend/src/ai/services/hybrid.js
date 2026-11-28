// Hybrid inference service. Runs a meeting summary under a privacy policy and reports where
// inference really ran.
//
// Rules this file enforces:
//  - every mode passes policy.assertModeAllowed before a model is created or called;
//  - the source in the result comes from the SDK response (inferenceSource) of every call, never
//    from the mode that was requested; any cloud call makes the whole result cloud; the combined
//    source is audited against the policy and a violation returns no analysis;
//  - ask-before-cloud runs local only. Cloud runs only as a separate call with phase "cloud" and
//    cloudConsent true, which the caller must set from an explicit user action;
//  - on-device calls are strictly serialised (Part 1: overlapping calls destroy sessions);
//  - long transcripts are split into chunks, each analysed as an independent single-turn request,
//    then merged (model merge, with a deterministic fallback). Text is never dropped silently:
//    chunks that fail are counted and flagged with the CHUNK_FAILED issue code.
//  - the network witness observes the outbound requests made while a run is in progress (model
//    initialisation, every chunk, the merge). Its receipt goes into provenance.receipt for a
//    finished summary and onto result.receipt for every other outcome. A receipt is a measurement,
//    not a guarantee, and it never changes the outcome of a run.
//  - any mode that can reach the cloud sends REDACTED text: the transcript is redacted locally before
//    it is prepared, the model only ever sees placeholders, and the placeholders are restored in the
//    result on this device. The mapping lives in memory for the length of one run. Local-only runs
//    never redact (nothing leaves the device). Redaction is best effort, not anonymisation.
// Nothing here stores or logs transcript text; telemetry accepts metrics only.

import { prepareTranscript } from "./prepare.js";
import { validateSummary } from "./validator.js";
import { computeInsights } from "./insights.js";
import { toStoredSummary } from "./adapter.js";
import { MODES, POLICIES, assertModeAllowed, auditSource, canReachCloud, combineSources, modeFor } from "./policy.js";
import { ERROR_CODES, USER_MESSAGES, classifyError } from "./errors.js";
import { createSerialQueue } from "./queue.js";
import { telemetry as defaultTelemetry } from "./telemetry.js";
import { buildChunkPrompt, buildMergePrompt, deterministicMerge, splitChunkText } from "./prompt.js";
import { getModel as defaultGetModel } from "./model.js";
import { buildReceipt, createWitness } from "./witness.js";
import { redactTranscript } from "./cloudPreview.js";
import { safeRedactionSummary } from "./redact.js";

// Chunk budgets are judgements, not measurements. On-device: about half of the 50,000 characters
// that succeeded in Part 1 (docs/hybrid-part1-findings.md), leaving room for instructions, the
// structured output and tokeniser variance. Cloud: well inside the model's context window.
export const LIMITS = Object.freeze({
  onDevice: Object.freeze({ chunkChars: 24000, maxChunks: 6 }),
  cloud: Object.freeze({ chunkChars: 100000, maxChunks: 4 }),
});
export const MAX_SPLIT_DEPTH = 2;

export const RESULT_STATUS = Object.freeze({
  DONE: "done",
  CONSENT_REQUIRED: "consent-required",
  UNSUPPORTED: "unsupported",
  TOO_LONG: "too-long",
  FAILED: "failed",
});

// Failures of one chunk that do not stop the run while other chunks can still succeed.
const TOLERABLE = new Set([ERROR_CODES.MALFORMED_OUTPUT, ERROR_CODES.TOO_LONG, ERROR_CODES.SESSION_DESTROYED]);

class FatalRunError extends Error {
  constructor(classified) {
    super(classified.code);
    this.classified = classified;
  }
}

const mayUseDevice = (mode) => mode === MODES.ONLY_ON_DEVICE || mode === MODES.PREFER_ON_DEVICE;

export function createHybridService({
  getModel = defaultGetModel,
  telemetry = defaultTelemetry,
  now = () => Date.now(),
  isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false,
  queue = createSerialQueue(),
  limits = LIMITS,
  witness = createWitness(),
} = {}) {
  let busy = false;

  async function runOnce({ segments, policy, phase, cloudConsent, redaction, onEvent }) {
    const startedAt = now();
    const requestId = telemetry.newRequestId();
    const stats = { calls: 0, outputChars: 0, inputChars: 0, chunkCount: 0, failedChunks: 0 };
    let mode = null;
    let source = null;
    let observation = null; // the open witness window, if any
    let receipt = null;

    // Closes the witness window (once) and builds the receipt from what was observed. Called with
    // the final status, after the source is known; later calls return the same receipt.
    const sealReceipt = (status) => {
      if (receipt) return receipt;
      if (!observation) return null;
      const win = observation;
      observation = null;
      try {
        receipt = buildReceipt({ observation: win.stop(), policy, mode, source, status });
      } catch {
        receipt = null; // a measurement failure must not change the outcome
      }
      return receipt;
    };

    const emit = (e) => {
      try {
        onEvent?.(e);
      } catch {
        /* a failing listener must not affect the run */
      }
    };

    const finish = (base) => {
      const rc = sealReceipt(base.status);
      const result = rc ? { ...base, receipt: rc } : base;
      const ok = result.status === RESULT_STATUS.DONE;
      telemetry.recordRun({
        requestId,
        startedAt,
        latencyMs: now() - startedAt,
        policy,
        mode,
        phase,
        source: ok ? result.meta.source : source,
        status: result.status,
        success: ok,
        fallback: ok && result.meta.source === "cloud" && policy !== POLICIES.CLOUD_ONLY,
        errorCode: ok ? undefined : result.error?.code,
        verdict: rc?.verdict,
        aiRequests: rc?.requests.ai,
        externalRequests: rc ? rc.requests.total - rc.requests.sameOrigin : undefined,
        ...stats,
      });
      return result;
    };

    // Map a terminal error code to the result the caller should show.
    const terminal = (code, { reason } = {}) => {
      const error = { code, message: USER_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN };
      const askLocal = policy === POLICIES.ASK_BEFORE_CLOUD && phase === "local";
      if (code === ERROR_CODES.CONSENT_REQUIRED || (askLocal && (code === ERROR_CODES.LOCAL_UNAVAILABLE || code === ERROR_CODES.TOO_LONG))) {
        return finish({ status: RESULT_STATUS.CONSENT_REQUIRED, error, reason: reason ?? (code === ERROR_CODES.TOO_LONG ? "too-long" : "local-unavailable") });
      }
      if (code === ERROR_CODES.LOCAL_UNAVAILABLE || code === ERROR_CODES.NOT_CONFIGURED) return finish({ status: RESULT_STATUS.UNSUPPORTED, error });
      if (code === ERROR_CODES.TOO_LONG) return finish({ status: RESULT_STATUS.TOO_LONG, error });
      return finish({ status: RESULT_STATUS.FAILED, error });
    };
    const classify = (e) => classifyError(e, { online: isOnline() });

    try {
      // 1. Policy gate. The only place a mode is chosen and approved.
      try {
        mode = modeFor(policy, phase);
        assertModeAllowed(policy, mode, { cloudConsent });
      } catch (e) {
        return terminal(classify(e).code);
      }

      // 2. Redact (only when this mode can reach the cloud), then prepare.
      const lim = mode === MODES.ONLY_IN_CLOUD ? limits.cloud : limits.onDevice;
      let redactor = null;
      let modelInput = segments;
      let originalSegments = null;
      if (canReachCloud(mode)) {
        try {
          const r = redactTranscript(segments, redaction);
          redactor = r.redactor;
          modelInput = r.redacted;
          originalSegments = r.original;
        } catch {
          // If redaction fails nothing may be sent. Never fall through with the original text.
          return terminal(ERROR_CODES.INVALID_INPUT);
        }
      }
      let prepared;
      try {
        prepared = prepareTranscript(modelInput, { maxChunkChars: lim.chunkChars });
      } catch (e) {
        return terminal(classify(e).code);
      }
      stats.inputChars = prepared.charCount;
      const redactionSummary = redactor ? safeRedactionSummary(redactor.summary()) : null;
      if (redactionSummary) {
        stats.redacted = true;
        stats.redactedItems = redactionSummary.total;
      }
      stats.chunkCount = prepared.chunks.length;
      if (prepared.chunks.length > lim.maxChunks) return terminal(ERROR_CODES.TOO_LONG);

      if (mode === MODES.ONLY_IN_CLOUD && !isOnline()) return terminal(ERROR_CODES.OFFLINE);

      // 3. Model and on-device initialisation (must run inside the user's click).
      // The witness window opens here, after the policy gate and before anything can reach a model,
      // and closes once the source is known.
      try {
        observation = witness.start();
      } catch {
        observation = null;
      }
      emit({ type: "stage", stage: "initialising" });
      const got = await getModel(mode);
      if (got.status === "not-configured") return terminal(ERROR_CODES.NOT_CONFIGURED);
      if (got.status === "error") return terminal(classify(got.error).code);
      const { model } = got;
      if (mayUseDevice(mode) && typeof model.initializeDeviceModel === "function") {
        try {
          await queue.enqueue(() => model.initializeDeviceModel((value) => emit({ type: "init-progress", value })));
        } catch (e) {
          return terminal(classify(e).code);
        }
      }

      // 4. Generate.
      const sources = [];
      const issues = [];
      const ctx = { speakers: prepared.speakers, transcriptText: prepared.text };
      const finalCtx = { ...ctx, turns: prepared.turns };

      const callOnce = (prompt) =>
        queue.enqueue(async () => {
          const res = await model.generateContent(prompt);
          const response = res?.response;
          const text = response.text();
          sources.push(response.inferenceSource);
          stats.calls += 1;
          stats.outputChars += typeof text === "string" ? text.length : 0;
          return text;
        });

      // One retry for an interrupted on-device session (Part 1: InvalidStateError).
      const callModel = async (prompt) => {
        try {
          return await callOnce(prompt);
        } catch (e) {
          if (classify(e).code !== ERROR_CODES.SESSION_DESTROYED) throw e;
          return callOnce(prompt);
        }
      };

      const summariseText = async (text, index, total, depth) => {
        let raw;
        try {
          raw = await callModel(buildChunkPrompt({ transcriptText: text, index, total }));
        } catch (e) {
          const c = classify(e);
          if (!TOLERABLE.has(c.code)) throw new FatalRunError(c);
          if (c.code === ERROR_CODES.TOO_LONG && depth < MAX_SPLIT_DEPTH) {
            const halves = splitChunkText(text);
            if (halves) {
              const out = [];
              for (const h of halves) out.push(...(await summariseText(h, index, total, depth + 1)));
              return out;
            }
          }
          return [{ ok: false, code: c.code }];
        }
        const v = validateSummary(raw, ctx);
        if (!v.ok) return [{ ok: false, code: ERROR_CODES.MALFORMED_OUTPUT }];
        issues.push(...v.issues);
        return [{ ok: true, value: v.value }];
      };

      const leaves = [];
      const total = prepared.chunks.length;
      for (const chunk of prepared.chunks) {
        emit({ type: "stage", stage: "generating", chunk: chunk.index + 1, total });
        leaves.push(...(await summariseText(chunk.text, chunk.index, total, 0)));
      }
      const good = leaves.filter((l) => l.ok);
      stats.failedChunks = leaves.length - good.length;
      stats.chunkCount = leaves.length;
      for (let i = 0; i < stats.failedChunks; i++) issues.push({ code: "CHUNK_FAILED", path: "", message: "A part of the transcript could not be analysed" });

      if (good.length === 0) {
        const codes = leaves.map((l) => l.code);
        const code = codes.every((c) => c === ERROR_CODES.TOO_LONG) ? ERROR_CODES.TOO_LONG : codes.find((c) => c !== ERROR_CODES.TOO_LONG) ?? ERROR_CODES.MALFORMED_OUTPUT;
        source = combineSources(sources);
        return terminal(code);
      }

      // 5. Merge (only when more than one part succeeded).
      let validated;
      if (good.length === 1) {
        validated = validateSummary(good[0].value, finalCtx);
      } else {
        const partials = good.map((g) => g.value);
        emit({ type: "stage", stage: "merging", total });
        try {
          const merged = validateSummary(await callModel(buildMergePrompt({ partials })), finalCtx);
          if (merged.ok) validated = merged;
        } catch (e) {
          const c = classify(e);
          if (!TOLERABLE.has(c.code)) throw new FatalRunError(c);
        }
        if (!validated) {
          issues.push({ code: "MERGE_FALLBACK", path: "", message: "Parts were combined without the model" });
          validated = validateSummary(deterministicMerge(partials), finalCtx);
        }
      }
      if (!validated.ok) {
        source = combineSources(sources);
        return terminal(ERROR_CODES.MALFORMED_OUTPUT);
      }
      issues.push(...validated.issues);

      // 6. Where did it really run? Taken from every response; any cloud call makes the result cloud.
      source = combineSources(sources);
      const audit = auditSource(policy, source, { cloudConsent });
      if (!audit.ok) {
        const error = { code: audit.code, message: audit.reason };
        return finish({ status: RESULT_STATUS.FAILED, error });
      }

      // Placeholders go back to the original text here, on this device. Insights and speaker
      // statistics are computed from the original segments and never leave the device.
      const analysis = toStoredSummary({
        validated: redactor ? redactor.restoreDeep(validated.value) : validated.value,
        insights: computeInsights(redactor ? originalSegments : prepared.segments),
        provenance: { source: audit.source, policy, mode, chunkCount: leaves.length, receipt: sealReceipt(RESULT_STATUS.DONE), redaction: redactionSummary },
        issues,
      });
      return finish({
        status: RESULT_STATUS.DONE,
        analysis,
        meta: { source: audit.source, mode, policy, phase, chunkCount: leaves.length, failedChunks: stats.failedChunks, requestId },
      });
    } catch (e) {
      return terminal((e instanceof FatalRunError ? e.classified : classify(e)).code);
    }
  }

  async function summarize({ segments, policy, phase = "local", cloudConsent = false, redaction, onEvent } = {}) {
    if (busy) {
      return { status: RESULT_STATUS.FAILED, error: { code: ERROR_CODES.BUSY, message: USER_MESSAGES.BUSY } };
    }
    busy = true;
    try {
      return await runOnce({ segments, policy, phase, cloudConsent, redaction, onEvent });
    } finally {
      busy = false;
    }
  }

  return { summarize, isBusy: () => busy };
}

let singleton = null;
export function getHybridService() {
  if (!singleton) singleton = createHybridService();
  return singleton;
}
