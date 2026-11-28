import { buildAgendaMeeting } from "./builder.js";

const medium = buildAgendaMeeting(12);
const long = buildAgendaMeeting(40);

export const mediumMeeting = {
  id: "medium",
  description: "Agenda meeting of 12 topics, about 9k characters, forces chunking.",
  segments: medium.segments,
  expected: { decisions: medium.decisions, actionItems: medium.actionItems, piiCanaries: [] },
};

export const longMeeting = {
  id: "long",
  description: "Agenda meeting of 40 topics, about 30k characters, forces the too-long state.",
  segments: long.segments,
  expected: { decisions: long.decisions, actionItems: long.actionItems, piiCanaries: [] },
};
