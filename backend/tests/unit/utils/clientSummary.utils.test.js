import { describe, it, expect } from "vitest";
import { sanitizeClientSummary, CLIENT_SUMMARY_LIMITS as L } from "../../../src/utils/clientSummary.utils.js";

const goodProvenance = (over = {}) => ({
    schemaVersion: 1,
    source: "on-device",
    policy: "local-only",
    mode: "only_on_device",
    chunkCount: 1,
    generatedAt: "2026-11-28T10:00:00.000Z",
    validationIssues: ["OWNER_UNGROUNDED"],
    receipt: null,
    ...over,
});

const good = (over = {}) => ({
    summary: "The team agreed to ship the beta on Friday.",
    key_points: ["Beta ships Friday", "Onboarding bug is the blocker"],
    insights: {
        dominant_emotion: "neutral",
        emotion_distribution: { neutral: 80, happy: 20 },
        top_topics: ["launch"],
        speaker_stats: { Priya: { turns: 3, word_count: 40, dominant_emotion: "neutral" } },
        emotional_moments: [{ emotion: "happy", text: "Great news", start: 12 }],
        discrepancies: [],
        total_words: 100,
        speaking_pace_wpm: 120,
        total_duration_sec: 50,
    },
    decisions: [{ text: "Ship the beta on Friday", quote: "we ship Friday" }],
    action_items: [{ task: "Fix onboarding crash", owner: "Priya", deadline: "Thursday", ownerGrounding: "anchored", quote: "I will fix it" }],
    provenance: goodProvenance(),
    ...over,
});

const reject = (raw, code, status = 400) => {
    const r = sanitizeClientSummary(raw);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(r.status).toBe(status);
    return r;
};

describe("sanitizeClientSummary: provenance", () => {
    it("rejects a missing provenance block", () => {
        const { provenance: _p, ...rest } = good();
        reject(rest, "MISSING_PROVENANCE");
    });

    it("rejects a missing or wrong source value", () => {
        reject(good({ provenance: goodProvenance({ source: undefined }) }), "INVALID_PROVENANCE");
        reject(good({ provenance: goodProvenance({ source: "groq" }) }), "INVALID_PROVENANCE");
        reject(good({ provenance: goodProvenance({ source: "on_device" }) }), "INVALID_PROVENANCE");
        reject(good({ provenance: goodProvenance({ source: 1 }) }), "INVALID_PROVENANCE");
    });

    it("rejects an unknown policy or mode, accepts their absence", () => {
        reject(good({ provenance: goodProvenance({ policy: "yolo" }) }), "INVALID_PROVENANCE");
        reject(good({ provenance: goodProvenance({ mode: "prefer_everywhere" }) }), "INVALID_PROVENANCE");
        const r = sanitizeClientSummary(good({ provenance: { source: "cloud" } }));
        expect(r.ok).toBe(true);
        expect(r.value.provenance.source).toBe("cloud");
        expect(r.value.provenance.policy).toBeUndefined();
    });

    it("keeps valid provenance fields and normalises the rest", () => {
        const r = sanitizeClientSummary(good({
            provenance: goodProvenance({ chunkCount: 9999, generatedAt: "not a date", validationIssues: ["OK_CODE", "bad code!", 5, "X".repeat(200)] }),
        }));
        expect(r.ok).toBe(true);
        expect(r.value.provenance.chunkCount).toBe(L.chunkCountMax);
        expect(r.value.provenance.generatedAt).toBeUndefined();
        expect(r.value.provenance.validationIssues).toEqual(["OK_CODE"]);
    });

    it("keeps only a small tree of primitives as the receipt", () => {
        const r = sanitizeClientSummary(good({
            provenance: goodProvenance({
                receipt: { verdict: "local", aiRequests: 0, nested: { deep: { deeper: { deepest: 1 } } }, fn: () => 1, __proto__: { x: 1 } },
            }),
        }));
        expect(r.ok).toBe(true);
        expect(r.value.provenance.receipt.verdict).toBe("local");
        expect(r.value.provenance.receipt.aiRequests).toBe(0);
        expect(r.value.provenance.receipt.fn).toBeUndefined();
        expect(r.value.provenance.receipt.nested.deep.deeper).toBeUndefined();
    });

    it("rejects an oversize receipt and a non-object receipt", () => {
        const big = {};
        for (let i = 0; i < L.receiptKeys; i++) big[`k${i}`] = "x".repeat(L.receiptStringChars);
        reject(good({ provenance: goodProvenance({ receipt: big }) }), "PAYLOAD_TOO_LARGE", 413);
        reject(good({ provenance: goodProvenance({ receipt: "text" }) }), "INVALID_FIELD");
    });
});

describe("sanitizeClientSummary: provenance.redaction", () => {
    it("defaults to null for summaries made before redaction existed", () => {
        const r = sanitizeClientSummary(good());
        expect(r.ok).toBe(true);
        expect(r.value.provenance.redaction).toBeNull();
    });

    it("keeps counts only for known categories", () => {
        const r = sanitizeClientSummary(good({
            provenance: goodProvenance({
                source: "cloud",
                policy: "cloud-only",
                mode: "only_in_cloud",
                redaction: { applied: true, entities: 3, total: 5, byCategory: { email: 2, person: 1, bogus: 9, url: 0 }, text: "maria@x.example", mapping: { "<EMAIL_1>": "maria@x.example" } },
            }),
        }));
        expect(r.ok).toBe(true);
        expect(r.value.provenance.redaction).toEqual({ applied: true, entities: 3, total: 5, byCategory: { email: 2, person: 1 } });
        expect(JSON.stringify(r.value)).not.toContain("maria@x.example");
    });

    it("coerces bad counts to zero and caps huge ones", () => {
        const r = sanitizeClientSummary(good({ provenance: goodProvenance({ redaction: { applied: "yes", entities: -4, total: 9999999, byCategory: "x" } }) }));
        expect(r.ok).toBe(true);
        expect(r.value.provenance.redaction).toEqual({ applied: false, entities: 0, total: 100000, byCategory: {} });
    });

    it("rejects a redaction value that is not an object", () => {
        reject(good({ provenance: goodProvenance({ redaction: "lots" }) }), "INVALID_FIELD");
    });
});

describe("sanitizeClientSummary: shape and types", () => {
    it("accepts and returns a well formed summary", () => {
        const r = sanitizeClientSummary(good());
        expect(r.ok).toBe(true);
        expect(r.value.summary).toMatch(/beta/);
        expect(r.value.action_items[0]).toMatchObject({ task: "Fix onboarding crash", owner: "Priya", deadline: "Thursday", ownerGrounding: "anchored" });
        expect(r.value.insights.speaker_stats.Priya.turns).toBe(3);
        expect(r.value.provenance.source).toBe("on-device");
    });

    it("rejects non-object bodies", () => {
        for (const bad of [undefined, null, "text", 5, [], true]) reject(bad, "INVALID_SUMMARY");
    });

    it("rejects a missing, empty or non-string summary", () => {
        reject(good({ summary: undefined }), "INVALID_FIELD");
        reject(good({ summary: "   " }), "INVALID_FIELD");
        reject(good({ summary: { text: "x" } }), "INVALID_FIELD");
    });

    it("rejects wrong container types", () => {
        reject(good({ key_points: "not a list" }), "INVALID_FIELD");
        reject(good({ decisions: { a: 1 } }), "INVALID_FIELD");
        reject(good({ action_items: "x" }), "INVALID_FIELD");
        reject(good({ insights: "x" }), "INVALID_FIELD");
        reject(good({ insights: { total_words: "many" } }), "INVALID_FIELD");
        reject(good({ action_items: [{ task: 5 }] }), "INVALID_FIELD");
        reject(good({ decisions: [{ text: null }] }), "INVALID_FIELD");
        reject(good({ action_items: [null] }), "INVALID_FIELD");
    });

    it("strips unknown keys at every level", () => {
        const r = sanitizeClientSummary(good({
            admin: true,
            insights: { ...good().insights, evil: 1, speaker_stats: { Priya: { turns: 1, word_count: 2, secret: "x" } } },
            action_items: [{ task: "t", owner: "Priya", deadline: null, $where: "1", extra: 1 }],
            provenance: goodProvenance({ hostSecret: "s3cret" }),
        }));
        expect(r.ok).toBe(true);
        expect(r.value.admin).toBeUndefined();
        expect(r.value.insights.evil).toBeUndefined();
        expect(r.value.insights.speaker_stats.Priya.secret).toBeUndefined();
        expect(r.value.action_items[0].extra).toBeUndefined();
        expect(r.value.action_items[0].$where).toBeUndefined();
        expect(r.value.provenance.hostSecret).toBeUndefined();
        expect(JSON.stringify(r.value)).not.toContain("s3cret");
    });

    it("accepts string shorthand for decisions and action items, and defaults owner and deadline to null", () => {
        const r = sanitizeClientSummary(good({ decisions: ["Use Postgres"], action_items: ["Write the doc"] }));
        expect(r.ok).toBe(true);
        expect(r.value.decisions).toEqual([{ text: "Use Postgres" }]);
        expect(r.value.action_items).toEqual([{ task: "Write the doc", owner: null, deadline: null }]);
    });

    it("drops unknown ownerGrounding values", () => {
        const r = sanitizeClientSummary(good({ action_items: [{ task: "t", ownerGrounding: "trust-me" }] }));
        expect(r.value.action_items[0].ownerGrounding).toBeUndefined();
    });

    it("skips dangerous map keys and non-finite numbers", () => {
        const dist = JSON.parse('{"__proto__": 5, "constructor": 5, "$gt": 5, "ok": 7, "bad": "x"}');
        const r = sanitizeClientSummary(good({ insights: { emotion_distribution: dist } }));
        expect(r.ok).toBe(true);
        expect(r.value.insights.emotion_distribution).toEqual({ ok: 7 });
        expect(Object.prototype.hasOwnProperty.call(r.value.insights.emotion_distribution, "__proto__")).toBe(false);
        expect(({}).polluted).toBeUndefined();
    });

    it("removes control characters from strings", () => {
        const r = sanitizeClientSummary(good({ summary: "Hello\u0000 wor\u0007ld" }));
        expect(r.value.summary).toBe("Hello world");
    });
});

describe("sanitizeClientSummary: size caps", () => {
    it("rejects an oversize payload with 413", () => {
        reject(good({ summary: "x".repeat(L.maxRawBytes + 10) }), "PAYLOAD_TOO_LARGE", 413);
    });

    it("truncates long strings to their caps", () => {
        const r = sanitizeClientSummary(good({
            summary: "s".repeat(L.summaryChars + 500),
            key_points: ["k".repeat(L.keyPointChars + 100)],
            action_items: [{ task: "t".repeat(L.itemTextChars + 100), owner: "o".repeat(L.ownerChars + 50), deadline: "d".repeat(L.deadlineChars + 50), quote: "q".repeat(L.quoteChars + 50) }],
        }));
        expect(r.ok).toBe(true);
        expect(r.value.summary).toHaveLength(L.summaryChars);
        expect(r.value.key_points[0]).toHaveLength(L.keyPointChars);
        const a = r.value.action_items[0];
        expect(a.task).toHaveLength(L.itemTextChars);
        expect(a.owner).toHaveLength(L.ownerChars);
        expect(a.deadline).toHaveLength(L.deadlineChars);
        expect(a.quote).toHaveLength(L.quoteChars);
    });

    it("caps list lengths", () => {
        const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
        const speakers = {};
        for (let i = 0; i < L.speakers + 20; i++) speakers[`S${i}`] = { turns: 1, word_count: 1 };
        const r = sanitizeClientSummary(good({
            key_points: many(L.keyPoints + 10, (i) => `p${i}`),
            decisions: many(L.decisions + 10, (i) => ({ text: `d${i}` })),
            action_items: many(L.actionItems + 10, (i) => ({ task: `t${i}` })),
            insights: {
                top_topics: many(L.topics + 10, (i) => `t${i}`),
                speaker_stats: speakers,
                emotional_moments: many(L.emotionalMoments + 10, (i) => ({ emotion: "happy", text: `m${i}` })),
            },
            provenance: goodProvenance({ validationIssues: many(L.issueCodes + 10, (i) => `CODE_${i}`) }),
        }));
        expect(r.ok).toBe(true);
        expect(r.value.key_points).toHaveLength(L.keyPoints);
        expect(r.value.decisions).toHaveLength(L.decisions);
        expect(r.value.action_items).toHaveLength(L.actionItems);
        expect(r.value.insights.top_topics).toHaveLength(L.topics);
        expect(Object.keys(r.value.insights.speaker_stats)).toHaveLength(L.speakers);
        expect(r.value.insights.emotional_moments).toHaveLength(L.emotionalMoments);
        expect(r.value.provenance.validationIssues).toHaveLength(L.issueCodes);
    });

    it("does not mutate its input", () => {
        const input = good();
        const copy = JSON.stringify(input);
        sanitizeClientSummary(input);
        expect(JSON.stringify(input)).toBe(copy);
    });
});

describe("sanitizeClientSummary: old Hoovik summaries", () => {
    it("a Groq-shaped summary without provenance is rejected as a client save", () => {
        reject({ summary: "s", key_points: [], insights: {} }, "MISSING_PROVENANCE");
    });
});
