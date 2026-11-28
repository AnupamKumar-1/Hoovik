import { describe, it, expect } from "vitest";
import { assessSensitivity, recommendPolicy, levelForScore, LEVELS, THRESHOLDS, SENSITIVITY_NOTE } from "./sensitivity.js";
import { POLICIES } from "./policy.js";
import { GOLDEN, goldenById, piiMeeting, shortMeeting, unstatedMeeting, giantTurnMeeting } from "../golden/index.js";
import { PII_CANARIES } from "../golden/piiMeeting.js";

describe("sensitivity: golden transcripts map to expected levels", () => {
  it("the PII transcript is high", () => {
    const r = assessSensitivity(piiMeeting.segments);
    expect(r.level).toBe(LEVELS.HIGH);
    expect(r.score).toBeGreaterThanOrEqual(THRESHOLDS.high);
    expect(r.redactable.email).toBe(1);
    expect(r.redactable.phone).toBe(1);
    expect(r.redactable.id).toBe(2);
    expect(r.redactable.money).toBe(1);
    expect(r.redactable.url).toBe(1);
    expect(r.keywords.strong).toBeGreaterThan(0);
  });
  it.each([
    ["short", shortMeeting],
    ["unstated", unstatedMeeting],
    ["giant-turn", giantTurnMeeting],
    ["medium", goldenById.medium],
    ["long", goldenById.long],
  ])("the %s transcript is low", (_id, g) => {
    expect(assessSensitivity(g.segments).level).toBe(LEVELS.LOW);
  });
  it("every golden transcript gets a level", () => {
    for (const g of GOLDEN) expect(Object.values(LEVELS)).toContain(assessSensitivity(g.segments).level);
  });
});

describe("sensitivity: scoring rules", () => {
  it("empty and bad input score low", () => {
    for (const x of ["", [], null, undefined, 5, [{ speaker: "A" }]]) {
      const r = assessSensitivity(x);
      expect(r.level).toBe(LEVELS.LOW);
      expect(r.score).toBe(0);
    }
  });
  it("accepts a plain string", () => {
    expect(assessSensitivity("Call 415-555-0137 or mail a@b.example about the privileged settlement.").level).not.toBe(LEVELS.LOW);
  });
  it("an id-like number alone is at least medium", () => {
    expect(assessSensitivity("The reference is 884-22-1907.").level).toBe(LEVELS.MEDIUM);
  });
  it("strong keywords raise the level and repeats are capped", () => {
    const once = assessSensitivity("We discussed the settlement.");
    const many = assessSensitivity(Array(50).fill("The settlement is open.").join(" "));
    const capped = assessSensitivity(Array(7).fill("The settlement is open.").join(" "));
    expect(many.score).toBe(capped.score);
    expect(many.score).toBeGreaterThan(once.score);
    expect(many.level).toBe(LEVELS.HIGH);
  });
  it("general keywords alone cannot reach high", () => {
    expect(assessSensitivity(Array(40).fill("Review the contract and the audit.").join(" ")).level).toBe(LEVELS.LOW);
  });
  it("levelForScore respects the thresholds exactly", () => {
    expect(levelForScore(THRESHOLDS.medium - 1)).toBe(LEVELS.LOW);
    expect(levelForScore(THRESHOLDS.medium)).toBe(LEVELS.MEDIUM);
    expect(levelForScore(THRESHOLDS.high - 1)).toBe(LEVELS.MEDIUM);
    expect(levelForScore(THRESHOLDS.high)).toBe(LEVELS.HIGH);
  });
  it("is deterministic", () => {
    expect(assessSensitivity(piiMeeting.segments)).toEqual(assessSensitivity(piiMeeting.segments));
  });
  it("reasons are counts and categories, never transcript text", () => {
    const r = assessSensitivity(piiMeeting.segments);
    expect(r.reasons.length).toBeGreaterThan(0);
    const dump = JSON.stringify(r);
    for (const canary of PII_CANARIES) expect(dump).not.toContain(canary);
  });
  it("reasons use singular and plural wording and the legal-topic fallback", () => {
    const one = assessSensitivity("Mail a@b.example, 884-22-1907, 415-555-0137, https://x.example/a and $5.").reasons;
    expect(one).toEqual(["1 id-like number", "1 phone number", "1 email address", "1 money amount", "1 link"]);
    const two = assessSensitivity("Mail a@b.example and c@d.example, $5 and $6, https://x.example/a https://y.example/b, 884-22-1907 and 123-45-6789, 415-555-0137 and 415-555-0138.").reasons;
    expect(two).toEqual(["2 id-like numbers", "2 phone numbers", "2 email addresses", "2 money amounts", "2 links"]);
    expect(assessSensitivity("Review the contract.").reasons).toEqual(["words linked to legal or business topics"]);
  });
  it("the note says it is an estimate", () => {
    expect(SENSITIVITY_NOTE).toMatch(/can miss/i);
  });
});

describe("sensitivity: policy recommendation", () => {
  it("high defaults to local-only and warns", () => {
    expect(recommendPolicy({ level: LEVELS.HIGH })).toEqual({ policy: POLICIES.LOCAL_ONLY, defaulted: true, warnCloud: true });
    expect(recommendPolicy({ level: LEVELS.HIGH, preferred: POLICIES.AUTO_FALLBACK }).policy).toBe(POLICIES.LOCAL_ONLY);
  });
  it("high with local-only already preferred is not reported as a change", () => {
    expect(recommendPolicy({ level: LEVELS.HIGH, preferred: POLICIES.LOCAL_ONLY })).toEqual({ policy: POLICIES.LOCAL_ONLY, defaulted: false, warnCloud: true });
  });
  it("an explicit user choice is never overridden, only warned about", () => {
    expect(recommendPolicy({ level: LEVELS.HIGH, preferred: POLICIES.CLOUD_ONLY, userChose: true })).toEqual({ policy: POLICIES.CLOUD_ONLY, defaulted: false, warnCloud: true });
  });
  it("medium keeps the preferred policy and warns; low keeps it and does not", () => {
    expect(recommendPolicy({ level: LEVELS.MEDIUM })).toEqual({ policy: POLICIES.ASK_BEFORE_CLOUD, defaulted: false, warnCloud: true });
    expect(recommendPolicy({ level: LEVELS.LOW, preferred: POLICIES.AUTO_FALLBACK })).toEqual({ policy: POLICIES.AUTO_FALLBACK, defaulted: false, warnCloud: false });
  });
  it("no arguments gives the recommended default", () => {
    expect(recommendPolicy().policy).toBe(POLICIES.ASK_BEFORE_CLOUD);
  });
});
