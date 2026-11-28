// Canned "model outputs" so validator and orchestration tests never need a real model.
import { goldenById } from "./index.js";

const base = (fixture) => ({
  summary: "The team reviewed launch readiness and agreed next steps.",
  key_points: ["Beta stays free until January", "Onboarding crash is the main blocker"],
  decisions: fixture.expected.decisions.map((d) => ({ text: d.text, quote: d.quote })),
  action_items: fixture.expected.actionItems.map((a) => ({ task: a.task, owner: a.owner, deadline: a.deadline, quote: a.quote })),
});

export const goodOutput = (id = "short") => base(goldenById[id]);
export const goodJson = (id = "short") => JSON.stringify(goodOutput(id));
export const fencedOutput = (id = "short") => "```json\n" + goodJson(id) + "\n```";
export const proseWrappedOutput = (id = "short") => `Here is the analysis you asked for:\n${goodJson(id)}\nLet me know if you need more.`;
export const truncatedOutput = (id = "short") => goodJson(id).slice(0, Math.floor(goodJson(id).length * 0.6));
export const wrongTypedOutput = () => JSON.stringify({
  summary: "ok", key_points: "not an array", decisions: [42, { text: 7 }], action_items: [{ task: 5 }, null, { task: "real task", owner: 12, deadline: ["x"] }],
});
export const emptyOutput = () => "   ";
export const hallucinatedOwnerOutput = () => JSON.stringify({
  summary: "s", action_items: [{ task: "Do the thing", owner: "Zebediah Quillfeather", deadline: "Wednesday" }],
});
