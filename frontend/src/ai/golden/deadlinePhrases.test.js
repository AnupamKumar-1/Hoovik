import { describe, it, expect } from "vitest";
import { findTimeMarkers, LIMITATIONS } from "./deadlinePhrases.js";

const hard = (t) => findTimeMarkers(t).hard;

describe("deadline phrase detector: must detect", () => {
  it.each([
    ["by Wednesday", "weekday"],
    ["I will do it tomorrow", "today-tomorrow"],
    ["tonight", "today-tomorrow"],
    ["finish it next week", "relative-period"],
    ["by the end of the month", "end-of-period"],
    ["end of day works", "end-of-period"],
    ["can you send it by EOD", "eod-style"],
    ["within two days", "within"],
    ["within 48 hours", "within"],
    ["in a couple of weeks", "in-n-units"],
    ["in three days", "in-n-units"],
    ["two weeks from now", "n-units-from-now"],
    ["by 5pm", "clock-time"],
    ["before noon", "clock-time"],
    ["on 12/03", "numeric-date"],
    ["due 2026-12-01", "numeric-date"],
    ["by the fifth of December", "month-date"],
    ["Dec 5", "month-date"],
    ["on 5th December", "month-date"],
    ["by December", "month-name"],
    ["before launch", "before-milestone"],
    ["before the beta ships", "before-milestone"],
    ["until the audit", "before-milestone"],
    ["ahead of the release", "before-milestone"],
    ["done by Q3", "quarter"],
    ["do it asap", "urgency"],
    ["right away please", "urgency"],
  ])("%s -> %s", (text, id) => {
    expect(hard(text)).toContain(id);
  });
});

describe("deadline phrase detector: must NOT hard-flag", () => {
  it.each([
    "Somebody should clean up the shared folder at some point",
    "We ought to send the vendors a reminder about the missing tax forms",
    "the quarterly report needs updating soon",
    "I will also email the design partners with the launch date",
    "We will revisit this eventually",
    "Sure, I will take that once his fix lands",
    "I am at a loss for words and can't decide",
    "two vendors need forms",
    "I will take that",
  ])("%s", (text) => {
    expect(hard(text)).toEqual([]);
  });
});

describe("deadline phrase detector: soft markers", () => {
  it("conditional triggers are soft, not hard", () => {
    const m = findTimeMarkers("I will take that once his fix lands");
    expect(m.hard).toEqual([]);
    expect(m.soft).toContain("conditional-trigger");
  });
  it("'by <something>' and 'before <something>' unclassified are soft", () => {
    expect(findTimeMarkers("done by the team").soft).toContain("by-something");
    expect(findTimeMarkers("before we talk").soft).toContain("before-or-until");
  });
});

describe("limitations are documented", () => {
  it("exports a non-empty limitations list", () => {
    expect(LIMITATIONS.length).toBeGreaterThan(2);
  });
});
