import { describe, it, expect } from "vitest";
import { parseModelJson, validateSummary, CAPS } from "./validator.js";
import { prepareTranscript } from "./prepare.js";
import { goldenById, joinText } from "../golden/index.js";
import {
  goodOutput, goodJson, fencedOutput, proseWrappedOutput, truncatedOutput, wrongTypedOutput, emptyOutput, hallucinatedOwnerOutput,
} from "../golden/modelOutputs.js";

const ctxFor = (id) => {
  const g = goldenById[id];
  return { speakers: [...new Set(g.segments.map((s) => s.speaker))], transcriptText: joinText(g.segments) };
};
const codes = (r) => r.issues.map((i) => i.code);

describe("parseModelJson", () => {
  it("parses plain JSON, fenced JSON, fences without a language tag, and prose-wrapped JSON", () => {
    for (const raw of [goodJson(), fencedOutput(), "```\n" + goodJson() + "\n```", proseWrappedOutput()]) {
      const r = parseModelJson(raw);
      expect(r.ok, raw.slice(0, 30)).toBe(true);
      expect(r.value.summary).toBeTruthy();
    }
  });
  it("accepts an already parsed object", () => {
    expect(parseModelJson({ summary: "x" })).toEqual({ ok: true, value: { summary: "x" } });
  });
  it("handles braces and escaped quotes inside strings", () => {
    const r = parseModelJson('note {not json} then {"summary":"has } and \\" quote { inside"}');
    expect(r.ok).toBe(true);
    expect(r.value.summary).toBe('has } and " quote { inside');
  });
  it("truncated JSON never yields an inner fragment as if it were the whole output", () => {
    const r = parseModelJson('{"summary":"s","decisions":[{"text":"d"},{"text":"e"}],"action_items":[{"task":"t"');
    expect(r.ok).toBe(false);
  });
  it("skips an invalid brace group and finds the next valid object", () => {
    const r = parseModelJson('{oops} {"summary":"found"}');
    expect(r).toMatchObject({ ok: true, value: { summary: "found" } });
  });
  it("falls back from a broken fence to the surrounding text", () => {
    const r = parseModelJson('```json\n{broken\n```\n{"summary":"ok"}');
    expect(r.ok).toBe(true);
  });
  it.each([
    [truncatedOutput(), "NOT_JSON"],
    ["not json at all", "NOT_JSON"],
    ["[1,2,3]", "NOT_JSON"],
    ["{", "NOT_JSON"],
    [emptyOutput(), "EMPTY_OUTPUT"],
    ["", "EMPTY_OUTPUT"],
    [undefined, "NOT_JSON"],
    [42, "NOT_JSON"],
    [[1], "NOT_JSON"],
  ])("rejects %# without throwing", (raw, code) => {
    const r = parseModelJson(raw);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
  });
});

describe("validateSummary: structure", () => {
  it("accepts good output from the golden labels and keeps everything", () => {
    const r = validateSummary(goodJson(), ctxFor("short"));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value.action_items).toHaveLength(4);
    expect(r.value.action_items.find((a) => a.owner === "Marcus")).toMatchObject({ deadline: "Wednesday" });
    expect(r.value.decisions).toHaveLength(2);
  });
  it("accepts fenced and prose-wrapped output", () => {
    expect(validateSummary(fencedOutput(), ctxFor("short")).ok).toBe(true);
    expect(validateSummary(proseWrappedOutput(), ctxFor("short")).ok).toBe(true);
  });
  it("fails cleanly on not-JSON, truncated, empty output", () => {
    for (const raw of ["hello", truncatedOutput(), emptyOutput()]) {
      const r = validateSummary(raw, ctxFor("short"));
      expect(r).toMatchObject({ ok: false, value: null });
      expect(r.issues[0].code).toMatch(/NOT_JSON|EMPTY_OUTPUT/);
    }
  });
  it("fails on missing, empty or non-string summary", () => {
    expect(validateSummary({ key_points: [] }).issues[0].code).toBe("MISSING_SUMMARY");
    expect(validateSummary({ summary: null }).issues[0].code).toBe("MISSING_SUMMARY");
    expect(validateSummary({ summary: "   " }).issues[0].code).toBe("MISSING_SUMMARY");
    expect(validateSummary({ summary: 123 }).issues[0].code).toBe("INVALID_TYPE");
    expect(validateSummary({ summary: ["a"] }).ok).toBe(false);
  });
  it("survives wrong-typed fields, keeps what is usable and reports issues", () => {
    const r = validateSummary(wrongTypedOutput(), ctxFor("short"));
    expect(r.ok).toBe(true);
    expect(codes(r)).toContain("INVALID_TYPE");
    expect(r.value.key_points).toEqual([]);
    expect(r.value.decisions).toEqual([]);
    expect(r.value.action_items).toEqual([{ task: "real task", owner: null, deadline: null }]);
  });
  it("drops non-string key points and empty items", () => {
    const r = validateSummary({ summary: "s", key_points: ["a", 5, "  ", "b"], decisions: [{ text: "  " }], action_items: [{ task: "" }] });
    expect(r.value.key_points).toEqual(["a", "b"]);
    expect(r.value.decisions).toEqual([]);
    expect(r.value.action_items).toEqual([]);
  });
  it("accepts plain-string decisions and action items", () => {
    const r = validateSummary({ summary: "s", decisions: ["Ship it"], action_items: ["Fix the bug"] }, ctxFor("short"));
    expect(r.value.decisions).toEqual([{ text: "Ship it" }]);
    expect(r.value.action_items).toEqual([{ task: "Fix the bug", owner: null, deadline: null }]);
  });
  it("tolerates a missing context", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "Marcus", deadline: "Friday" }] });
    expect(r.value.action_items[0]).toMatchObject({ owner: null, deadline: null });
  });
  it("types and caps quote fields", () => {
    const r = validateSummary({ summary: "s", decisions: [{ text: "d", quote: 5 }, { text: "e", quote: "q".repeat(1000) }, { text: "f", quote: "  " }] });
    expect(r.value.decisions[0]).toEqual({ text: "d" });
    expect(r.value.decisions[1].quote).toHaveLength(CAPS.quoteChars);
    expect(r.value.decisions[2]).toEqual({ text: "f" });
    expect(codes(r)).toEqual(expect.arrayContaining(["INVALID_TYPE", "TRUNCATED"]));
  });
  it("does not mutate the input object", () => {
    const input = goodOutput();
    const copy = JSON.parse(JSON.stringify(input));
    validateSummary(input, ctxFor("short"));
    expect(input).toEqual(copy);
  });
});

describe("validateSummary: owner grounding", () => {
  it("removes a hallucinated owner but keeps the item", () => {
    const r = validateSummary(hallucinatedOwnerOutput(), ctxFor("short"));
    expect(r.value.action_items).toHaveLength(1);
    expect(r.value.action_items[0].owner).toBeNull();
    expect(codes(r)).toContain("OWNER_UNGROUNDED");
    expect(r.value.action_items[0].deadline).toBe("Wednesday");
  });
  it("keeps a grounded owner and normalises casing to the speaker's name", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "marcus" }] }, ctxFor("short"));
    expect(r.value.action_items[0].owner).toBe("Marcus");
    expect(r.issues).toEqual([]);
  });
  it("keeps an owner who is named in the transcript but is not a speaker", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "Maria" }] }, ctxFor("pii"));
    expect(r.value.action_items[0].owner).toBe("Maria");
  });
  it("keeps a first-name owner when the speaker label is a full name", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "Priya" }] }, { speakers: ["Priya Sharma"], transcriptText: "hello" });
    expect(r.value.action_items[0].owner).toBe("Priya");
  });
  it("does not match a name inside another word", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "Dev" }] }, { speakers: ["Alice"], transcriptText: "the developer team will handle it" });
    expect(r.value.action_items[0].owner).toBeNull();
    expect(codes(r)).toContain("OWNER_UNGROUNDED");
  });
  it.each(["Team", "Someone", "somebody", "Unassigned", "N/A", "TBD", "Everyone", "we", "none"])("treats %s as a non-name even if the word is in the transcript", (owner) => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner }] }, ctxFor("unstated"));
    expect(r.value.action_items[0].owner).toBeNull();
  });
  it("unstated-owner golden transcript: invented and generic owners are removed, but a group named in the text survives (presence-only limitation)", () => {
    const r = validateSummary({
      summary: "s",
      action_items: [
        { task: "clean folder", owner: "Somebody" },
        { task: "send reminder", owner: "Finance team" },
        { task: "update report", owner: "Zed" },
      ],
    }, ctxFor("unstated"));
    // "Somebody" is a non-name and "Zed" never appears. "Finance team" DOES appear ("the finance team might do it"),
    // so presence-only grounding keeps it even though the fixture label for that item is a null owner.
    expect(r.value.action_items.map((a) => a.owner)).toEqual([null, "Finance team", null]);
  });
  it("handles non-string owners and an empty-string owner", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "a", owner: 5 }, { task: "b", owner: "" }, { task: "c", owner: null }] }, ctxFor("short"));
    expect(r.value.action_items.map((a) => a.owner)).toEqual([null, null, null]);
    expect(codes(r)).toEqual(["INVALID_TYPE"]);
  });
  it("owner grounding is presence only: a speaker who does not own the item is accepted (documented limitation)", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "check analytics events", owner: "Priya" }] }, ctxFor("short"));
    expect(r.value.action_items[0].owner).toBe("Priya");
  });
});

describe("validateSummary: deadline grounding", () => {
  it("keeps a deadline that appears in the transcript", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "Marcus", deadline: "Wednesday" }, { task: "u", deadline: "by Friday" }] }, ctxFor("short"));
    expect(r.value.action_items.map((a) => a.deadline)).toEqual(["Wednesday", "by Friday"]);
    expect(r.issues).toEqual([]);
  });
  it("drops a deadline that does not appear in the transcript", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", deadline: "next Tuesday" }, { task: "u", deadline: "2026-12-02" }] }, ctxFor("short"));
    expect(r.value.action_items.map((a) => a.deadline)).toEqual([null, null]);
    expect(codes(r)).toEqual(["DEADLINE_UNGROUNDED", "DEADLINE_UNGROUNDED"]);
  });
  it("normalises placeholder and non-string deadlines to null", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "a", deadline: "N/A" }, { task: "b", deadline: "Not stated" }, { task: "c", deadline: ["x"] }, { task: "d", deadline: "" }] }, ctxFor("short"));
    expect(r.value.action_items.map((a) => a.deadline)).toEqual([null, null, null, null]);
    expect(codes(r)).toEqual(["INVALID_TYPE"]);
  });
  it("placeholder owners with punctuation are reported as non-names, not as ungrounded", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", owner: "N/A" }] }, ctxFor("short"));
    expect(codes(r)).toEqual(["OWNER_NOT_A_NAME"]);
    expect(r.value.action_items[0].owner).toBeNull();
  });
  it("a deadline that is only a preposition is not grounded", () => {
    const r = validateSummary({ summary: "s", action_items: [{ task: "t", deadline: "by" }] }, ctxFor("short"));
    expect(r.value.action_items[0].deadline).toBeNull();
  });
});

describe("validateSummary: caps", () => {
  it("truncates long strings and caps list lengths", () => {
    const r = validateSummary({
      summary: "s".repeat(5000),
      key_points: Array.from({ length: 30 }, (_, i) => `point ${i} ` + "k".repeat(1000)),
      decisions: Array.from({ length: 30 }, (_, i) => ({ text: `d${i}` })),
      action_items: Array.from({ length: 40 }, (_, i) => ({ task: `t${i}` })),
    });
    expect(r.value.summary).toHaveLength(CAPS.summaryChars);
    expect(r.value.key_points).toHaveLength(CAPS.keyPoints);
    expect(r.value.key_points.every((p) => p.length <= CAPS.keyPointChars)).toBe(true);
    expect(r.value.decisions).toHaveLength(CAPS.decisions);
    expect(r.value.action_items).toHaveLength(CAPS.actionItems);
    expect(codes(r)).toContain("TRUNCATED");
  });
  it("caps overlong owners and deadlines before grounding them", () => {
    const longName = "Marcus" + " x".repeat(100);
    const r = validateSummary({ summary: "s", action_items: [{ task: "t".repeat(900), owner: longName, deadline: "Friday " + "y".repeat(100) }] }, ctxFor("short"));
    expect(r.value.action_items[0].task.length).toBeLessThanOrEqual(CAPS.textChars);
    expect(r.value.action_items[0].owner).toBeNull();
    expect(r.value.action_items[0].deadline).toBeNull();
  });
});

describe("validateSummary: end to end with prepared transcripts", () => {
  it.each(["short", "medium", "pii", "giant-turn"])("accepts the good output for %s using prepared speakers and text", (id) => {
    const prep = prepareTranscript(goldenById[id].segments, { maxChunkChars: 3000 });
    const r = validateSummary(goodJson(id), { speakers: prep.speakers, transcriptText: prep.text });
    expect(r.ok).toBe(true);
    const wantOwners = goldenById[id].expected.actionItems.map((a) => a.owner);
    expect(r.value.action_items.map((a) => a.owner)).toEqual(wantOwners);
  });
});
