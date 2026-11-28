import { describe, it, expect } from "vitest";
import { computeInsights, percentages } from "./insights.js";
import { GOLDEN, goldenById } from "../golden/index.js";

const seg = (speaker, text, start, end, emotion = "neutral") => ({ speaker, text, start, end, emotion, emoji: "" });
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe("insights: empty and degenerate input", () => {
  it.each([[[]], [undefined], [null], [[seg("A", "  ", 0, 1)]]])("is safe for empty input %#", (input) => {
    const i = computeInsights(input);
    expect(i).toMatchObject({ dominant_emotion: "neutral", emotion_distribution: {}, speaker_stats: {}, total_words: 0, speaking_pace_wpm: 0, total_duration_sec: 0 });
    expect(i.emotional_moments).toEqual([]);
    expect(i.discrepancies).toEqual([]);
    expect(i.top_topics).toEqual([]);
  });
  it("is safe with zero duration (no divide by zero)", () => {
    const i = computeInsights([seg("A", "one two three", 5, 5)]);
    expect(i.total_duration_sec).toBe(0);
    expect(i.speaking_pace_wpm).toBe(0);
    expect(i.total_words).toBe(3);
  });
});

describe("insights: percentages", () => {
  it("sum to exactly 100 using largest remainder", () => {
    expect(sum(percentages({ a: 1, b: 1, c: 1 }, 3))).toBe(100);
    expect(percentages({ a: 1, b: 1, c: 1 }, 3)).toEqual({ a: 34, b: 33, c: 33 });
    expect(percentages({ neutral: 5, happy: 3 }, 8)).toEqual({ neutral: 63, happy: 37 });
    expect(percentages({ a: 7 }, 7)).toEqual({ a: 100 });
    expect(percentages({}, 0)).toEqual({});
    expect(percentages({ a: 1 }, 0)).toEqual({});
  });
  it("always yields integers summing to 100 for many shapes", () => {
    for (let n = 1; n <= 40; n++) {
      const counts = {};
      for (let k = 0; k < (n % 7) + 1; k++) counts[`e${k}`] = ((n * (k + 3)) % 9) + 1;
      const total = sum(counts);
      const p = percentages(counts, total);
      expect(sum(p)).toBe(100);
      Object.values(p).forEach((v) => expect(Number.isInteger(v)).toBe(true));
    }
  });
  it("breaks ties deterministically by count then name", () => {
    expect(Object.keys(percentages({ b: 1, a: 1 }, 2))).toEqual(["a", "b"]);
  });
});

describe("insights: golden transcripts", () => {
  it.each(GOLDEN.map((g) => [g.id, g]))("%s: distribution sums to 100 and word total matches an independent count", (_id, g) => {
    const i = computeInsights(g.segments);
    expect(sum(i.emotion_distribution)).toBe(100);
    const independent = g.segments.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
    expect(i.total_words).toBe(independent);
    expect(Object.keys(i.emotion_distribution)).toContain(i.dominant_emotion);
  });

  it("short: speaker counts, turns and dominant emotion are correct", () => {
    const i = computeInsights(goldenById.short.segments);
    expect(Object.keys(i.speaker_stats).sort()).toEqual(["Dev", "Elena", "Marcus", "Priya"]);
    // independent count of consecutive runs per speaker
    const runs = {};
    goldenById.short.segments.forEach((s, k, all) => { if (k === 0 || all[k - 1].speaker !== s.speaker) runs[s.speaker] = (runs[s.speaker] || 0) + 1; });
    for (const name of Object.keys(runs)) expect(i.speaker_stats[name].turns, name).toBe(runs[name]);
    expect(runs.Priya).toBeLessThan(goldenById.short.segments.filter((s) => s.speaker === "Priya").length); // merging really happened
    expect(i.speaker_stats.Dev.dominant_emotion).toBe("neutral");
    expect(i.dominant_emotion).toBe("neutral");
    const totalSpeakerWords = Object.values(i.speaker_stats).reduce((a, s) => a + s.word_count, 0);
    expect(totalSpeakerWords).toBe(i.total_words);
  });

  it("counts merged consecutive turns once", () => {
    const i = computeInsights([seg("A", "one", 0, 1), seg("A", "two", 2, 3), seg("B", "three", 4, 5), seg("A", "four", 6, 7)]);
    expect(i.speaker_stats.A.turns).toBe(2);
    expect(i.speaker_stats.B.turns).toBe(1);
  });

  it("duration is first start to last end and pace is words per minute", () => {
    const i = computeInsights([seg("A", "w ".repeat(60).trim(), 10, 40), seg("B", "w ".repeat(60).trim(), 40, 70)]);
    expect(i.total_duration_sec).toBe(60);
    expect(i.total_words).toBe(120);
    expect(i.speaking_pace_wpm).toBe(120);
  });

  it("emotional moments: only non-neutral, max five, text trimmed to 80, in time order", () => {
    const segs = Array.from({ length: 12 }, (_, k) => seg("A", `line ${k} ` + "z".repeat(100), k * 2, k * 2 + 1, k % 2 ? "happy" : "neutral"));
    const i = computeInsights(segs);
    expect(i.emotional_moments).toHaveLength(5);
    expect(i.emotional_moments.every((m) => m.emotion === "happy" && m.text.length === 80)).toBe(true);
    const starts = i.emotional_moments.map((m) => m.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("dominant emotion ties resolve to the first seen", () => {
    expect(computeInsights([seg("A", "a", 0, 1, "sad"), seg("A", "b", 2, 3, "happy")]).dominant_emotion).toBe("sad");
  });

  it("is deterministic and does not mutate input", () => {
    const input = goldenById.medium.segments;
    const copy = JSON.parse(JSON.stringify(input));
    expect(computeInsights(input)).toEqual(computeInsights(input));
    expect(input).toEqual(copy);
  });
});
