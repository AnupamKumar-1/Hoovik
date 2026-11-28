// Sanitizer for summaries made on the client (on-device or Firebase AI Logic) and saved through
// PATCH /transcripts/:id/summary.
//
// The client is untrusted, so the stored object is rebuilt from a whitelist instead of copied:
// unknown keys are dropped, every string and list has a cap, numbers must be finite, and the
// provenance block must carry a valid source. Nothing here touches the database.

export const CLIENT_SUMMARY_LIMITS = Object.freeze({
    maxRawBytes: 200_000,
    maxStoredBytes: 64_000,
    summaryChars: 4000,
    keyPoints: 20,
    keyPointChars: 600,
    decisions: 30,
    actionItems: 50,
    itemTextChars: 600,
    ownerChars: 120,
    deadlineChars: 120,
    quoteChars: 600,
    topics: 15,
    topicChars: 120,
    emotionLabels: 16,
    speakers: 50,
    speakerChars: 120,
    emotionalMoments: 50,
    discrepancies: 50,
    labelChars: 40,
    chunkCountMax: 100,
    issueCodes: 40,
    receiptBytes: 4000,
    receiptDepth: 3,
    receiptKeys: 40,
    receiptStringChars: 300,
});

export const CLIENT_SOURCES = Object.freeze(["on-device", "cloud"]);
export const CLIENT_POLICIES = Object.freeze(["local-only", "ask-before-cloud", "auto-fallback", "cloud-only"]);
export const CLIENT_MODES = Object.freeze(["only_on_device", "prefer_on_device", "only_in_cloud", "prefer_in_cloud"]);

const OWNER_GROUNDING = new Set(["anchored", "present"]);
const ISSUE_CODE_RE = /^[A-Z0-9_]{1,48}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const L = CLIENT_SUMMARY_LIMITS;

class SummaryRejected extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function cleanString(v, max) {
    if (typeof v !== "string") return null;
    const s = v.replace(CONTROL_CHARS, "").trim();
    return s ? s.slice(0, max) : null;
}

function requireString(v, max, path) {
    const s = cleanString(v, max);
    if (s === null) throw new SummaryRejected("INVALID_FIELD", `${path} must be a non-empty string`);
    return s;
}

function optionalString(v, max) {
    return cleanString(v, max) ?? undefined;
}

function cleanList(v, path) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new SummaryRejected("INVALID_FIELD", `${path} must be an array`);
    return v;
}

function safeKey(k, max) {
    if (typeof k !== "string") return null;
    const key = k.replace(CONTROL_CHARS, "").trim().slice(0, max);
    if (!key || FORBIDDEN_KEYS.has(key) || key.startsWith("$")) return null;
    return key;
}

function cleanNumberMap(v, maxKeys, path) {
    if (v === undefined || v === null) return undefined;
    if (!isObj(v)) throw new SummaryRejected("INVALID_FIELD", `${path} must be an object`);
    const out = {};
    for (const [k, n] of Object.entries(v)) {
        if (Object.keys(out).length >= maxKeys) break;
        const key = safeKey(k, L.labelChars);
        if (key && isNum(n)) out[key] = n;
    }
    return out;
}

function cleanDecisions(v) {
    return cleanList(v, "decisions").slice(0, L.decisions).map((d, i) => {
        const item = typeof d === "string" ? { text: d } : d;
        if (!isObj(item)) throw new SummaryRejected("INVALID_FIELD", `decisions[${i}] must be an object`);
        const out = { text: requireString(item.text, L.itemTextChars, `decisions[${i}].text`) };
        const quote = optionalString(item.quote, L.quoteChars);
        if (quote) out.quote = quote;
        return out;
    });
}

function cleanActionItems(v) {
    return cleanList(v, "action_items").slice(0, L.actionItems).map((a, i) => {
        const item = typeof a === "string" ? { task: a } : a;
        if (!isObj(item)) throw new SummaryRejected("INVALID_FIELD", `action_items[${i}] must be an object`);
        const out = {
            task: requireString(item.task, L.itemTextChars, `action_items[${i}].task`),
            owner: optionalString(item.owner, L.ownerChars) ?? null,
            deadline: optionalString(item.deadline, L.deadlineChars) ?? null,
        };
        if (OWNER_GROUNDING.has(item.ownerGrounding)) out.ownerGrounding = item.ownerGrounding;
        const quote = optionalString(item.quote, L.quoteChars);
        if (quote) out.quote = quote;
        return out;
    });
}

function cleanInsights(v) {
    if (v === undefined || v === null) return {};
    if (!isObj(v)) throw new SummaryRejected("INVALID_FIELD", "insights must be an object");
    const out = {};

    const dominant = optionalString(v.dominant_emotion, L.labelChars);
    if (dominant) out.dominant_emotion = dominant;

    const dist = cleanNumberMap(v.emotion_distribution, L.emotionLabels, "insights.emotion_distribution");
    if (dist) out.emotion_distribution = dist;

    if (v.top_topics !== undefined) {
        out.top_topics = cleanList(v.top_topics, "insights.top_topics")
            .map((t) => cleanString(t, L.topicChars))
            .filter(Boolean)
            .slice(0, L.topics);
    }

    if (v.speaker_stats !== undefined && v.speaker_stats !== null) {
        if (!isObj(v.speaker_stats)) throw new SummaryRejected("INVALID_FIELD", "insights.speaker_stats must be an object");
        const stats = {};
        for (const [name, s] of Object.entries(v.speaker_stats)) {
            if (Object.keys(stats).length >= L.speakers) break;
            const key = safeKey(name, L.speakerChars);
            if (!key || !isObj(s) || !isNum(s.turns) || !isNum(s.word_count)) continue;
            const entry = { turns: s.turns, word_count: s.word_count };
            const de = optionalString(s.dominant_emotion, L.labelChars);
            if (de) entry.dominant_emotion = de;
            const le = optionalString(s.live_dominant_emotion, L.labelChars);
            if (le) entry.live_dominant_emotion = le;
            stats[key] = entry;
        }
        out.speaker_stats = stats;
    }

    if (v.emotional_moments !== undefined) {
        out.emotional_moments = cleanList(v.emotional_moments, "insights.emotional_moments")
            .filter((m) => isObj(m) && cleanString(m.emotion, L.labelChars) && cleanString(m.text, L.itemTextChars))
            .slice(0, L.emotionalMoments)
            .map((m) => {
                const entry = { emotion: cleanString(m.emotion, L.labelChars), text: cleanString(m.text, L.itemTextChars) };
                if (isNum(m.start)) entry.start = m.start;
                return entry;
            });
    }

    if (v.discrepancies !== undefined) {
        out.discrepancies = cleanList(v.discrepancies, "insights.discrepancies")
            .filter((d) =>
                isObj(d) && isNum(d.at_sec)
                && cleanString(d.participant, L.speakerChars) && cleanString(d.said, L.itemTextChars)
                && cleanString(d.nlp_emotion, L.labelChars) && cleanString(d.live_emotion, L.labelChars))
            .slice(0, L.discrepancies)
            .map((d) => {
                const entry = {
                    participant: cleanString(d.participant, L.speakerChars),
                    at_sec: d.at_sec,
                    said: cleanString(d.said, L.itemTextChars),
                    nlp_emotion: cleanString(d.nlp_emotion, L.labelChars),
                    live_emotion: cleanString(d.live_emotion, L.labelChars),
                };
                const modality = optionalString(d.modality, L.labelChars);
                if (modality) entry.modality = modality;
                const note = optionalString(d.note, L.itemTextChars);
                if (note) entry.note = note;
                return entry;
            });
    }

    for (const k of ["total_words", "speaking_pace_wpm", "total_duration_sec"]) {
        if (v[k] !== undefined && v[k] !== null) {
            if (!isNum(v[k])) throw new SummaryRejected("INVALID_FIELD", `insights.${k} must be a number`);
            out[k] = v[k];
        }
    }
    return out;
}

// Receipts are defined by a later feature. Until then keep only a small tree of primitives, so the
// field cannot be used to smuggle large or nested data into the document.
function cleanPlain(v, depth) {
    if (typeof v === "string") return v.replace(CONTROL_CHARS, "").slice(0, L.receiptStringChars);
    if (typeof v === "boolean" || v === null) return v;
    if (isNum(v)) return v;
    if (depth >= L.receiptDepth) return undefined;
    if (Array.isArray(v)) {
        return v.slice(0, L.receiptKeys).map((x) => cleanPlain(x, depth + 1)).filter((x) => x !== undefined);
    }
    if (isObj(v)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (Object.keys(out).length >= L.receiptKeys) break;
            const key = safeKey(k, L.labelChars);
            if (!key) continue;
            const clean = cleanPlain(x, depth + 1);
            if (clean !== undefined) out[key] = clean;
        }
        return out;
    }
    return undefined;
}

function cleanReceipt(v) {
    if (v === undefined || v === null) return null;
    if (!isObj(v)) throw new SummaryRejected("INVALID_FIELD", "provenance.receipt must be an object or null");
    const clean = cleanPlain(v, 0);
    if (Buffer.byteLength(JSON.stringify(clean), "utf8") > L.receiptBytes) {
        throw new SummaryRejected("PAYLOAD_TOO_LARGE", "provenance.receipt is too large", 413);
    }
    return clean;
}

function cleanProvenance(p) {
    if (!isObj(p)) throw new SummaryRejected("MISSING_PROVENANCE", "provenance is required");
    if (typeof p.source !== "string" || !CLIENT_SOURCES.includes(p.source)) {
        throw new SummaryRejected("INVALID_PROVENANCE", "provenance.source must be \"on-device\" or \"cloud\"");
    }
    const out = { source: p.source };
    if (p.policy !== undefined) {
        if (!CLIENT_POLICIES.includes(p.policy)) throw new SummaryRejected("INVALID_PROVENANCE", "provenance.policy is not a known policy");
        out.policy = p.policy;
    }
    if (p.mode !== undefined) {
        if (!CLIENT_MODES.includes(p.mode)) throw new SummaryRejected("INVALID_PROVENANCE", "provenance.mode is not a known mode");
        out.mode = p.mode;
    }
    if (Number.isInteger(p.schemaVersion) && p.schemaVersion >= 1 && p.schemaVersion <= 1000) out.schemaVersion = p.schemaVersion;
    if (Number.isInteger(p.chunkCount)) out.chunkCount = Math.min(Math.max(p.chunkCount, 1), L.chunkCountMax);
    if (typeof p.generatedAt === "string" && p.generatedAt.length <= 40 && !Number.isNaN(Date.parse(p.generatedAt))) {
        out.generatedAt = new Date(p.generatedAt).toISOString();
    }
    out.validationIssues = cleanList(p.validationIssues, "provenance.validationIssues")
        .filter((c) => typeof c === "string" && ISSUE_CODE_RE.test(c))
        .slice(0, L.issueCodes);
    out.receipt = cleanReceipt(p.receipt);
    return out;
}

/**
 * Validates and rebuilds a client-made summary.
 * Returns { ok: true, value } or { ok: false, code, message, status }.
 * Never throws and never mutates its input.
 */
export function sanitizeClientSummary(raw) {
    try {
        if (!isObj(raw)) throw new SummaryRejected("INVALID_SUMMARY", "aiSummary object required");

        let rawBytes;
        try {
            rawBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
        } catch {
            throw new SummaryRejected("INVALID_SUMMARY", "aiSummary is not valid JSON data");
        }
        if (rawBytes > L.maxRawBytes) throw new SummaryRejected("PAYLOAD_TOO_LARGE", "aiSummary is too large", 413);

        const value = {
            summary: requireString(raw.summary, L.summaryChars, "summary"),
            key_points: cleanList(raw.key_points, "key_points")
                .map((p) => cleanString(p, L.keyPointChars))
                .filter(Boolean)
                .slice(0, L.keyPoints),
            insights: cleanInsights(raw.insights),
            decisions: cleanDecisions(raw.decisions),
            action_items: cleanActionItems(raw.action_items),
            provenance: cleanProvenance(raw.provenance),
        };

        if (Buffer.byteLength(JSON.stringify(value), "utf8") > L.maxStoredBytes) {
            throw new SummaryRejected("PAYLOAD_TOO_LARGE", "aiSummary is too large", 413);
        }
        return { ok: true, value };
    } catch (err) {
        if (err instanceof SummaryRejected) return { ok: false, code: err.code, message: err.message, status: err.status };
        return { ok: false, code: "INVALID_SUMMARY", message: "aiSummary could not be validated", status: 400 };
    }
}
