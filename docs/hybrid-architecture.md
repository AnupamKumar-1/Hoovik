# Hybrid architecture

_Parts 3 onwards fill in the service, state machine and UI. Nothing here is a claim until a test or measurement backs it._

## Core logic modules (Part 2): `frontend/src/ai/services/`
Pure functions with no Firebase or network dependency, unit-tested with vitest.

| Module | Responsibility |
|---|---|
| `policy.js` | Four named policies mapped to SDK modes; `assertModeAllowed` (with `modeFor`) is the only gate before any model call; `auditSource` checks the source observed in the response; `combineSources` (any cloud call makes the result cloud). |
| `prepare.js` | Normalise speakers and whitespace, drop empty and duplicate segments, merge same-speaker turns, time-stamped line format, character count, chunking on turn boundaries and sentences, never dropping text. |
| `validator.js` | Tolerant JSON parse, type checks and caps, owner and deadline grounding, issues list. Owners are checked by presence and, when turns are supplied, labelled `anchored` or `present`; `strictOwners` drops unanchored owners. |
| `insights.js` | Deterministic dominant emotion, integer distribution summing to 100, speaker stats, totals, pace, duration, in the shape the summary panel reads. |
| `adapter.js` | Builds the stored summary shape plus decisions, action items and a provenance block; old summaries without the new fields still render. |

### Known limits
- Owner and deadline grounding is heuristic (token overlap and phrase presence). It will sometimes drop or mislabel a valid owner; dropping is the intended failure direction.
- Anchoring treats a bare mention as not ownership ("after Marcus changes the screen" does not anchor Marcus), but a task whose wording does not overlap the transcript cannot be anchored.

## Hybrid service (Part 3): `frontend/src/ai/services/` and `frontend/src/hooks/`
| Module | Responsibility |
|---|---|
| `model.js` | The only module that calls the SDK's model API. One model per inference mode, created lazily and reused; only the configuration that applies to a mode is passed. |
| `hybrid.js` | `createHybridService().summarize(...)`: policy gate, prepare, chunk, one independent single-turn call per chunk, merge, validate, source taken from every response, audit against the policy, telemetry, adapt. Returns `done`, `consent-required`, `unsupported`, `too-long` or `failed`; it does not throw for expected states. Refuses overlapping runs (`BUSY`). |
| `prompt.js` | Prompts, on-device JSON schema, cloud schema builder, deterministic merge, chunk splitting. |
| `errors.js` | Maps SDK and browser errors to fixed codes with fixed user-safe messages. |
| `queue.js` | Strict serial execution for model calls. |
| `telemetry.js` | Metrics-only records rebuilt from a whitelist; text cannot be stored. |
| `summaryMachine.js` | Pure reducer for the UI states; keeps the receipt of the last run. |
| `useHybridSummary.js` | React binding. `approveCloud()` is the only way consent becomes `true`. |

Details, the SDK behaviour this relies on and the Chrome checks: `docs/hybrid-part3-notes.md`.

## Network witness and privacy receipt (Part 5): `frontend/src/ai/services/witness.js`, `frontend/src/components/PrivacyReceipt.jsx`
| Module | Responsibility |
|---|---|
| `witness.js` | Host lists in one place (`HOST_RULES`); classifier; observation window (fetch/XHR wrapper plus Resource Timing, shared by overlapping windows); verdict logic; receipt builder, reader and export. Keeps hosts and counts only. |
| `hybrid.js` | Opens a window after the policy gate and before any model is created, closes it once the source is known, and attaches the receipt (`provenance.receipt` when done, `result.receipt` otherwise). A witness failure never changes the outcome. |
| `PrivacyReceipt.jsx` | Verdict badge, plain-language sentence, counts, collapsible details with what the witness cannot see, JSON export. Rendered by the summary panel when a usable receipt is present. |

Details, limits and the Chrome checks: `docs/hybrid-part5-notes.md`.
