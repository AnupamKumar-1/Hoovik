import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toStoredSummary, AdapterError, getDecisions, getActionItems, getProvenance, checkPanelShape, PANEL_INSIGHT_FIELDS, SCHEMA_VERSION } from "./adapter.js";
import { computeInsights } from "./insights.js";
import { validateSummary } from "./validator.js";
import { POLICIES, MODES } from "./policy.js";
import { goldenById, joinText } from "../golden/index.js";
import { goodJson } from "../golden/modelOutputs.js";

const fixedNow = () => new Date("2026-11-27T10:00:00.000Z");
const build = (over = {}) => {
  const g = goldenById.short;
  const ctx = { speakers: [...new Set(g.segments.map((s) => s.speaker))], transcriptText: joinText(g.segments) };
  const v = validateSummary(goodJson("short"), ctx);
  return toStoredSummary({
    validated: v.value, insights: computeInsights(g.segments), issues: v.issues, now: fixedNow,
    provenance: { source: "on_device", policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, chunkCount: 1 }, ...over,
  });
};

// What an old Groq summary looks like: no decisions, action_items or provenance.
const legacyGroq = () => ({
  summary: "Team met to discuss the launch.",
  key_points: ["a", "b"],
  insights: {
    dominant_emotion: "happy",
    emotion_distribution: { happy: 60, neutral: 40 },
    top_topics: ["launch"],
    speaker_stats: { Priya: { turns: 3, word_count: 45, dominant_emotion: "neutral", live_dominant_emotion: "fear" } },
    emotional_moments: [{ emotion: "happy", text: "great news", start: 12 }],
    discrepancies: [{ participant: "Priya", at_sec: 42, said: "fine by me", nlp_emotion: "happy", live_emotion: "fear", modality: "face", note: "mismatch" }],
    total_words: 100, speaking_pace_wpm: 120, total_duration_sec: 60,
  },
});

describe("adapter: output contract", () => {
  it("produces the existing summary shape plus decisions, action items and provenance", () => {
    const out = build();
    expect(checkPanelShape(out)).toEqual({ ok: true, problems: [] });
    expect(out.decisions.length).toBeGreaterThan(0);
    expect(out.action_items.length).toBeGreaterThan(0);
    for (const k of PANEL_INSIGHT_FIELDS) expect(out.insights).toHaveProperty(k);
    expect(out.provenance).toEqual({
      schemaVersion: SCHEMA_VERSION, source: "on-device", policy: "local-only", mode: "only_on_device",
      chunkCount: 1, generatedAt: "2026-11-27T10:00:00.000Z", validationIssues: [], receipt: null,
    });
  });
  it("normalises the source, keeps only issue codes (never text) and defaults chunkCount", () => {
    const out = build({ provenance: { source: "IN_CLOUD", policy: POLICIES.CLOUD_ONLY, mode: MODES.ONLY_IN_CLOUD }, issues: [{ code: "OWNER_UNGROUNDED", message: "Owner Zebediah is secret" }, { code: "OWNER_UNGROUNDED", message: "x" }] });
    expect(out.provenance.source).toBe("cloud");
    expect(out.provenance.chunkCount).toBe(1);
    expect(out.provenance.validationIssues).toEqual(["OWNER_UNGROUNDED"]);
    expect(JSON.stringify(out.provenance)).not.toContain("Zebediah");
  });
  it("carries a receipt through when provided", () => {
    const out = build({ provenance: { source: "on_device", policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, receipt: { verdict: "local" } } });
    expect(out.provenance.receipt).toEqual({ verdict: "local" });
  });
  it("copies rather than aliases its inputs", () => {
    const g = goldenById.short;
    const insights = computeInsights(g.segments);
    const validated = { summary: "s", key_points: ["k"], decisions: [{ text: "d" }], action_items: [{ task: "t", owner: null, deadline: null }] };
    const out = toStoredSummary({ validated, insights, provenance: { source: "cloud", policy: POLICIES.CLOUD_ONLY, mode: MODES.ONLY_IN_CLOUD } });
    out.key_points.push("x");
    out.decisions[0].text = "changed";
    out.insights.total_words = -1;
    expect(validated.key_points).toEqual(["k"]);
    expect(validated.decisions[0].text).toBe("d");
    expect(insights.total_words).not.toBe(-1);
  });
  it("defaults missing optional parts", () => {
    const out = toStoredSummary({ validated: { summary: "s" }, provenance: { source: "cloud", policy: POLICIES.CLOUD_ONLY, mode: MODES.ONLY_IN_CLOUD } });
    expect(out).toMatchObject({ key_points: [], decisions: [], action_items: [], insights: {} });
    expect(typeof out.provenance.generatedAt).toBe("string");
  });
  it.each([
    [{ validated: null }],
    [{ validated: { summary: "" } }],
    [{ provenance: { source: "mystery", policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE } }],
    [{ provenance: undefined }],
    [{ provenance: { source: "cloud", policy: "bogus", mode: MODES.ONLY_IN_CLOUD } }],
    [{ provenance: { source: "cloud", policy: POLICIES.CLOUD_ONLY, mode: "bogus" } }],
  ])("rejects bad inputs %#", (over) => {
    expect(() => build(over)).toThrow(AdapterError);
  });
});

describe("adapter: old summaries without the new fields", () => {
  it("a legacy Groq summary passes the same panel shape check", () => {
    expect(checkPanelShape(legacyGroq())).toEqual({ ok: true, problems: [] });
  });
  it("readers return safe defaults for legacy summaries and junk", () => {
    const old = legacyGroq();
    expect(getDecisions(old)).toEqual([]);
    expect(getActionItems(old)).toEqual([]);
    expect(getProvenance(old)).toBeNull();
    for (const junk of [null, undefined, 5, "x", { decisions: "no", action_items: {}, provenance: 3 }]) {
      expect(getDecisions(junk)).toEqual([]);
      expect(getActionItems(junk)).toEqual([]);
      expect(getProvenance(junk)).toBeNull();
    }
  });
  it("readers return the real values for new summaries", () => {
    const out = build();
    expect(getDecisions(out)).toBe(out.decisions);
    expect(getActionItems(out)).toBe(out.action_items);
    expect(getProvenance(out)).toBe(out.provenance);
  });
  it("a summary with no insights at all still passes (panel defaults them)", () => {
    expect(checkPanelShape({ summary: "x" }).ok).toBe(true);
  });
});

describe("adapter: panel shape check rejects what would break the panel", () => {
  const bad = (patch) => checkPanelShape({ ...legacyGroq(), ...patch });
  it.each([
    ["no summary", { summary: "" }],
    ["summary not a string", { summary: 5 }],
    ["key_points not strings", { key_points: [1, 2] }],
    ["insights not an object", { insights: [] }],
  ])("%s", (_n, patch) => expect(bad(patch).ok).toBe(false));
  const badInsights = (patch) => checkPanelShape({ summary: "x", insights: { ...legacyGroq().insights, ...patch } });
  it.each([
    ["dominant_emotion", { dominant_emotion: 3 }],
    ["emotion_distribution", { emotion_distribution: { happy: "a lot" } }],
    ["top_topics", { top_topics: [1] }],
    ["emotional_moments text", { emotional_moments: [{ emotion: "happy" }] }],
    ["speaker_stats", { speaker_stats: { A: { turns: "3", word_count: 1 } } }],
    ["discrepancies", { discrepancies: [{ participant: "A" }] }],
    ["total_words", { total_words: "100" }],
    ["speaking_pace_wpm", { speaking_pace_wpm: NaN }],
    ["total_duration_sec", { total_duration_sec: null }],
  ])("insights.%s", (_n, patch) => expect(badInsights(patch).ok).toBe(false));
  it("non-objects", () => {
    for (const x of [null, undefined, "s", 3, []]) expect(checkPanelShape(x).ok).toBe(false);
  });
});

describe("adapter: stays in sync with the real viewer", () => {
  it("every insights field the adapter promises is still read by SummaryPanel in TranscriptViewer.jsx", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/TranscriptViewer.jsx"), "utf8");
    for (const f of PANEL_INSIGHT_FIELDS) expect(src, f).toContain(f);
    for (const f of ["summary", "key_points", "insights"]) expect(src, f).toContain(f);
  });
});
