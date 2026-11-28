# Privacy model

_Status: only the validation rules from Part 2 are written here. The receipt, redaction and server-side enforcement are not built yet and are not claimed._

## What grounding in the validator does and does not do
- An action-item owner is kept only if the name is a speaker, or appears as a whole word in the transcript. Generic words (team, someone, everyone, TBD, N/A...) are never accepted as owners.
- A deadline is kept only if its wording appears in the transcript.
- Ungrounded values become `null` and the item is kept; an issue code is recorded.

## Known limitations
- **Presence is not ownership.** Presence alone accepts a real speaker who does not own the task. When the transcript turns are supplied, each kept owner is also labelled `anchored` (a turn matching the task is spoken by them in first person, addresses or assigns them, or names them and they reply next) or `present` (the name exists but no turn about the task ties it to them); `strictOwners` drops `present`-only owners. A bare mention does not anchor. This is a token-overlap heuristic, and overall extraction accuracy is still measured in the benchmark, not enforced here.
- **Groups named in the transcript pass.** "Finance team" is kept if the transcript says it, even when the speaker was unsure.
- Substring grounding is crude and will occasionally drop a valid owner or deadline. That failure direction is deliberate for a privacy-first product.
- Deadlines are matched as written; "2026-12-02" is dropped if the transcript only says "Wednesday".
