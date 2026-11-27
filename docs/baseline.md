# Baseline (Part 0)

Recorded on branch point `pre-hybrid-ai-baseline` (commit e36b788, `main`), 27 Nov 2026.

| Check | Result |
|---|---|
| Frontend `npm test` (vitest) | 1 file, 1 test, passing |
| Frontend `vite build` | succeeds; one chunk-size warning (>500 kB), pre-existing |
| Backend `npm run test:unit` | 9 files, 109 tests, all passing |
| Backend Redis integration tests | not run locally (needs Redis; CI runs them) |
| Emotion / transcript Python services | not run (CI only lints and compile-checks) |
| Known failing tests | none |

## Pre-existing facts worth knowing
- CI frontend job used stale `REACT_APP_*` variables; the app reads `VITE_*`. Fixed on the feature branch.
- CI did not run frontend tests before this branch.
- The Groq summary is built in `backend/src/services/transcript.service.js` (`buildGroqPrompt`), stored in `Transcript.aiSummary` (Mixed), and rendered by `SummaryPanel` in `frontend/src/pages/TranscriptViewer.jsx`.
- `SummaryPanel` reads: `summary`, `key_points`, `insights.{dominant_emotion, emotion_distribution, emotional_moments, top_topics, speaker_stats, discrepancies, total_words, speaking_pace_wpm, total_duration_sec}`.
- Segment shape from the transcript service: `{start, end, speaker, text, emotion, emoji}`; stored at `metadata.segments`.

## Still to do by hand (needs Chrome)
- Click through the current Groq summary once and screenshot it for the before/after.

## What the golden fixtures do and do not test
- `frontend/src/ai/golden/golden.test.js` checks **label integrity**: that hand-written expected labels are consistent with the transcript (shape, size, quotes present, owner and deadline justified). It does **not** measure how accurately any model extracts decisions or action items. Model accuracy (precision, recall, ungrounded-owner rate) is measured in Part 11 against these labels.
- Every expected action item declares an `attribution` type, checked by `attribution.js`:
  - `explicit`: owner named in the quote.
  - `self`: owner is the speaker of the quote and commits in first person.
  - `contextual`: the quote does not name the owner; an earlier turn addresses them and they reply. The short transcript's Dev item ("Sure, I will take that once his fix lands") is the deliberate example, with Marcus as a distractor.
  - `none`: no owner stated anywhere; expected owner is null.
- Part 11 should report extraction results broken down by attribution type, since contextual items are the hardest.
- Negative-control tests confirm the owner check rejects wrong owners, including one who is merely a speaker or mentioned in the transcript.

## Null-deadline guard
`checkDeadline` (via `deadlinePhrases.js`) fails a `deadline: null` label if the quote, its whole segment, or the contextual request turn contains a **hard** time marker: weekdays, today/tomorrow/tonight, next/this week/month/quarter, end of day/week/month, EOD, within/in N units, clock times, numeric and written dates, months, quarters, before/until/ahead of a milestone (launch, release, beta, audit...), and urgency words (asap, immediately).
**Soft** markers (once/after/when, "by <x>", "before <x>") do not fail, but are returned as warnings; the "once his fix lands" item is the deliberate example.
Limitations: English only; regex based, so unusual phrasings can slip through; "soon", "at some point", "eventually" are treated as no deadline.
