// Detects time-bound phrases in text. Used to check that a fixture labelled `deadline: null`
// really has no stated deadline. Regex-based and English-only: it is a fixture-label guard,
// not a deadline extractor, and it will miss phrasings it does not list (see LIMITATIONS).
//
// HARD markers: a deadline is clearly stated. A null label next to one of these is a labelling error.
// SOFT markers: relative or conditional timing ("once X lands", "after Y", "by <something>").
//   These are ambiguous, so they do not fail a null label, but they are surfaced as warnings
//   so the label is a conscious choice.

const NUM = "(?:\\d+|a couple of|a few|a handful of|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few|several)";
const UNIT = "(?:minute|hour|day|week|fortnight|month|quarter|year|sprint|business day|working day)s?";
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|twentieth|thirtieth|\\d{1,2}(?:st|nd|rd|th))";
const MILESTONE = "(?:launch|release|beta|ship|shipping|go live|golive|deploy|deployment|deadline|hearing|meeting|review|audit|demo|kickoff|kick off|freeze|code freeze|sprint)";

export const HARD_MARKERS = [
  { id: "weekday", re: new RegExp(`\\b${WEEKDAY}\\b`, "i") },
  { id: "today-tomorrow", re: /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening)|overnight)\b/i },
  { id: "relative-period", re: new RegExp(`\\b(next|this|last|coming|following|every) (week|weekend|month|quarter|year|sprint|${WEEKDAY})\\b`, "i") },
  { id: "end-of-period", re: new RegExp(`\\b(end of|close of|start of|beginning of) (the )?(day|week|month|quarter|year|sprint|business|q[1-4]|${MONTH})\\b`, "i") },
  { id: "eod-style", re: /\b(eod|eow|eom|eoq|cob|close of business|end of business)\b/i },
  { id: "within", re: new RegExp(`\\bwithin (the next )?${NUM} ${UNIT}\\b`, "i") },
  { id: "in-n-units", re: new RegExp(`\\bin (the next )?${NUM} ${UNIT}\\b`, "i") },
  { id: "n-units-from-now", re: new RegExp(`\\b${NUM} ${UNIT} (from now|from today|from then)\\b`, "i") },
  { id: "clock-time", re: /\b(\d{1,2}(:\d{2})?\s?(am|pm)|noon|midnight)\b/i },
  { id: "numeric-date", re: /\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/ },
  { id: "month-date", re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b${ORD}\\s+(of\\s+)?${MONTH}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MONTH}\\b`, "i") },
  { id: "month-name", re: new RegExp(`\\b(by|before|until|in|during|from) ${MONTH}\\b`, "i") },
  { id: "quarter", re: /\b(q[1-4]|(first|second|third|fourth) quarter)\b/i },
  { id: "before-milestone", re: new RegExp(`\\b(before|until|ahead of|prior to|by) (the )?(next |this |our |your )?${MILESTONE}\\b`, "i") },
  { id: "urgency", re: /\b(asap|immediately|right away|straight away|urgently|as soon as possible)\b/i },
];

export const SOFT_MARKERS = [
  { id: "conditional-trigger", re: /\b(once|after|when|as soon as|following|upon)\b/i },
  { id: "by-something", re: /\bby\s+\S+/i },
  { id: "before-or-until", re: /\b(before|until|ahead of|prior to)\s+\S+/i },
  { id: "soon-ish", re: /\b(shortly|later today|in due course|next time|at the latest|no later than)\b/i },
];

// Not matched on purpose (vague, no stated deadline): "soon", "at some point", "eventually", "sometime".
export const LIMITATIONS = [
  "English only.",
  "Regex based: unusual phrasings (e.g. 'the Monday after next', 'two sprints out') can slip through.",
  "'soon', 'at some point', 'eventually' are treated as no deadline.",
  "Conditional triggers ('once the fix lands') are soft: warned about, not failed.",
];

export function findTimeMarkers(text) {
  const hard = HARD_MARKERS.filter((m) => m.re.test(text)).map((m) => m.id);
  const soft = SOFT_MARKERS.filter((m) => m.re.test(text)).map((m) => m.id);
  return { hard, soft };
}
