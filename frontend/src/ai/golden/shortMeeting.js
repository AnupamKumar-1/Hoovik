import { buildSegments } from "./builder.js";

const segments = buildSegments([
  ["Priya", "Morning everyone. Quick sync on the beta launch. Where are we on the checklist?", "neutral"],
  ["Marcus", "Backend is stable. The only blocker is the onboarding crash on older Android phones.", "neutral"],
  ["Priya", "How bad is that crash? Is it a few users or most of them?", "fear"],
  ["Marcus", "About eight percent of test installs. I can fix it, it is a null check in the permission screen.", "neutral"],
  ["Elena", "From the customer side, our design partners are keen. Two of them asked for a pricing page before they commit.", "happy"],
  ["Dev", "Pricing is still undecided though. Do we charge from day one of the beta?", "neutral"],
  ["Priya", "No. We decided last week the beta stays free until the first of January.", "neutral"],
  ["Elena", "Good, that makes the pricing copy much simpler. I can draft it.", "happy"],
  ["Priya", "Then let's ship the beta on the fifth of December if the crash is fixed.", "happy"],
  ["Marcus", "I will fix the onboarding crash by Wednesday.", "neutral"],
  ["Elena", "And I will draft the pricing page copy by Friday.", "neutral"],
  ["Elena", "One more thing from the calls. Partners keep asking whether their data can be exported if they decide to leave. I told them yes, but I want to be sure that is true.", "neutral"],
  ["Dev", "It is true for the core records. The export for attachments is slower and sometimes times out, so I would call it best effort for now.", "neutral"],
  ["Priya", "Fine, let's describe it honestly on the launch page as best effort. I do not want to promise something we cannot back up.", "neutral"],
  ["Marcus", "While we are on risks, the staging server ran out of disk last night. It did not affect testers but it could on launch day.", "fear"],
  ["Dev", "I already doubled the volume this morning and added an alert, so we have plenty of room now.", "happy"],
  ["Elena", "Nice. Also, can we keep the feedback form short? Partners complained the last one took twenty minutes to fill out.", "sad"],
  ["Priya", "Yes, five questions maximum. Marcus, you own that form since you built it, but there is no rush on it.", "neutral"],
  ["Priya", "Great. Dev, can you check the analytics events still fire after Marcus changes the permission screen?", "neutral"],
  ["Dev", "Sure, I will take that once his fix lands.", "neutral"],
  ["Priya", "I will also email the design partners with the launch date. Thanks everyone.", "happy"],
]);

export default {
  id: "short",
  description: "Short founders sync, about 1.9k characters, one clear decision set.",
  segments,
  expected: {
    decisions: [
      { text: "ship the beta on 5 December if the crash is fixed", quote: "let's ship the beta on the fifth of December if the crash is fixed" },
      { text: "beta stays free until 1 January", quote: "the beta stays free until the first of January" },
    ],
    actionItems: [
      { task: "fix the onboarding crash", owner: "Marcus", deadline: "Wednesday", quote: "I will fix the onboarding crash by Wednesday", attribution: { type: "self" } },
      { task: "draft the pricing page copy", owner: "Elena", deadline: "Friday", quote: "I will draft the pricing page copy by Friday", attribution: { type: "self" } },
      { task: "check analytics events still fire", owner: "Dev", deadline: null, quote: "I will take that once his fix lands", attribution: { type: "contextual", contextQuote: "Dev, can you check the analytics events still fire after Marcus changes the permission screen" } },
      { task: "email the design partners with the launch date", owner: "Priya", deadline: null, quote: "I will also email the design partners with the launch date", attribution: { type: "self" } },
    ],
    piiCanaries: [],
  },
};
