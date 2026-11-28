# Part 4 notes: persistence hardening and confidential enforcement

Status labels: **tested in sandbox** means a backend vitest test covers it with mocked storage. **Needs running app** means it has not been exercised against a real MongoDB, Redis or browser.

## What changed
- `Transcript.privacy` (`standard` | `confidential`, default `standard`). Documents stored before this field existed have no value and behave as standard. API responses always include the field. *Tested in sandbox, plus a schema check of the default and the enum.*
- `PATCH /api/v1/transcripts/:id/privacy` with `{ "privacy": "confidential" | "standard" }`. Allowed for the owning account, or the holder of the host secret that created the transcript. Readers who only have access through an approved request cannot change it. Returns `{ success, privacy, transcriptId, meetingCode }` and does not echo the transcript text. *Tested in sandbox.*
- `PATCH /api/v1/transcripts/:id/summary` (summaries made on the device or through Firebase AI Logic) now stores a **rebuilt copy** of the body instead of the raw object: whitelisted fields only, capped strings and lists, finite numbers only, and a required `provenance.source` of `on-device` or `cloud`. Oversize bodies get 413, other problems 400 with a `code`. *Tested in sandbox.*
- Client summaries have their own rate limit (`CLIENT_SUMMARY_RATE_LIMIT_MAX`, default 30 per `CLIENT_SUMMARY_RATE_LIMIT_WIN_SEC`, default 3600), separate from the Groq limit (2 per 2 hours). The anonymous host-secret path is not limited, as before. *Tested in sandbox.*
- Confidential transcripts are refused with **403** and `code: "CONFIDENTIAL_TRANSCRIPT"` on: `POST /transcripts/:id/summary` (Groq), `POST /rag/:id/index`, `POST /rag/:id/query`. The RAG index worker also re-checks the flag when a job starts, so a job queued just before the flag was set does not embed the text. *Tested in sandbox.*

## Judgement calls to review
- **Refusals cost no quota.** The confidential check now runs after the document lookup and authorisation but before the rate limiter, so a refused request does not use up the 2-per-2-hours Groq quota or the RAG quotas. The consequence is a changed order of checks for standard transcripts too: an unknown transcript is now a 404 even when the caller is over quota (it used to be 429). One existing RAG test assumed the old order and now supplies a real document.
- **Unauthorised callers learn nothing.** The confidential refusal comes after the authorisation check, so a stranger gets the same `Not authorized` as before.
- **"Owner" includes the host secret.** Anonymous meetings have no account, so the host secret is the ownership proof there. This matches how summaries are saved today.
- **A client summary with `source: "cloud"` is still accepted for a confidential transcript.** The server cannot know where the client ran inference, and refusing the save would not undo a cloud call. Preventing it is the job of the client policy (Part 6 defaults sensitive meetings to local-only).
- **`receipt` is stored as a small tree of primitives** (depth 3, 40 keys, 4 KB) until Part 5 defines its shape. **Evidence fields** (Part 7) are not whitelisted yet; Part 7 must extend `clientSummary.utils.js`, otherwise they are stripped.

## Limits of "confidential" (state these in the README)
- The transcript itself is **still stored on Hoovik's server** and is readable by the owner and approved readers. Confidential blocks third-party AI providers, not storage.
- Transcripts, RAG chunks and RAG chat sessions that existed **before** the flag was set are not deleted. New indexing and querying are blocked; chunks already stored stay in the database until removed. Deleting them when the flag is set is a stronger option that needs a decision (the existing `deleteRagIndexService` could be used from the privacy route).
- Stored RAG sessions can still be read and cleared by their owner.
- The Groq summary from before the flag was set stays in `aiSummary` until replaced.
- Emotion data the browser sends along with a Groq request is covered, because the whole request is refused.

## Manual check (needs running app)
1. Mark a transcript confidential: `PATCH /api/v1/transcripts/<id>/privacy` with `{"privacy":"confidential"}` and your normal auth.
2. `POST /api/v1/transcripts/<id>/summary` returns 403 with the confidential message (the viewer already shows `message`).
3. `POST /api/v1/rag/<id>/index` and `/query` return 403 with the confidential message.
4. `PATCH /api/v1/transcripts/<id>/summary` with an on-device summary (including `provenance.source`) returns 200.
5. `GET /api/v1/transcripts/<id>` shows `"privacy": "confidential"`.
The viewer toggle and disabled buttons belong to Part 10; this part is backend only.
