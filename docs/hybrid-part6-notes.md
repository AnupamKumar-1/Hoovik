# Part 6: redact-then-send and sensitivity routing

## What it does

- **Redaction before any cloud call.** Every mode that can reach the cloud (cloud-only, auto-fallback, and the approved cloud phase of ask-before-cloud) sends redacted text. The transcript is normalised, redacted locally, then prepared and chunked. The model only ever sees placeholders such as `<EMAIL_1>` or `<PERSON_2>`.
- **Restore on this device.** Placeholders in the model's answer are replaced with the originals locally. Speaker statistics and other insights are computed from the original segments. The placeholder-to-original mapping exists only in memory for the length of one run; it is never stored, logged, sent, or returned.
- **Local-only never redacts**, because nothing leaves the device.
- **If redaction itself throws, the run is refused.** The original text is never used as a fallback.
- **Preview.** `buildCloudPreview` (also exposed as `useHybridSummary().cloudPreview` while consent is required) returns original and redacted rows side by side, counts by category and a sensitivity estimate. `RedactionPreview` renders it. It is presentational: the consent dialog (Part 10) hosts it and owns the approve and decline buttons.
- **Sensitivity score.** Counts of redactable items plus a starter keyword list give `low`, `medium` or `high`. `recommendPolicy` preselects local-only for `high` unless the person chose a policy explicitly, and flags a warning for `medium` and `high`.

## What is redacted

| Category | Placeholder | Notes |
| --- | --- | --- |
| Email addresses | `<EMAIL_n>` | |
| Links | `<URL_n>` | Trailing punctuation stays outside the placeholder |
| Money amounts | `<AMOUNT_n>` | Symbol forms (`$48,500`) and word forms (`3,000 dollars`) |
| Phone numbers | `<PHONE_n>` | 9 to 15 digits with separators |
| Ids and long numbers | `<ID_n>` | `123-45-6789` style, and any run of 6 or more digits |
| Names | `<PERSON_n>` | Speaker labels, caller-supplied names, and runs of two or more capitalised words |
| Listed terms | `<TERM_n>` | Caller-supplied domain terms |

Deadlines (days, dates in words) are deliberately left alone so the validator can still ground them.

## Limits, stated plainly

- It is best effort, not anonymisation.
- A name that is not a speaker and is not written as two or more capitalised words (a lone first name, a lower-case name) is not caught, except that a lone first name seen after the same person's full name shares that placeholder.
- The capitalised-words rule can over-redact (for example a two-word project name). That is the intended failure direction.
- Amounts written in words ("five thousand dollars") and facts that identify someone indirectly are not caught.
- A lone first name restored after redaction comes back as the full name.
- Under auto-fallback the on-device attempt also receives redacted text, because the service cannot know in advance that the run will stay local. This can lower local summary quality.
- The sensitivity score is a heuristic from simple rules. It can miss sensitive content and flag harmless content.
- The starter keyword lists cover legal, healthcare, HR and finance generally. Tighten them once the target user is chosen.

## Stored data

`provenance.redaction` holds counts only (`applied`, `entities`, `total`, `byCategory`). The backend sanitiser keeps exactly those fields and drops anything else. Telemetry gains `redacted` and `redactedItems`, still metrics only.
