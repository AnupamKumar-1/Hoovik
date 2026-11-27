import { describe, it, expect } from "vitest";
import { GOLDEN, goldenById, joinText } from "./index.js";
import { checkAttribution, checkDeadline, ATTRIBUTION_TYPES } from "./attribution.js";

// Shape produced by transcript_service merge_segments().
const SEGMENT_KEYS = ["start", "end", "speaker", "text", "emotion", "emoji"];
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// NOTE: these are fixture-integrity tests. They check that hand-written labels are consistent with
// the transcript text. They do NOT measure how accurately any model extracts decisions or action
// items; that is measured in Part 11 against these labels.

describe("golden fixtures: shape", () => {
  it.each(GOLDEN.map((g) => [g.id, g]))("%s segments match the transcript service shape", (_id, g) => {
    expect(g.segments.length).toBeGreaterThan(0);
    g.segments.forEach((s, i) => {
      expect(Object.keys(s).sort(), `segment ${i}`).toEqual([...SEGMENT_KEYS].sort());
      expect(typeof s.start).toBe("number");
      expect(typeof s.end).toBe("number");
      expect(s.end).toBeGreaterThan(s.start);
      expect(typeof s.speaker).toBe("string");
      expect(s.speaker.length).toBeGreaterThan(0);
      expect(s.text.trim()).toBe(s.text);
      expect(s.text.length).toBeGreaterThan(0);
      expect(typeof s.emotion).toBe("string");
      expect(typeof s.emoji).toBe("string");
    });
  });

  it.each(GOLDEN.map((g) => [g.id, g]))("%s segments are sorted by start time", (_id, g) => {
    for (let i = 1; i < g.segments.length; i++) {
      expect(g.segments[i].start).toBeGreaterThanOrEqual(g.segments[i - 1].start);
    }
  });

  it("ids are unique", () => {
    expect(new Set(GOLDEN.map((g) => g.id)).size).toBe(GOLDEN.length);
  });
});

describe("golden fixtures: size targets", () => {
  const len = (id) => joinText(goldenById[id].segments).length;
  it("short is about 2.5k characters", () => {
    expect(len("short")).toBeGreaterThan(1800);
    expect(len("short")).toBeLessThan(3200);
  });
  it("medium is about 9k characters", () => {
    expect(len("medium")).toBeGreaterThan(7500);
    expect(len("medium")).toBeLessThan(11000);
  });
  it("long is about 30k characters", () => {
    expect(len("long")).toBeGreaterThan(26000);
    expect(len("long")).toBeLessThan(36000);
  });
  it("giant-turn has one enormous single turn", () => {
    const longest = Math.max(...goldenById["giant-turn"].segments.map((s) => s.text.length));
    expect(longest).toBeGreaterThan(10000);
  });
});

describe("golden fixtures: label integrity (not model accuracy)", () => {
  const each = GOLDEN.map((g) => [g.id, g]);

  it.each(each)("%s: every expected quote appears verbatim (normalised) in a single segment", (_id, g) => {
    const hay = norm(joinText(g.segments));
    for (const d of g.expected.decisions) expect(hay, d.quote).toContain(norm(d.quote));
    for (const a of g.expected.actionItems) {
      expect(hay, a.quote).toContain(norm(a.quote));
      expect(g.segments.some((s) => norm(s.text).includes(norm(a.quote))), a.quote).toBe(true);
    }
  });

  it.each(each)("%s: every action item's owner is justified by its declared attribution", (_id, g) => {
    for (const a of g.expected.actionItems) {
      const r = checkAttribution(g.segments, a);
      expect(r, `${a.task}: ${r.reason}`).toEqual({ ok: true });
    }
  });

  it.each(each)("%s: stated deadlines are in the quote; null deadlines have no time marker nearby", (_id, g) => {
    for (const a of g.expected.actionItems) {
      const r = checkDeadline(a, g.segments);
      expect(r.ok, `${a.task}: ${r.reason}`).toBe(true);
    }
  });

  // Negative controls: prove the owner check can fail. Swapping in another speaker must be rejected.
  it.each(each)("%s: attribution check rejects a wrong owner", (_id, g) => {
    const speakers = [...new Set(g.segments.map((s) => s.speaker))];
    for (const a of g.expected.actionItems.filter((x) => x.owner !== null)) {
      for (const wrong of speakers.filter((sp) => sp !== a.owner)) {
        expect(checkAttribution(g.segments, a, wrong).ok, `${a.task} wrongly accepted ${wrong}`).toBe(false);
      }
    }
  });

  it("check rejects an owner who merely appears in the transcript (the old permissive rule)", () => {
    const g = goldenById.short;
    const dev = g.expected.actionItems.find((a) => a.owner === "Dev");
    // Marcus is a speaker and is mentioned in Dev's context turn, but does not own this item.
    expect(checkAttribution(g.segments, dev, "Marcus").ok).toBe(false);
  });

  it("the conditional 'once his fix lands' item is a null deadline that surfaces a soft-marker warning", () => {
    const dev = goldenById.short.expected.actionItems.find((a) => a.owner === "Dev");
    const r = checkDeadline(dev, goldenById.short.segments);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("conditional-trigger");
  });

  it("checkDeadline rejects a null label when the surrounding text states a deadline", () => {
    const g = goldenById.short;
    const marcus = g.expected.actionItems.find((a) => a.owner === "Marcus");
    // Same item mislabelled with null: the quote says "by Wednesday".
    expect(checkDeadline({ ...marcus, deadline: null }, g.segments).ok).toBe(false);
    // And a deadline appearing only in the context turn is caught too.
    const segs = [
      { start: 0, end: 1, speaker: "Priya", text: "Dev, can you send the estimate before launch?", emotion: "neutral", emoji: "😐" },
      { start: 2, end: 3, speaker: "Dev", text: "Sure, I will send the estimate.", emotion: "neutral", emoji: "😐" },
    ];
    const item = { task: "send estimate", owner: "Dev", deadline: null, quote: "I will send the estimate", attribution: { type: "contextual", contextQuote: "Dev, can you send the estimate before launch" } };
    expect(checkDeadline(item, segs).ok).toBe(false);
  });

  it("every action item declares a known attribution type", () => {
    for (const g of GOLDEN) for (const a of g.expected.actionItems) expect(ATTRIBUTION_TYPES).toContain(a.attribution?.type);
  });

  it("the short transcript includes a contextual-ownership item, treated as its own category", () => {
    const ctx = goldenById.short.expected.actionItems.filter((a) => a.attribution.type === "contextual");
    expect(ctx.length).toBeGreaterThanOrEqual(1);
    for (const a of ctx) expect(norm(a.quote)).not.toContain(norm(a.owner));
  });

  it("unstated transcript has no owner or deadline and every item is attribution none", () => {
    for (const a of goldenById.unstated.expected.actionItems) {
      expect(a.owner).toBeNull();
      expect(a.deadline).toBeNull();
      expect(a.attribution.type).toBe("none");
    }
  });

  it("pii canaries are all present in the pii transcript and nowhere else", () => {
    const text = joinText(goldenById.pii.segments);
    for (const c of goldenById.pii.expected.piiCanaries) expect(text).toContain(c);
    for (const g of GOLDEN.filter((x) => x.id !== "pii")) {
      for (const c of goldenById.pii.expected.piiCanaries) expect(joinText(g.segments), g.id).not.toContain(c);
    }
  });

  it("generated fixtures are deterministic", async () => {
    const { buildAgendaMeeting } = await import("./builder.js");
    expect(buildAgendaMeeting(5)).toEqual(buildAgendaMeeting(5));
  });
});
