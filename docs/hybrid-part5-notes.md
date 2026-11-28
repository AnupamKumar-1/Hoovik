# Part 5 notes: network witness and privacy receipt

Status labels: **tested in sandbox** means a vitest test covers it (mocked or fake browser objects). **Tested in headless Chromium** means it was also run once in a real Chromium 157 against local servers. **Needs Chrome** means it has not been run with the real on-device model or the real Firebase endpoints.

## What was added
- `frontend/src/ai/services/witness.js`: classifier, observation window, verdict logic, receipt builder and reader, export.
- `frontend/src/components/PrivacyReceipt.jsx` (+ `styles/privacy-receipt.css`): the receipt card with a collapsible detail view and a JSON export. `SummaryPanel` renders it under any summary whose `provenance.receipt` is usable; older summaries and summaries without a receipt render exactly as before.
- `hybrid.js`: opens a window right after the policy gate and before any model is created, closes it once the source is known (or when the run ends in any other way), and attaches the receipt.
- `telemetry.js`: three more metrics-only fields (`verdict`, `aiRequests`, `externalRequests`). No hosts.
- `summaryMachine.js`: the state keeps `receipt` for every outcome, so the UI can say "nothing was sent" on the consent, unsupported and failed screens.

## How a run is measured
- The window covers model initialisation, every chunk and the merge. It does **not** cover work before the policy gate: a refused run never reaches a model, so it has no window and no receipt.
- Two sources are merged. A thin wrapper around `fetch` and `XMLHttpRequest.open` is installed only while a window is open and removed afterwards. A `PerformanceObserver` collects Resource Timing entries that started inside the window (per the spec, observers are not limited by the timing buffer size; that was not tested separately; `takeRecords()` flushes it at stop). Per URL (origin + path) the larger of the two counts is used, so a request seen by both counts once. This is why images and scripts, which the wrapper cannot see, still count.
- Windows may nest or overlap. One shared wrapper serves all open windows and is removed when the last one closes. If another library wraps `fetch` on top of the witness, the witness goes inert instead of unwinding it, so nothing is double counted later.
- Only host names and counts are kept. Full URLs, paths and query strings are dropped at the moment of recording (a Firebase request URL can carry an API key). Request and response bodies are never read.

## Classes and the host list
`HOST_RULES` in `witness.js` is the one place the lists live. Matching is by whole host name (the host itself or a subdomain), so `firebasevertexai.googleapis.com.evil.example` and `evilfirebasevertexai.googleapis.com.example` are **not** AI hosts. Order is: AI endpoint, Firebase/App Check housekeeping, this app (same origin or configured own host), other. The Firebase AI Logic host was read from the installed SDK (`DEFAULT_DOMAIN` in `@firebase/ai`).

Limits of the classifier:
- Matching is by host name, not port. `localhost:3000` and `localhost:8000` are the same host to it.
- `www.google.com` and `www.gstatic.com` are classed as Firebase housekeeping because App Check's reCAPTCHA uses them; the rule is host-level and therefore coarse.
- The AI list is a deny list of known services. An AI service that is not on the list shows up as "other hosts", not as an AI request.

## Verdicts
| Verdict | When |
|---|---|
| `local-verified` | Finished with an on-device source and zero requests to AI hosts were observed. |
| `violation` | A local result was expected (local-only policy, on-device mode, or on-device source) and at least one request to an AI host was observed. This is a verdict, not a failure: the run's outcome does not change. |
| `cloud` | Cloud result with at least one AI request observed; or a run that sent an AI request and produced no usable result. |
| `no-ai-requests` | No analysis was produced (consent needed, unsupported, too long, failed) and no AI request was observed. |
| `inconclusive` | No observer was available, or the result says cloud but no AI request was seen, or no source was reported. A cloud result is never reported as local. |

The wording is regenerated from the verdict when a receipt is read (`readReceipt`), so stored text is never displayed. Numbers and host lists from storage are coerced and capped before they are shown, and hosts render as text.

## What is stored
`provenance.receipt` is flat: version, verdict, wording, policy, mode, source, status, start time, duration, request counts, up to 10 host names per class (60 characters each) and which observers were available. A test checks the worst case against the server's receipt limits from Part 4 (depth 3, 40 keys, 300-character strings, 4,000 bytes). The server stores what the client sends and cannot verify it, so a stored receipt is a record, not proof.

## What the receipt cannot see (shown in the UI)
Requests made by the browser itself (Chrome downloading the on-device model), browser extensions, WebSocket connections, anything outside the page, and requests still in flight when the window closed (the wrapper still records fetch and XHR calls that were made). It is a measurement, not a guarantee.

## Tested
- **Tested in sandbox:** classifier (look-alike hosts, userinfo tricks, trailing dots, case, ports), window behaviour with a fake browser (before/after excluded, nesting, dedupe, restore, hostile inputs), verdict table, receipt contents and size limits, reader coercion, export, hybrid integration (window order, every outcome, failing witness), telemetry whitelist, state machine, component states, keyboard-reachable export, summary-panel integration and the unchanged old-summary view.
- **Tested in headless Chromium 157** (local servers, `localhost` page and `127.0.0.1` as the stand-in AI host): five requests made inside the window (fetch, XHR, image, script, same-origin fetch) were all counted and matched the server's log; the requests before and after were excluded; `fetch` was restored; a query-string canary never appeared in the observation or receipt; the image was seen only through Resource Timing.
- **Needs Chrome:** everything involving the real SDK, App Check and the on-device model.

## Manual check (needs Chrome, same profile as Part 3)
Run with DevTools open on the Network tab (extensions off, "Preserve log" on). In the console:

```js
const { getHybridService } = await import("/src/ai/services/hybrid.js");
const { shortMeeting } = await import("/src/ai/golden/index.js");
const svc = getHybridService();
const go = async (extra) => {
  const r = await svc.summarize({ segments: shortMeeting.segments, onEvent: () => {}, ...extra });
  console.log(r.status, r.receipt?.verdict, r.receipt?.requests, r.receipt?.aiHosts, r.receipt?.firebaseHosts);
  return r;
};
```
1. **Local:** `await go({ policy: "local-only" })`. Expect `done`, `local-verified`, and no request to `firebasevertexai.googleapis.com` in the Network tab. Write down the Firebase and same-origin counts; they are not predicted here.
2. **Cloud approved:** `await go({ policy: "ask-before-cloud", phase: "cloud", cloudConsent: true })`. Expect `done`, `cloud`, `requests.ai >= 1`, and the same request in the Network tab.
3. **Offline:** DevTools Network, "Offline", then `await go({ policy: "local-only" })`. Expect `done`, `local-verified`, `requests.ai === 0` (on-device inference needs no network). Then `await go({ policy: "ask-before-cloud", phase: "cloud", cloudConsent: true })`: the run is refused as offline before any window opens, so there is no receipt.
4. **No model (profile without the flag):** `await go({ policy: "local-only" })`: `unsupported`, `no-ai-requests`.

Part 5 is done when the receipt agrees with the Network tab on at least the first three. To see the card, put a receipt on a stored summary or open a transcript whose `aiSummary.provenance.receipt` is set; the in-app button that runs the hybrid service arrives in Part 10.

## Decisions and open points
- A `violation` does not block or discard the summary. Blocking on a measurement that can be wrong in either direction would turn a heuristic into a gate; the policy gate and the source audit remain the enforcement. Say if you want it to fail the run instead.
- The optional body-size heuristic from the plan was **not** built: it would need request bodies or sizes, which this module deliberately never touches.
- The backend still stores the receipt as a small tree of primitives (Part 4). It is not whitelisted by field; the client shape above fits the limits. Tightening it is a follow-up.
- `ownHosts` is supported by `createWitness` (for the app's own API server) but is not configured anywhere yet. Until it is, requests to the backend on another origin appear under "other hosts" and do not affect the verdict.
