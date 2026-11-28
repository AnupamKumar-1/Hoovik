import { describe, it, expect } from "vitest";
import { SUMMARY_SCHEMA, buildCloudSchema, buildChunkPrompt, buildMergePrompt, deterministicMerge, splitChunkText } from "./prompt.js";
import { prepareTranscript } from "./prepare.js";
import { longMeeting, giantTurnMeeting } from "../golden/index.js";

describe("buildChunkPrompt", () => {
  it("contains the transcript and the rules, in the user prompt", () => {
    const p = buildChunkPrompt({ transcriptText: "[0:00] Priya: hello" });
    expect(p).toContain("[0:00] Priya: hello");
    expect(p).toMatch(/ONE JSON object/);
    expect(p).toMatch(/null if not stated/);
    expect(p).not.toMatch(/part \d of/);
  });
  it("marks parts of a longer meeting", () => {
    expect(buildChunkPrompt({ transcriptText: "x", index: 1, total: 3 })).toContain("part 2 of 3");
  });
});

describe("schemas", () => {
  it("on-device schema requires the four fields and allows null owner and deadline", () => {
    expect(SUMMARY_SCHEMA.required).toEqual(["summary", "key_points", "decisions", "action_items"]);
    const item = SUMMARY_SCHEMA.properties.action_items.items;
    expect(item.properties.owner.type).toEqual(["string", "null"]);
    expect(item.properties.deadline.type).toEqual(["string", "null"]);
  });
  it("cloud schema is built from the SDK helper it is given", () => {
    const Schema = {
      string: (o) => ({ t: "string", ...o }),
      array: (o) => ({ t: "array", ...o }),
      object: (o) => ({ t: "object", ...o }),
    };
    const s = buildCloudSchema(Schema);
    expect(Object.keys(s.properties)).toEqual(["summary", "key_points", "decisions", "action_items"]);
    expect(s.properties.action_items.items.properties.owner).toEqual({ t: "string", nullable: true });
  });
});

describe("buildMergePrompt", () => {
  it("carries only the partial analyses, never transcript text or extra fields", () => {
    const partials = [
      { summary: "A", key_points: ["k"], decisions: [{ text: "d", quote: "SECRET QUOTE" }], action_items: [{ task: "t", owner: "Marcus", deadline: null, ownerGrounding: "anchored", quote: "SECRET QUOTE" }] },
      { summary: "B", key_points: [], decisions: [], action_items: [] },
    ];
    const p = buildMergePrompt({ partials });
    expect(p).toContain('"summary":"A"');
    expect(p).toContain('"owner":"Marcus"');
    expect(p).not.toContain("SECRET QUOTE");
    expect(p).not.toContain("ownerGrounding");
  });
});

describe("deterministicMerge", () => {
  it("unions and de-duplicates case-insensitively", () => {
    const m = deterministicMerge([
      { summary: "One.", key_points: ["Beta is free", "Crash"], decisions: [{ text: "Ship 5 Dec" }], action_items: [{ task: "Fix crash", owner: "Marcus", deadline: "Wednesday" }] },
      { summary: "Two.", key_points: ["beta is free", "Pricing"], decisions: [{ text: "ship 5 dec" }, { text: "Free until Jan" }], action_items: [{ task: "fix crash", owner: null, deadline: null }, { task: "Draft copy", owner: "Elena" }] },
    ]);
    expect(m.summary).toBe("One. Two.");
    expect(m.key_points).toEqual(["Beta is free", "Crash", "Pricing"]);
    expect(m.decisions.map((d) => d.text)).toEqual(["Ship 5 Dec", "Free until Jan"]);
    expect(m.action_items.map((a) => a.task)).toEqual(["Fix crash", "Draft copy"]);
    expect(m.action_items[0].owner).toBe("Marcus");
    expect(m.action_items[1].deadline).toBeNull();
  });
  it("tolerates missing lists and blank entries", () => {
    const m = deterministicMerge([{ summary: "x" }, { summary: "y", key_points: ["", "  "], decisions: [{ text: "" }], action_items: [{ task: "" }] }]);
    expect(m.key_points).toEqual([]);
    expect(m.decisions).toEqual([]);
    expect(m.action_items).toEqual([]);
  });
});

describe("splitChunkText", () => {
  it("splits a single line inside its text and keeps the speaker prefix on both halves", () => {
    const [a, b] = splitChunkText("[1:05] Priya: First sentence here. Second sentence here. Third sentence here.");
    expect(a.startsWith("[1:05] Priya: ")).toBe(true);
    expect(b.startsWith("[1:05] Priya: ")).toBe(true);
    const body = (x) => x.replace("[1:05] Priya: ", "");
    expect(`${body(a)} ${body(b)}`).toBe("First sentence here. Second sentence here. Third sentence here.");
  });
  it("splits a single sentence on a space when there is no sentence boundary", () => {
    const [a, b] = splitChunkText("[0:00] Dev: one two three four five six seven eight");
    expect(`${a.replace("[0:00] Dev: ", "")} ${b.replace("[0:00] Dev: ", "")}`).toBe("one two three four five six seven eight");
  });
  it("splits plain text that has no line prefix", () => {
    const [a, b] = splitChunkText("alpha beta gamma delta");
    expect(`${a} ${b}`).toBe("alpha beta gamma delta");
  });
  it("returns null for one unbroken word", () => {
    expect(splitChunkText("[0:00] Dev: " + "x".repeat(50))).toBeNull();
    expect(splitChunkText("x".repeat(50))).toBeNull();
  });
  it("splits on a line boundary and loses nothing", () => {
    const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
    const [a, b] = splitChunkText(text);
    expect(a).toBe("aaaa\nbbbb");
    expect(b).toBe("cccc\ndddd");
    expect(`${a}\n${b}`).toBe(text);
  });
  it("two lines split one each; first line heavier still leaves both non-empty", () => {
    const [a, b] = splitChunkText(`${"x".repeat(100)}\ny`);
    expect(a).toBe("x".repeat(100));
    expect(b).toBe("y");
  });
  it("splitting every chunk of the long fixture twice preserves every line", () => {
    const { chunks, lines } = prepareTranscript(longMeeting.segments, { maxChunkChars: 24000 });
    const rejoined = [];
    for (const c of chunks) {
      const [a, b] = splitChunkText(c.text);
      for (const half of [a, b]) {
        const sub = splitChunkText(half);
        rejoined.push(...(sub ? [...sub[0].split("\n"), ...sub[1].split("\n")] : half.split("\n")));
      }
    }
    expect(rejoined).toEqual(lines);
  });
  it("a chunk that is a single giant-turn line can still be split, and repeatedly, without losing a word", () => {
    const { chunks } = prepareTranscript(giantTurnMeeting.segments, { maxChunkChars: 3000 });
    expect(chunks.length).toBeGreaterThan(1);
    const single = chunks.find((c) => !c.text.includes("\n"));
    expect(single).toBeDefined();
    const words = (x) => x.replace(/\[[^\]]*\] [^:]*: /g, "").split(/\s+/).filter(Boolean);
    const [a, b] = splitChunkText(single.text);
    expect(words(a).length).toBeGreaterThan(0);
    expect(words(b).length).toBeGreaterThan(0);
    expect([...words(a), ...words(b)]).toEqual(words(single.text));
    const [a1, a2] = splitChunkText(a);
    expect([...words(a1), ...words(a2)]).toEqual(words(a));
  });
});
