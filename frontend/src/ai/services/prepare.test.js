import { describe, it, expect } from "vitest";
import { prepareTranscript, normalizeSegments, mergeTurns, formatTime, formatLine, splitSentences, chunkLines, TranscriptError, MIN_CHUNK_CHARS, DEFAULT_MAX_CHUNK_CHARS } from "./prepare.js";
import { GOLDEN, goldenById } from "../golden/index.js";

const seg = (speaker, text, start = 0, end = start + 1, emotion = "neutral") => ({ speaker, text, start, end, emotion, emoji: "" });
const squash = (s) => s.replace(/\s+/g, " ").trim();

describe("prepare: input validation", () => {
  it.each([[[]], [[seg("A", "   ")]], [[null, undefined, 5]], [""], ["   \n\t "]])("rejects empty or whitespace input %#", (input) => {
    expect(() => prepareTranscript(input)).toThrowError(expect.objectContaining({ code: "EMPTY_TRANSCRIPT" }));
  });
  it("rejects non-array, non-string input", () => {
    expect(() => prepareTranscript({ a: 1 })).toThrow(TranscriptError);
    expect(() => prepareTranscript(null)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("rejects an invalid chunk limit", () => {
    for (const bad of [0, 50, MIN_CHUNK_CHARS - 1, 1.5, "6000", NaN]) {
      expect(() => prepareTranscript([seg("A", "hi")], { maxChunkChars: bad })).toThrowError(expect.objectContaining({ code: "INVALID_LIMIT" }));
    }
  });
  it("accepts a plain string as one Unknown-speaker segment", () => {
    const r = prepareTranscript("  Hello   there. ");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ speaker: "Unknown", text: "Hello there." });
  });
});

describe("prepare: normalisation", () => {
  it("collapses whitespace, defaults speaker, lowercases emotion", () => {
    const [s] = normalizeSegments([{ speaker: "  ", text: " a \n b\t c ", start: 1, end: 2, emotion: " HAPPY " }]);
    expect(s).toMatchObject({ speaker: "Unknown", text: "a b c", emotion: "happy" });
  });
  it("canonicalises speaker casing to the first-seen form", () => {
    const out = normalizeSegments([seg("Priya", "one", 0), seg("priya ", "two", 2), seg("PRIYA", "three", 4)]);
    expect(new Set(out.map((s) => s.speaker))).toEqual(new Set(["Priya"]));
  });
  it("drops empty segments and non-objects", () => {
    expect(normalizeSegments([seg("A", ""), null, "x", seg("A", "keep")])).toHaveLength(1);
    expect(normalizeSegments("not an array")).toEqual([]);
  });
  it("drops exact duplicates and immediate repeats by the same speaker", () => {
    const out = normalizeSegments([seg("A", "Hello", 0), seg("A", "Hello", 0), seg("A", "hello", 5), seg("B", "Hello", 6), seg("A", "Hello", 9)]);
    expect(out.map((s) => `${s.speaker}:${s.text}`)).toEqual(["A:Hello", "B:Hello", "A:Hello"]);
  });
  it("sorts by start time, stable for ties", () => {
    const out = normalizeSegments([seg("A", "late", 10), seg("B", "first", 1), seg("C", "tie1", 5), seg("D", "tie2", 5)]);
    expect(out.map((s) => s.text)).toEqual(["first", "tie1", "tie2", "late"]);
  });
  it("repairs missing or invalid times", () => {
    const out = normalizeSegments([{ speaker: "A", text: "x", start: "bad", end: NaN }, { speaker: "A", text: "y", start: 5, end: 2 }]);
    expect(out[0]).toMatchObject({ start: 0, end: 0 });
    expect(out[1].end).toBeGreaterThanOrEqual(out[1].start);
  });
  it("is deterministic and does not mutate its input", () => {
    const input = [seg("A", " hi  there ", 0), seg("B", "yo", 2)];
    const copy = JSON.parse(JSON.stringify(input));
    const a = prepareTranscript(input);
    const b = prepareTranscript(input);
    expect(a).toEqual(b);
    expect(input).toEqual(copy);
  });
});

describe("prepare: merging and formatting", () => {
  it("merges consecutive same-speaker segments and tracks segment indexes", () => {
    const turns = mergeTurns(normalizeSegments([seg("A", "one", 0, 1), seg("A", "two", 2, 3), seg("B", "three", 4, 5), seg("A", "four", 6, 7)]));
    expect(turns.map((t) => [t.speaker, t.text])).toEqual([["A", "one two"], ["B", "three"], ["A", "four"]]);
    expect(turns[0]).toMatchObject({ start: 0, end: 3, segmentIndexes: [0, 1] });
  });
  it("picks the dominant emotion of a merged turn", () => {
    const [t] = mergeTurns(normalizeSegments([seg("A", "a", 0, 1, "sad"), seg("A", "b", 2, 3, "happy"), seg("A", "c", 4, 5, "happy")]));
    expect(t.emotion).toBe("happy");
  });
  it.each([[0, "0:00"], [5.9, "0:05"], [65, "1:05"], [3599, "59:59"], [3600, "1:00:00"], [3725, "1:02:05"], [-3, "0:00"], [NaN, "0:00"]])("formatTime(%s)", (s, want) => {
    expect(formatTime(s)).toBe(want);
  });
  it("formats a time-stamped line and clamps very long speaker labels", () => {
    expect(formatLine("Priya", 65, "Hello")).toBe("[1:05] Priya: Hello");
    expect(formatLine("x".repeat(100), 0, "t").length).toBeLessThan(100);
  });
  it("reports the character count of the formatted text", () => {
    const r = prepareTranscript([seg("A", "Hello world", 0, 2), seg("B", "Reply", 3, 4)]);
    expect(r.text).toBe("[0:00] A: Hello world\n[0:03] B: Reply");
    expect(r.charCount).toBe(r.text.length);
    expect(r.speakers).toEqual(["A", "B"]);
  });
});

describe("prepare: chunking", () => {
  it("returns one chunk when text fits", () => {
    const r = prepareTranscript(goldenById.short.segments, { maxChunkChars: 6000 });
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].text).toBe(r.text);
  });

  it.each(GOLDEN.map((g) => [g.id, g]))("%s: chunks never exceed the limit and keep every sentence", (_id, g) => {
    for (const max of [200, 500, 1500, 3000]) {
      const r = prepareTranscript(g.segments, { maxChunkChars: max });
      for (const c of r.chunks) {
        expect(c.text.length, `chunk ${c.index} at limit ${max}`).toBeLessThanOrEqual(max);
        expect(c.charCount).toBe(c.text.length);
      }
      const rejoined = r.chunks.map((c) => c.text).join("\n");
      expect(rejoined).toBe(r.text);
      const haystack = squash(r.segments.map((s) => s.text).join(" "));
      // every normalised segment word sequence survives chunking
      const body = squash(r.chunks.flatMap((c) => c.text.split("\n").map((l) => l.replace(/^\[[\d:]+\] [^:]*: /, ""))).join(" "));
      expect(body).toBe(haystack);
    }
  });

  it("every sentence of the input appears in the rejoined chunks", () => {
    const r = prepareTranscript(goldenById.medium.segments, { maxChunkChars: 400 });
    const rejoined = squash(r.chunks.map((c) => c.text).join(" "));
    for (const s of r.segments) for (const sentence of splitSentences(s.text)) expect(rejoined).toContain(sentence);
  });

  it("splits a single giant turn on sentence boundaries", () => {
    const g = goldenById["giant-turn"];
    const r = prepareTranscript(g.segments, { maxChunkChars: 2000 });
    expect(r.chunks.length).toBeGreaterThan(5);
    const giantLines = r.lines.filter((l) => l.includes("Elena:"));
    expect(giantLines.length).toBeGreaterThan(5);
    for (const l of giantLines) expect(l.length).toBeLessThanOrEqual(2000);
    expect(giantLines.every((l) => /[.]$/.test(l))).toBe(true); // splits land on sentence ends
  });

  it("hard-splits a single sentence longer than the limit, even one huge word", () => {
    const huge = "x".repeat(1000);
    const r = prepareTranscript([seg("A", `start ${huge} end`, 0, 10)], { maxChunkChars: 300 });
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    const body = r.lines.map((l) => l.replace(/^\[[\d:]+\] A: /, "")).join("");
    expect(body.replace(/ /g, "")).toBe(`start${huge}end`);
  });

  it("gives continuation pieces non-decreasing timestamps inside the turn", () => {
    const r = prepareTranscript(goldenById["giant-turn"].segments, { maxChunkChars: 1000 });
    const times = r.lines.filter((l) => l.includes("Elena:")).map((l) => l.match(/^\[([\d:]+)\]/)[1]);
    const secs = times.map((t) => t.split(":").reduce((a, p) => a * 60 + Number(p), 0));
    for (let i = 1; i < secs.length; i++) expect(secs[i]).toBeGreaterThanOrEqual(secs[i - 1]);
  });

  it("long golden transcript needs many chunks at the default limit and chunk ranges are ordered", () => {
    const r = prepareTranscript(goldenById.long.segments, { maxChunkChars: DEFAULT_MAX_CHUNK_CHARS });
    expect(r.chunks.length).toBeGreaterThanOrEqual(4);
    r.chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.endSec).toBeGreaterThanOrEqual(c.startSec);
      if (i > 0) expect(c.startSec).toBeGreaterThanOrEqual(r.chunks[i - 1].startSec);
    });
  });

  it("chunkLines starts a new chunk exactly when the next line would overflow", () => {
    const lines = [{ text: "a".repeat(10), start: 0, end: 1, turnIndex: 0 }, { text: "b".repeat(10), start: 1, end: 2, turnIndex: 1 }];
    expect(chunkLines(lines, 21)).toHaveLength(1);
    expect(chunkLines(lines, 20)).toHaveLength(2);
  });

  it("still chunks within the limit at the minimum limit with a very long speaker label", () => {
    const r = prepareTranscript([seg("N".repeat(200), "word ".repeat(200), 0, 5)], { maxChunkChars: MIN_CHUNK_CHARS });
    for (const c of r.chunks) expect(c.text.length).toBeLessThanOrEqual(MIN_CHUNK_CHARS);
    expect(r.chunks.length).toBeGreaterThan(5);
  });
});

describe("prepare: sentence splitting", () => {
  it("keeps all text including unpunctuated tails", () => {
    expect(splitSentences("One. Two! Three? four without end")).toEqual(["One.", "Two!", "Three?", "four without end"]);
    expect(splitSentences("no punctuation at all")).toEqual(["no punctuation at all"]);
  });
});
