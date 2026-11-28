import { describe, it, expect } from "vitest";
import { validateSummary } from "./validator.js";
import { prepareTranscript } from "./prepare.js";
import { goldenById, joinText } from "../golden/index.js";
import { checkAttribution } from "../golden/attribution.js";

const ctxFor = (id, extra = {}) => {
  const g = goldenById[id];
  const { turns } = prepareTranscript(g.segments);
  return { speakers: [...new Set(g.segments.map((s) => s.speaker))], transcriptText: joinText(g.segments), turns, ...extra };
};
const outputFor = (id, overrides = (a) => a) =>
  JSON.stringify({
    summary: "Beta launch sync.",
    key_points: ["Beta ships 5 December"],
    decisions: [],
    action_items: goldenById[id].expected.actionItems.map((a) => overrides({ task: a.task, owner: a.owner, deadline: a.deadline })),
  });
const owners = (r) => r.value.action_items.map((a) => a.owner);
const codes = (r) => r.issues.map((i) => i.code);

describe("owner anchoring (ctx.turns supplied)", () => {
  it.each(["short", "medium", "pii", "giant-turn"])("%s: every correct owner is anchored", (id) => {
    const r = validateSummary(outputFor(id), ctxFor(id));
    expect(r.ok).toBe(true);
    for (const a of r.value.action_items) expect(a.ownerGrounding, a.task).toBe("anchored");
  });

  it("anchors the contextual owner (Dev) via Priya's request and Dev's reply", () => {
    const r = validateSummary(outputFor("short"), ctxFor("short"));
    const dev = r.value.action_items.find((a) => a.owner === "Dev");
    expect(dev.ownerGrounding).toBe("anchored");
  });

  it("does not anchor a speaker who is merely mentioned in the request turn (Marcus for Dev's task)", () => {
    const r = validateSummary(outputFor("short", (a) => (a.owner === "Dev" ? { ...a, owner: "Marcus" } : a)), ctxFor("short"));
    const wrong = r.value.action_items.find((a) => a.task.startsWith("check analytics"));
    expect(wrong.owner).toBe("Marcus");
    expect(wrong.ownerGrounding).toBe("present");
  });

  it("strictOwners drops present-only owners with OWNER_UNANCHORED", () => {
    const r = validateSummary(
      outputFor("short", (a) => (a.owner === "Dev" ? { ...a, owner: "Marcus" } : a)),
      ctxFor("short", { strictOwners: true })
    );
    const wrong = r.value.action_items.find((a) => a.task.startsWith("check analytics"));
    expect(wrong.owner).toBeNull();
    expect(codes(r)).toContain("OWNER_UNANCHORED");
    expect(owners(r).filter(Boolean).sort()).toEqual(["Elena", "Marcus", "Priya"]);
  });

  it("a hallucinated owner is still removed by presence grounding, before anchoring", () => {
    const r = validateSummary(outputFor("short", (a) => ({ ...a, owner: "Jonathan" })), ctxFor("short"));
    expect(owners(r).every((o) => o === null)).toBe(true);
    expect(codes(r)).toContain("OWNER_UNGROUNDED");
    expect(r.value.action_items.every((a) => a.ownerGrounding === undefined)).toBe(true);
  });

  it("every anchored golden owner is also accepted by the fixture attribution rules (same notion of ownership)", () => {
    for (const id of ["short", "pii", "giant-turn"]) {
      const g = goldenById[id];
      const r = validateSummary(outputFor(id), ctxFor(id));
      r.value.action_items.forEach((a, i) => {
        expect(a.ownerGrounding).toBe("anchored");
        expect(checkAttribution(g.segments, g.expected.actionItems[i]).ok).toBe(true);
      });
    }
  });

  it("unstated transcript: an invented owner who is a speaker is present-only, never anchored", () => {
    const r = validateSummary(outputFor("unstated", (a) => ({ ...a, owner: "Marcus" })), ctxFor("unstated"));
    for (const a of r.value.action_items.filter((x) => x.owner)) expect(a.ownerGrounding).not.toBe("anchored");
  });

  it("without ctx.turns behaviour is unchanged: no ownerGrounding field", () => {
    const c = ctxFor("short");
    delete c.turns;
    const r = validateSummary(outputFor("short"), c);
    expect(r.value.action_items.every((a) => !("ownerGrounding" in a))).toBe(true);
  });
});
