# Part 1 findings: on-device spike

Measured on one machine, one Chrome profile, on 28 Nov 2026 with a throwaway spike page (not part of Hoovik). **Single machine, small sample: treat every number as indicative, not a guarantee.**

## Environment
| Item | Value |
|---|---|
| Chrome | 158.0.0.0 (desktop, macOS) |
| CPU threads / RAM | 8 / 8 GB (as reported by the browser) |
| chrome://on-device-internals | Device performance class: Medium |
| Firebase SDK | `firebase` 13.4.0 (API inspected from the package types) |
| Firebase project | AI Logic enabled with the Gemini Developer API; App Check not enforced during the spike |

## Results
| Question | Result |
|---|---|
| Is the reported source what we assumed? | Yes. Successful local calls report `inferenceSource: "on_device"`. Cloud is `"in_cloud"`. |
| Availability progression | `downloadable` → `downloading` → `available`. Chrome downloaded the model in the background; no progress events reached the page. |
| First-download time | **Not measured.** The model became available some hours after the first attempt on this machine; the page never saw progress events. A fresh profile would measure it. |
| Latency of a short local prompt | about 2 to 5 s once the model was loaded; the first prompt after load took about 30 s (cold start) |
| Latency vs input size (one-sentence summary output) | 1k chars 4.8 s, 2k 1.9 s, 4k 2.6 s, 8k 3.9 s, 12k 5.3 s, 16k 7.1 s, 24k 10.9 s, 32k 13.4 s, 48k 20.1 s, 50k 20.1 s; roughly linear |
| Largest input that succeeded | **50,000 characters** |
| Smallest input that failed | **51,000 characters** (also 52k, 56k, 64k) |
| Limit check speed | Over-limit requests are rejected immediately (13 to 53 ms) |
| Offline | _Not yet measured_ |
| Unsupported browser error shape | _Not yet measured (planned: Safari)_ |

### Caveats on the 50,000 figure
- The test text was one repeated sentence and the requested output was one short sentence. Real transcripts tokenise differently (names, numbers, non-English text), and a structured summary needs room for its own output, so the usable budget for real transcripts is lower than 50,000 characters.
- The limit is in tokens, not characters; characters are only a proxy.

## Real error shapes (copied from the spike report)
```
QuotaExceededError (DOMException, code 22): "The input is too large."
InvalidStateError  (DOMException, code 11): "The model execution session has been destroyed."
Error: "Initialise Firebase AI first (step 0)."   // spike page only, not an SDK error
```
Two on-device prompts that were in flight failed with `InvalidStateError` at the instant a third request started. The cause is not proven; it matches a new request destroying in-flight sessions on the same model. **Design consequence: on-device calls must be strictly serialised (queue, never run concurrently).**

## Decisions this sets for Part 3
- Chunk budget for transcript text: about half of the measured limit (24,000 characters) to leave room for instructions, structured output and tokeniser variance. This is a judgement, not a measured optimum.
- On `QuotaExceededError` for a chunk: split it smaller and retry a bounded number of times before giving up with the too-long state.
- Classify `QuotaExceededError` as too-long, `InvalidStateError` as retryable once, and a missing `LanguageModel` or unavailable model as local-unavailable (to be confirmed once the unsupported-browser shape is measured).

## Not yet done from the Part 1 plan
- First-run download time in a fresh profile.
- Offline behaviour.
- The unsupported-browser error shape.
