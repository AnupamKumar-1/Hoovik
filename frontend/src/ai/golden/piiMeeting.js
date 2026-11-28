import { buildSegments } from "./builder.js";

export const PII_CANARIES = [
  "maria.lopez@northwind-legal.example",
  "+1 (415) 555-0137",
  "884-22-1907",
  "0012345678901",
  "$48,500",
  "https://intranet.northwind.example/cases/2291",
  "Rahul Venkataraman",
];

const segments = buildSegments([
  ["Priya", "Let's review the Northwind matter. The client contact is Maria Lopez, her email is maria.lopez@northwind-legal.example.", "neutral"],
  ["Marcus", "Her direct line is +1 (415) 555-0137 if we need to reach her before the hearing.", "neutral"],
  ["Elena", "The case file is at https://intranet.northwind.example/cases/2291, and the claimant's reference is 884-22-1907.", "neutral"],
  ["Dev", "For the settlement they proposed $48,500 paid into account 0012345678901 within thirty days.", "neutral"],
  ["Priya", "That seems low. Rahul Venkataraman at the other firm said they would go higher if we respond this week.", "anger"],
  ["Marcus", "I will send Maria the counter proposal by Thursday.", "neutral"],
  ["Elena", "We agreed to reject the first offer and counter above the proposed figure.", "neutral"],
  ["Dev", "Understood. I will prepare the supporting document bundle by Friday.", "neutral"],
  ["Priya", "The meeting number 2291 is a case number, not a phone number, and the page count of 120 is just pages. Please keep those apart.", "neutral"],
]);

export default {
  id: "pii",
  description: "Synthetic transcript with deliberate PII (email, phone, ID, account, money, URL, outside name).",
  segments,
  expected: {
    decisions: [
      { text: "reject the first offer and counter above the proposed figure", quote: "We agreed to reject the first offer and counter above the proposed figure" },
    ],
    actionItems: [
      { task: "send Maria the counter proposal", owner: "Marcus", deadline: "Thursday", quote: "I will send Maria the counter proposal by Thursday", attribution: { type: "self" } },
      { task: "prepare the supporting document bundle", owner: "Dev", deadline: "Friday", quote: "I will prepare the supporting document bundle by Friday", attribution: { type: "self" } },
    ],
    piiCanaries: PII_CANARIES,
    // Things that look like sensitive numbers but are not (negative examples for Part 6).
    notPii: ["2291 is a case number", "page count of 120", "thirty days"],
  },
};
