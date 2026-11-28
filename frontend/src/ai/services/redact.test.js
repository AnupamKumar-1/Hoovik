import { describe, it, expect } from "vitest";
import { createRedactor, safeRedactionSummary, isPlaceholder, CATEGORIES, REDACTION_NOTE } from "./redact.js";
import { piiMeeting, shortMeeting, mediumMeeting } from "../golden/index.js";
import { PII_CANARIES } from "../golden/piiMeeting.js";

const text = (input, opts) => createRedactor(opts).redactText(input);
const joinAll = (segs) => segs.map((s) => `${s.speaker}: ${s.text}`).join("\n");

describe("redact: per-category rules (positive examples)", () => {
  it("emails", () => {
    expect(text("Write to maria.lopez@northwind-legal.example today.")).toBe("Write to <EMAIL_1> today.");
    expect(text("cc a.b+tag@sub.example.co.uk, thanks")).toBe("cc <EMAIL_1>, thanks");
  });
  it("urls, keeping sentence punctuation outside the placeholder", () => {
    expect(text("See https://intranet.northwind.example/cases/2291, then reply.")).toBe("See <URL_1>, then reply.");
    expect(text("Go to www.example.com/path.")).toBe("Go to <URL_1>.");
  });
  it("money in symbol and word forms", () => {
    expect(text("They offered $48,500 for it.")).toBe("They offered <AMOUNT_1> for it.");
    expect(text("About €2,000.50 and £10k.")).toBe("About <AMOUNT_1> and <AMOUNT_2>.");
    expect(text("Roughly 3,000 dollars or 40 euros.")).toBe("Roughly <AMOUNT_1> or <AMOUNT_2>.");
  });
  it("formatted phone numbers", () => {
    expect(text("Call +1 (415) 555-0137 now")).toBe("Call <PHONE_1> now");
    expect(text("Call 415-555-0137 now")).toBe("Call <PHONE_1> now");
    expect(text("Call +44 20 7946 0958 now")).toBe("Call <PHONE_1> now");
  });
  it("national-id style numbers and long digit strings", () => {
    expect(text("Reference 884-22-1907 on file")).toBe("Reference <ID_1> on file");
    expect(text("Account 0012345678901 receives it")).toBe("Account <ID_1> receives it");
  });
  it("speaker names, including inside other speakers' text", () => {
    const r = createRedactor();
    const out = r.redactSegments([
      { speaker: "Priya", start: 0, end: 2, text: "Marcus, can you send it?" },
      { speaker: "Marcus", start: 2, end: 4, text: "Yes, Priya." },
    ]);
    expect(out.map((s) => s.speaker)).toEqual(["<PERSON_1>", "<PERSON_2>"]);
    expect(out[0].text).toBe("<PERSON_2>, can you send it?");
    expect(out[1].text).toBe("Yes, <PERSON_1>.");
  });
  it("multi-word capitalised names that are not speakers", () => {
    const out = text("The client contact is Maria Lopez, and Rahul Venkataraman agreed.");
    expect(out).toBe("The client contact is <PERSON_1>, and <PERSON_2> agreed.");
  });
  it("a first name seen after a full name maps to the same placeholder", () => {
    const out = text("First ask Maria Lopez. I will send Maria the draft.");
    expect(out).toBe("First ask <PERSON_1>. I will send <PERSON_1> the draft.");
  });
  it("sentence-initial names are caught, leading common words are peeled off", () => {
    expect(text("Rahul Venkataraman said no.")).toBe("<PERSON_1> said no.");
    expect(text("Then Rahul Venkataraman said no.")).toBe("Then <PERSON_1> said no.");
  });
  it("a sentence-initial verb before a name is redacted with it but is not remembered as a name", () => {
    const out = text("Contact Maria Lopez first. Contact again later. Maria agreed.");
    expect(out).toBe("<PERSON_1> first. Contact again later. <PERSON_1> agreed.");
    expect(text("Ask Maria Lopez first.")).toBe("Ask <PERSON_1> first."); // common openers are peeled off instead
  });
  it("extra domain terms and names supplied by the caller", () => {
    expect(text("The Hartwell matter is sealed.", { terms: ["Hartwell"] })).toBe("The <TERM_1> matter is sealed.");
    expect(text("Dr Okafor will call.", { names: ["Okafor"] })).toBe("Dr <PERSON_1> will call.");
    expect(text("Please call Dr Okafor today.", { names: ["Okafor"] })).toBe("Please call Dr <PERSON_1> today.");
  });
});

describe("redact: negative examples (things that look sensitive but are not)", () => {
  it.each([
    "The meeting number 2291 is a case number.",
    "The page count of 120 is just pages.",
    "We have thirty days to respond.",
    "It happened on 2026-11-28 at 10:30.",
    "Room 404 on floor 12, version 3.4.1.",
    "We need 5 people by Friday.",
    "Let's meet next Thursday or Friday in March.",
    "Then Marcus will join. Next Monday works. Thanks Priya.",
  ])("leaves %j unchanged", (line) => {
    expect(text(line)).toBe(line);
  });
  it("a speaker called Will does not erase the verb", () => {
    const r = createRedactor();
    const [seg] = r.redactSegments([{ speaker: "Will", start: 0, end: 1, text: "Will you join? I will." }]);
    expect(seg.text).toBe("<PERSON_1> you join? I will.");
  });
  it("two-digit and four-digit numbers never become ids", () => {
    expect(text("Items 12, 2291 and 99999 are fine.")).toBe("Items 12, 2291 and 99999 are fine.");
  });
});

describe("redact: behaviour", () => {
  it("is idempotent: redacting twice equals redacting once", () => {
    const r = createRedactor();
    const once = r.redactSegments(piiMeeting.segments);
    const twice = r.redactSegments(once);
    expect(twice).toEqual(once);
    expect(r.redactText(once[0].text)).toBe(once[0].text);
  });
  it("is stable: the same entity gets the same placeholder across the transcript", () => {
    const r = createRedactor();
    const out = r.redactSegments([
      { speaker: "Priya", start: 0, end: 1, text: "Mail maria@x.example please." },
      { speaker: "Marcus", start: 1, end: 2, text: "I mailed MARIA@X.EXAMPLE yesterday." },
      { speaker: "priya", start: 2, end: 3, text: "Good." },
    ]);
    expect(out[0].text).toBe("Mail <EMAIL_1> please.");
    expect(out[1].text).toBe("I mailed <EMAIL_1> yesterday.");
    expect(out[0].speaker).toBe(out[2].speaker);
    expect(r.summary().counts.email).toBe(1);
    expect(r.summary().hits.email).toBe(2);
  });
  it("round trip: restoring placeholders reproduces the original text locally", () => {
    for (const g of [shortMeeting, mediumMeeting]) {
      const r = createRedactor();
      const red = r.redactSegments(g.segments);
      expect(red.map((s) => r.restoreText(s.text))).toEqual(g.segments.map((s) => s.text));
      expect(red.map((s) => r.restoreText(s.speaker))).toEqual(g.segments.map((s) => s.speaker));
    }
  });
  it("round trip on the PII transcript: identical except a lone first name comes back as the full name", () => {
    const r = createRedactor();
    const red = r.redactSegments(piiMeeting.segments);
    const back = red.map((s) => r.restoreText(s.text));
    const expected = piiMeeting.segments.map((s) => s.text.replace("send Maria the", "send Maria Lopez the"));
    expect(back).toEqual(expected);
    expect(red.map((s) => r.restoreText(s.speaker))).toEqual(piiMeeting.segments.map((s) => s.speaker));
  });
  it("restore tolerates a model that drops the angle brackets and never confuses _1 with _10", () => {
    const r = createRedactor({ names: ["Ann Bell", "Cy Dunn", "Ed Fox", "Gus Hall", "Ida Jones", "Kim Lee", "Lou Moss", "Ned Orr", "Pam Ray", "Quin Shaw", "Rex Tull"] });
    const red = r.redactText("Ann Bell and Rex Tull met.");
    expect(red).toBe("<PERSON_1> and <PERSON_11> met.");
    expect(r.restoreText("PERSON_1 and PERSON_11 and <PERSON_11>")).toBe("Ann Bell and Rex Tull and Rex Tull");
  });
  it("restoreDeep restores every string in nested output and does not mutate its input", () => {
    const r = createRedactor();
    r.redactText("Email maria@x.example now.");
    const input = { summary: "Wrote to <EMAIL_1>.", action_items: [{ task: "Reply to <EMAIL_1>", owner: null, n: 3 }], flag: true };
    const frozen = JSON.parse(JSON.stringify(input));
    const out = r.restoreDeep(input);
    expect(out.summary).toBe("Wrote to maria@x.example.");
    expect(out.action_items[0]).toEqual({ task: "Reply to maria@x.example", owner: null, n: 3 });
    expect(out.flag).toBe(true);
    expect(input).toEqual(frozen);
  });
  it("redacted PII golden contains none of the canary strings", () => {
    const r = createRedactor();
    const out = joinAll(r.redactSegments(piiMeeting.segments));
    for (const canary of PII_CANARIES) expect(out, canary).not.toContain(canary);
  });
  it("redacted PII golden keeps the things that are not PII", () => {
    const out = joinAll(createRedactor().redactSegments(piiMeeting.segments));
    for (const keep of piiMeeting.expected.notPii) expect(out, keep).toContain(keep);
  });
  it("deadlines survive so the validator can still ground them", () => {
    const out = joinAll(createRedactor().redactSegments(piiMeeting.segments));
    expect(out).toContain("by Thursday");
    expect(out).toContain("by Friday");
  });
  it("accepts a plain string, passes through non-array input and handles empty text", () => {
    const r = createRedactor();
    expect(r.redactSegments("mail a@b.example")[0].text).toBe("mail <EMAIL_1>");
    expect(r.redactSegments(42)).toBe(42);
    expect(r.redactText("")).toBe("");
    expect(r.redactText(undefined)).toBe("");
    expect(r.redactSegments([null, { speaker: "Unknown", text: "hi" }, { text: 5 }]).map((s) => (s ? s.text : s))).toEqual([null, "hi", ""]);
    expect(r.restoreText("")).toBe("");
    expect(r.restoreText(7)).toBe(7);
    expect(r.restoreDeep(null)).toBe(null);
  });
  it("keeps Unknown speakers as they are", () => {
    const [s] = createRedactor().redactSegments([{ speaker: "Unknown", text: "hi" }, { speaker: "", text: "yo" }]);
    expect(s.speaker).toBe("Unknown");
  });
  it("is deterministic", () => {
    const a = createRedactor().redactSegments(piiMeeting.segments);
    const b = createRedactor().redactSegments(piiMeeting.segments);
    expect(a).toEqual(b);
  });
  it("does not expose the mapping", () => {
    const r = createRedactor();
    r.redactSegments(piiMeeting.segments);
    const dump = JSON.stringify(r) + Object.keys(r).join(",") + JSON.stringify(r.summary());
    for (const canary of PII_CANARIES) expect(dump).not.toContain(canary);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("redact: summary helpers", () => {
  it("summary counts distinct entities and occurrences", () => {
    const r = createRedactor();
    r.redactText("a@x.example b@x.example a@x.example");
    expect(r.summary()).toMatchObject({ entities: 2, total: 3 });
  });
  it("safeRedactionSummary keeps counts only and tolerates bad input", () => {
    expect(safeRedactionSummary({ counts: { email: 2, url: 0, person: 1, bogus: 9 }, entities: 3, total: 5, hits: {}, text: "secret" })).toEqual({
      applied: true, entities: 3, total: 5, byCategory: { email: 2, person: 1 },
    });
    expect(safeRedactionSummary(null)).toEqual({ applied: true, entities: 0, total: 0, byCategory: {} });
    expect(safeRedactionSummary({ counts: { email: "2" }, entities: "x", total: 1.5 })).toEqual({ applied: true, entities: 0, total: 0, byCategory: {} });
  });
  it("isPlaceholder, categories and the limitation note", () => {
    expect(isPlaceholder("<EMAIL_1>")).toBe(true);
    expect(isPlaceholder("EMAIL_1")).toBe(false);
    expect(isPlaceholder(5)).toBe(false);
    expect(CATEGORIES).toContain("person");
    expect(REDACTION_NOTE).toMatch(/not anonymisation/i);
  });
});
