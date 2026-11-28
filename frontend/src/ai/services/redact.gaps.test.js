import { describe, it, expect } from "vitest";
import { createRedactor } from "./redact.js";

const red = (text, opts) => createRedactor(opts).redactText(text);

describe("redaction gaps found in review", () => {
  it.each([
    ["card with spaces", "card 4111 1111 1111 1111 expires soon", "4111 1111 1111 1111"],
    ["card with dashes", "card 5500-0000-0000-0004 on file", "5500-0000-0000-0004"],
    ["card, 15 digits (4-6-5)", "amex 3782 822463 10005 here", "3782 822463 10005"],
    ["card, plain 16 digits", "number 4111111111111111 here", "4111111111111111"],
    ["PAN", "PAN ABCDE1234F is required", "ABCDE1234F"],
    ["UPI handle", "pay to rahul@okhdfcbank please", "rahul@okhdfcbank"],
    ["scheme-less link with a path", "see northwind.example/cases/2291 now", "northwind.example/cases/2291"],
    ["Rs. amount", "budget is Rs. 48,500 total", "48,500"],
    ["INR amount with lakh", "raise INR 5 lakh now", "5 lakh"],
    ["crore rupees", "target 2 crore rupees", "2 crore"],
    ["lakh without a currency word", "about 12 lakh", "12 lakh"],
    ["1.5M dollars", "paid 1.5M dollars", "1.5M"],
  ])("redacts %s", (_label, text, secret) => {
    const out = red(text);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/<[A-Z]+_\d+>/);
  });

  it.each([
    "we shipped 120 pages in 2026 and 3 of 12 tasks, call it 25% done",
    "the meeting is at 10:30 on 2026-11-28",
    "version 1.2.3 of the app, build 20261128",
    "see e.g. the docs and node.js notes",
    "ping @priya about it",
    "that works for me @ 5pm",
    "order 12 34 56",
    "Q3 2026 revenue",
    "hours worked: 40 hrs 5 min",
  ])("leaves %j readable where it is not sensitive", (text) => {
    const out = red(text);
    // Allowed to redact the phone/ID-like parts the existing rules already handled; the rest stays.
    expect(out.replace(/<[A-Z]+_\d+>/g, "").length).toBeGreaterThan(text.length * 0.4);
  });

  it("does not treat a 12-digit phone number with a country code as a card", () => {
    expect(red("call +91 98765 43210 today")).toBe("call <PHONE_1> today");
  });

  it("does not turn an existing email into a handle placeholder twice", () => {
    expect(red("mail priya@acme-corp.co.in now")).toBe("mail <EMAIL_1> now");
  });

  it("is idempotent: redacting twice equals redacting once", () => {
    const text = "card 4111 1111 1111 1111, PAN ABCDE1234F, rahul@okhdfcbank, Rs. 48,500, northwind.example/x/1";
    const r = createRedactor();
    const once = r.redactText(text);
    expect(r.redactText(once)).toBe(once);
  });

  it("round-trips: restoring placeholders reproduces the original", () => {
    const text = "card 4111 1111 1111 1111, PAN ABCDE1234F, rahul@okhdfcbank, Rs. 48,500, northwind.example/x/1";
    const r = createRedactor();
    expect(r.restoreText(r.redactText(text))).toBe(text);
  });

  it("the same card gets the same placeholder across segments", () => {
    const r = createRedactor();
    const a = r.redactText("use 4111 1111 1111 1111");
    const b = r.redactText("again 4111 1111 1111 1111 please");
    expect(a.match(/<ID_\d+>/)[0]).toBe(b.match(/<ID_\d+>/)[0]);
  });
});
