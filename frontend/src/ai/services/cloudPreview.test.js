import { describe, it, expect } from "vitest";
import { buildCloudPreview, redactTranscript } from "./cloudPreview.js";
import { piiMeeting, shortMeeting } from "../golden/index.js";
import { PII_CANARIES } from "../golden/piiMeeting.js";

describe("redactTranscript", () => {
  it("normalises first, then redacts, and returns the redactor for restoring", () => {
    const { original, redacted, redactor } = redactTranscript([
      { speaker: " Priya ", start: 2, end: 3, text: "Mail  a@b.example" },
      { speaker: "priya", start: 0, end: 1, text: "Hello" },
      { speaker: "Priya", start: 0, end: 1, text: "Hello" },
    ]);
    expect(original.map((s) => s.text)).toEqual(["Hello", "Mail a@b.example"]); // sorted, deduplicated, whitespace collapsed
    expect(redacted.map((s) => s.text)).toEqual(["Hello", "Mail <EMAIL_1>"]);
    expect(redactor.restoreText(redacted[1].text)).toBe("Mail a@b.example");
  });
  it("accepts a string and passes anything else through for the caller to reject", () => {
    expect(redactTranscript("mail a@b.example").redacted[0].text).toBe("mail <EMAIL_1>");
    expect(redactTranscript(42).redacted).toBe(42);
    expect(redactTranscript(undefined).original).toBeUndefined();
  });
});

describe("buildCloudPreview", () => {
  const p = buildCloudPreview(piiMeeting.segments);

  it("pairs every original line with the text that would be sent", () => {
    expect(p.rows.length).toBe(piiMeeting.segments.length);
    expect(p.rows[0].original.text).toContain("maria.lopez@northwind-legal.example");
    expect(p.rows[0].redacted.text).toContain("<EMAIL_1>");
    expect(p.rows[0].changed).toBe(true);
  });
  it("what is shown as sent contains none of the canaries", () => {
    const sent = p.rows.map((r) => `${r.redacted.speaker} ${r.redacted.text}`).join("\n");
    for (const canary of PII_CANARIES) expect(sent, canary).not.toContain(canary);
  });
  it("counts changed rows and summarises by category, counts only", () => {
    expect(p.changedRows).toBe(p.rows.filter((r) => r.changed).length);
    expect(p.summary).toMatchObject({ applied: true });
    expect(p.summary.byCategory).toMatchObject({ email: 1, phone: 1, money: 1, url: 1, id: 2 });
    for (const canary of PII_CANARIES) expect(JSON.stringify(p.summary)).not.toContain(canary);
  });
  it("includes the sensitivity estimate and the limitation notes", () => {
    expect(p.sensitivity.level).toBe("high");
    expect(p.note).toMatch(/not anonymisation/i);
    expect(p.sensitivityNote).toMatch(/can miss/i);
  });
  it("matches what the service sends: same rows, same placeholders", () => {
    const { redacted } = redactTranscript(piiMeeting.segments);
    expect(p.rows.map((r) => r.redacted.text)).toEqual(redacted.map((s) => s.text));
    expect(p.rows.map((r) => r.redacted.speaker)).toEqual(redacted.map((s) => s.speaker));
  });
  it("every row is changed because every speaker is replaced; a transcript with no speakers shows no change", () => {
    expect(p.rows.every((r) => r.changed)).toBe(true);
    const bare = buildCloudPreview([{ speaker: "Unknown", start: 0, end: 1, text: "Nothing sensitive here." }]);
    expect(bare.changedRows).toBe(0);
    expect(bare.summary.total).toBe(0);
  });
  it("applies caller terms and works for a plain string", () => {
    expect(buildCloudPreview("The Hartwell matter.", { terms: ["Hartwell"] }).rows[0].redacted.text).toBe("The <TERM_1> matter.");
  });
  it("handles a normal low-sensitivity meeting", () => {
    const s = buildCloudPreview(shortMeeting.segments);
    expect(s.sensitivity.level).toBe("low");
    expect(s.rows.length).toBeGreaterThan(10);
  });
  it("empty input gives an empty preview", () => {
    const e = buildCloudPreview([]);
    expect(e.rows).toEqual([]);
    expect(e.changedRows).toBe(0);
  });
});
