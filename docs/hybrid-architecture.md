# Hybrid architecture

_Parts 3 onwards fill in the service, state machine and UI. Nothing here is a claim until a test or measurement backs it._

## Core logic modules (Part 2): `frontend/src/ai/services/`
Pure functions with no Firebase or network dependency, unit-tested with vitest.

| Module | Responsibility |
|---|---|
| `policy.js` | Four named policies mapped to SDK modes; `enforcePolicy` is the only gate before any model call; `auditSource` checks the source observed in the response; `combineSources` (any cloud call makes the result cloud). |
| `prepare.js` | Normalise speakers and whitespace, drop empty and duplicate segments, merge same-speaker turns, time-stamped line format, character count, chunking on turn boundaries and sentences, never dropping text. |
| `validator.js` | Tolerant JSON parse, type checks and caps, owner and deadline grounding, issues list. Owners are checked by presence and, when turns are supplied, labelled `anchored` or `present`; `strictOwners` drops unanchored owners. |
| `insights.js` | Deterministic dominant emotion, integer distribution summing to 100, speaker stats, totals, pace, duration, in the shape the summary panel reads. |
| `adapter.js` | Builds the stored summary shape plus decisions, action items and a provenance block; old summaries without the new fields still render. |

### Known limits
- Owner and deadline grounding is heuristic (token overlap and phrase presence). It will sometimes drop or mislabel a valid owner; dropping is the intended failure direction.
- Anchoring treats a bare mention as not ownership ("after Marcus changes the screen" does not anchor Marcus), but a task whose wording does not overlap the transcript cannot be anchored.
