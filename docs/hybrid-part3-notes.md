# Part 3 notes: hybrid service, state machine, long transcripts

Status labels: **tested in sandbox** means a vitest test covers it with a mocked SDK. **Needs Chrome** means it has not been run against the real on-device model.

## What the installed SDK does (read from `@firebase/ai` 13.4.0, not assumed)
- The on-device path only forwards message **contents** to the Prompt API. `systemInstruction` and `generationConfig` are ignored on-device, so instructions live inside the user prompt for every mode, and the on-device JSON schema is passed as `onDeviceParams.promptOptions.responseConstraint`.
- The SDK creates a **new on-device session for every call and destroys the previous one**. This matches the `InvalidStateError` seen in Part 1 and is why all model calls go through one serial queue.
- With `only_on_device`, an unavailable model throws `AIError` with code `unsupported` ("an on-device model is not available") or `api-not-enabled` ("Local LanguageModel API not available"). `errors.js` classifies both as `LOCAL_UNAVAILABLE`.
- `initializeDeviceModel` must run inside a user gesture when a download is needed. The service calls it at the start of a run, so start runs from a click.
- The source of a result is `response.inferenceSource` (`on_device` or `in_cloud`), read from every call.

## Behaviour (tested in sandbox)
- Every mode passes `modeFor` and `assertModeAllowed` before a model is created. Local-only never creates a cloud model, even when asked for a cloud phase with consent.
- Ask-before-cloud runs local only. Cloud runs only as a separate call with `phase: "cloud"` and `cloudConsent === true`. Local unavailable or too long moves to `consent-required`.
- Any cloud response makes the whole result cloud. A cloud response under local-only, or a response with no source, returns an error and **no analysis**.
- Chunks: on-device budget 24,000 characters and at most 6 chunks; cloud 100,000 and 4. Each chunk is an independent single-turn request. Two or more successful parts are merged by the model, with a deterministic fallback flagged as `MERGE_FALLBACK`. A part that fails is flagged `CHUNK_FAILED`; if none succeed the run fails (or is `too-long` when every failure was a size failure).
- `QuotaExceededError` splits the chunk in two (on a line boundary, or inside the line for a single giant turn) and retries, to depth 2. `InvalidStateError` is retried once.
- Telemetry stores numbers, booleans and short identifiers only. SDK error messages are never stored or shown; fixed messages are used instead.

## Limits and judgement calls
- The chunk budgets are judgements, not measurements (see the Part 1 findings caveats). Tune them from the Part 11 benchmark.
- On-device input and output are declared **English only** (`expectedInputs/Outputs`). Other languages are untested.
- `type: ["string", "null"]` in the on-device schema is standard JSON Schema; whether Chrome's `responseConstraint` accepts it for owner and deadline has **not been confirmed**. The validator accepts either way.
- Anchoring and grounding limits from Part 2 still apply; this part does not change them.

## Checking it in real Chrome (needs Chrome, no UI needed)
Put your Firebase variables in `frontend/.env.local`, run `npm start`, open the app in the Chrome profile you used for Part 1, open DevTools and paste into the console (DevTools evaluates console input as a user gesture by default):

```js
const { getHybridService } = await import("/src/ai/services/hybrid.js");
const { shortMeeting, mediumMeeting, longMeeting } = await import("/src/ai/golden/index.js");
const { getRecords } = await import("/src/ai/services/telemetry.js");
const svc = getHybridService();
const go = async (g, policy, extra = {}) => {
  const r = await svc.summarize({ segments: g.segments, policy, onEvent: (e) => console.log("event", e), ...extra });
  console.log(g.id, policy, r.status, r.error ?? "", r.analysis?.provenance);
  return r;
};
await go(shortMeeting, "local-only");
await go(mediumMeeting, "local-only");
await go(longMeeting, "local-only");
console.table(getRecords());
```

Record for each run: `status`, `provenance.source` (expect `on-device`), `chunkCount`, `failedChunks`, `validationIssues`, `latencyMs`.

Then, on a profile **without** the model or flag:
1. `await go(shortMeeting, "local-only")` should give `unsupported` with a Network tab showing no request to an AI endpoint.
2. `await go(shortMeeting, "ask-before-cloud")` should give `consent-required` and still no AI request.
3. `await go(shortMeeting, "ask-before-cloud", { phase: "cloud", cloudConsent: true })` should give `done` with `provenance.source` `cloud`.
4. Call `go(...)` twice without awaiting: the second returns `failed` with `BUSY`; the first completes.

Add the findings (real error shapes for the cases above, whether `responseConstraint` accepted the schema, long-fixture behaviour) to `docs/hybrid-part1-findings.md` or a new findings note.
