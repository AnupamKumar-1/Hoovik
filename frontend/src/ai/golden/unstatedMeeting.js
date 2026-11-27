import { buildSegments } from "./builder.js";

const segments = buildSegments([
  ["Priya", "We need to talk about the vendor onboarding documents. They are a mess.", "disgust"],
  ["Marcus", "Somebody should clean up the shared folder at some point. People keep uploading duplicates.", "neutral"],
  ["Elena", "We ought to send the vendors a reminder about the missing tax forms.", "neutral"],
  ["Dev", "Yes, and someone has to decide which template we standardise on.", "neutral"],
  ["Priya", "Let's not decide the template today. We need more input first.", "neutral"],
  ["Marcus", "Agreed. Also the quarterly report needs updating soon, but nobody has picked it up.", "sad"],
  ["Elena", "I think the finance team might do it, I am not sure.", "neutral"],
  ["Priya", "We will revisit this next week.", "neutral"],
]);

export default {
  id: "unstated",
  description: "Action items exist but owners and deadlines are deliberately unstated.",
  segments,
  expected: {
    decisions: [
      { text: "postpone the template decision", quote: "Let's not decide the template today" },
    ],
    actionItems: [
      { task: "clean up the shared folder", owner: null, deadline: null, quote: "Somebody should clean up the shared folder at some point", attribution: { type: "none" } },
      { task: "send vendors a reminder about missing tax forms", owner: null, deadline: null, quote: "We ought to send the vendors a reminder about the missing tax forms", attribution: { type: "none" } },
      { task: "update the quarterly report", owner: null, deadline: null, quote: "the quarterly report needs updating soon", attribution: { type: "none" } },
    ],
    piiCanaries: [],
  },
};
