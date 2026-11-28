import { buildSegments, buildGiantTurnText } from "./builder.js";

const segments = buildSegments([
  ["Priya", "Elena, please walk us through your contract review.", "neutral"],
  ["Elena", buildGiantTurnText(80), "neutral"],
  ["Priya", "Thanks. Marcus will redline the exit clause by Monday.", "neutral"],
]);

export default {
  id: "giant-turn",
  description: "One speaker turn of roughly 12k characters, to force sentence-level chunking.",
  segments,
  expected: {
    decisions: [],
    actionItems: [
      { task: "redline the exit clause", owner: "Marcus", deadline: "Monday", quote: "Marcus will redline the exit clause by Monday", attribution: { type: "explicit" } },
    ],
    piiCanaries: [],
  },
};
