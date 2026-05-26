import fs from "fs";

const cfg = JSON.parse(
    fs.readFileSync(new URL("../config/config.json", import.meta.url))
);
import { makeLogger, safeRedisGet, safeRedisSet, safeRedisDel, safeRedisIncr, safeRedisExpire } from "../utils/redis.utils.js";
import { sha256Hex } from "../utils/helpers.utils.js";

import {
    createTranscriptDoc,
    findTranscriptById,
    findTranscriptByCode,
    listTranscriptDocs,
} from "../data-access/transcript.repository.js";

const TRANSCRIPT_MAX_TEXT_LENGTH = parseInt(process.env.TRANSCRIPT_MAX_TEXT_LENGTH || "500000", 10);
const TRANSCRIPT_CACHE_TTL_SEC = parseInt(process.env.TRANSCRIPT_CACHE_TTL_SEC || "300", 10);
const TRANSCRIPT_RATE_LIMIT_MAX = parseInt(process.env.TRANSCRIPT_RATE_LIMIT_MAX || "30", 10);
const TRANSCRIPT_RATE_LIMIT_WIN_SEC = parseInt(process.env.TRANSCRIPT_RATE_LIMIT_WIN_SEC || "60", 10);

const AI_SUMMARY_RATE_LIMIT_MAX = parseInt(process.env.AI_SUMMARY_RATE_LIMIT_MAX || "2", 10);
const AI_SUMMARY_RATE_LIMIT_WIN_SEC = parseInt(process.env.AI_SUMMARY_RATE_LIMIT_WIN_SEC || "7200", 10);

const NOISE_MIN_WORDS = parseInt(process.env.TRANSCRIPT_NOISE_MIN_WORDS || "4", 10);
const NOISE_MIN_UNIQUE_RATIO = parseFloat(process.env.TRANSCRIPT_NOISE_MIN_UNIQUE_RATIO || "0.4");
const NOISE_MAX_CHAR_REPEAT = parseInt(process.env.TRANSCRIPT_NOISE_MAX_CHAR_REPEAT || "4", 10);
const NOISE_MIN_ALPHA_RATIO = parseFloat(process.env.TRANSCRIPT_NOISE_MIN_ALPHA_RATIO || "0.6");
const NOISE_MIN_LINES = parseInt(process.env.TRANSCRIPT_NOISE_MIN_LINES || "1", 10);

export const LIST_DEFAULT_LIMIT = cfg.transcript?.listDefaultLimit ?? 50;
export const LIST_MAX_LIMIT = cfg.transcript?.listMaxLimit ?? 200;

const MEETING_CODE_RE = /^[A-Z0-9\-]{3,32}$/;

const FILLER_ONLY_RE = /^(uh+|um+|mm+|hmm+|hm+|ah+|oh+|eh+|er+|erm+|mhm+|yeah+|yep+|nope?|ok+ay?|like|so|well|right|sure)[.\s]*$/i;

export const RKEYS = {
    cacheById: (id) => `transcript:cache:${id}`,
    cacheByCode: (code) => `transcript:cache:code:${code}`,
    rate: (uid) => `transcript:rate:${uid}`,
    metricTotal: () => "transcript:requests:total",
    metricCached: () => "transcript:requests:cached",
    metricFailed: () => "transcript:requests:failed",
    aiSummaryRate: (uid) => `transcript:aisummary:rate:${uid}`,
};

const log = makeLogger("transcript");

const METRIC_TTL_SEC = parseInt(process.env.METRIC_TTL_SEC || `${30 * 24 * 3600}`, 10);

async function incr(key) {
    const count = await safeRedisIncr(key);
    if (count === 1) await safeRedisExpire(key, METRIC_TTL_SEC);
}

export function getHostSecret(req) {
    const raw = req.headers["x-host-secret"] || req.body?.hostSecret || req.query?.hostSecret || null;
    if (!raw || typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
    return raw;
}

export function getUserId(req) {
    const u = req?.user;
    if (!u) return null;
    return String(u.id || u._id?.toString() || u.sub || "");
}

export function sanitizeText(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

export function validateMeetingCode(code) {
    return MEETING_CODE_RE.test(code);
}

export function resolveAuth(req) {
    const secret = getHostSecret(req);
    const userId = getUserId(req);
    const secretHash = secret ? sha256Hex(secret) : null;
    return { secret, userId, secretHash };
}

export function isAuthorized(doc, userId, secretHash) {
    if (!doc) return false;
    const ownerMatch = userId && doc.ownerId && doc.ownerId === userId;
    const secretMatch = secretHash && doc.hostSecretHash && doc.hostSecretHash === secretHash;
    return !!(ownerMatch || secretMatch);
}

export async function isRateLimited(userId) {
    if (!userId) return false;
    const key = RKEYS.rate(userId);
    const count = await safeRedisIncr(key);
    if (count === 1) await safeRedisExpire(key, TRANSCRIPT_RATE_LIMIT_WIN_SEC);
    return count > TRANSCRIPT_RATE_LIMIT_MAX;
}

async function isAiSummaryRateLimited(userId) {
    if (!userId) return false;
    const key = RKEYS.aiSummaryRate(userId);
    const count = await safeRedisIncr(key);
    if (count === 1) await safeRedisExpire(key, AI_SUMMARY_RATE_LIMIT_WIN_SEC);
    return count > AI_SUMMARY_RATE_LIMIT_MAX;
}

function hasExcessiveCharRepeat(word) {
    let maxRun = 1, cur = 1;
    for (let i = 1; i < word.length; i++) {
        if (word[i].toLowerCase() === word[i - 1].toLowerCase()) {
            cur++;
            if (cur > maxRun) maxRun = cur;
        } else {
            cur = 1;
        }
    }
    return maxRun > NOISE_MAX_CHAR_REPEAT;
}

export function isNoiseLine(line) {
    if (!line || typeof line !== "string") return true;

    const stripped = line.trim();
    if (!stripped) return true;

    const alphaCount = (stripped.match(/[a-zA-Z]/g) || []).length;
    const totalChars = stripped.replace(/\s/g, "").length;
    if (totalChars === 0) return true;
    if (alphaCount / totalChars < NOISE_MIN_ALPHA_RATIO) return true;

    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length < NOISE_MIN_WORDS) return true;

    if (FILLER_ONLY_RE.test(stripped)) return true;

    const uniqueWords = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, "")));
    if (uniqueWords.size / words.length < NOISE_MIN_UNIQUE_RATIO) return true;

    const noiseWordCount = words.filter((w) => hasExcessiveCharRepeat(w)).length;
    if (noiseWordCount / words.length > 0.3) return true;

    return false;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function buildGroqPrompt(segments) {
    const transcriptText = segments
        .map((s) => `[${s.speaker || "Unknown"}] t=${Math.round(s.start)}s nlp_emotion=${s.emotion || "neutral"} | ${s.text}`)
        .join("\n");

    return `You are an expert meeting analyst. Analyze this meeting transcript and return a JSON object only — no markdown, no backticks, just raw JSON.

Transcript:
${transcriptText}

Return this exact JSON structure:
{
  "summary": "2-3 sentence overview of what the meeting was about",
  "key_points": ["point 1", "point 2", "point 3"],
  "insights": {
    "dominant_emotion": "one of: happy, sad, anger, fear, surprise, disgust, neutral",
    "emotion_distribution": { "neutral": 60, "happy": 25, "sad": 15 },
    "top_topics": ["topic1", "topic2", "topic3", "topic4", "topic5"],
    "speaker_stats": {
      "SpeakerName": {
        "turns": 3,
        "word_count": 45,
        "dominant_emotion": "neutral"
      }
    },
    "emotional_moments": [
      { "emotion": "happy", "text": "short quote from transcript", "start": 0 }
    ],
    "total_words": 100,
    "speaking_pace_wpm": 120,
    "total_duration_sec": 60
  }
}`;
}

export async function generateAiSummaryService(req) {
    const idOrCode = String(req.params.id || "").trim();
    if (!idOrCode) return { status: 400, body: { success: false, message: "id or meetingCode required" } };

    const { secret, userId, secretHash } = resolveAuth(req);
    if (!secret && !userId) return { status: 403, body: { success: false, message: "Not authorized" } };

    if (await isAiSummaryRateLimited(userId)) {
        return { status: 429, body: { success: false, message: "AI summary rate limit reached. Max 2 per 2 hours." } };
    }

    if (!GROQ_API_KEY) {
        log.error("generateAiSummary: GROQ_API_KEY not configured");
        return { status: 500, body: { success: false, message: "AI summary service not configured" } };
    }

    const isMongoId = /^[a-f\d]{24}$/i.test(idOrCode);
    let doc = null;
    if (isMongoId) doc = await findTranscriptById(idOrCode);
    if (!doc) doc = await findTranscriptByCode(idOrCode.toUpperCase());
    if (!doc) return { status: 404, body: { success: false, message: "Transcript not found" } };

    if (!isAuthorized(doc, userId, secretHash)) {
        return { status: 403, body: { success: false, message: "Not authorized" } };
    }

    const segments = doc.metadata?.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
        return { status: 400, body: { success: false, message: "Transcript has no segments to analyze" } };
    }

    try {
        const groqRes = await fetch(GROQ_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: buildGroqPrompt(segments) }],
                temperature: 0.3,
                max_tokens: 3000,
                response_format: { type: "json_object" },
            }),
        });

        if (!groqRes.ok) {
            const errBody = await groqRes.json().catch(() => ({}));
            const errMsg = errBody?.error?.message || groqRes.statusText || "Unknown error";
            log.error("Groq API error", { status: groqRes.status, errMsg });
            return { status: 502, body: { success: false, message: `AI provider error: ${groqRes.status}` } };
        }

        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content ?? "";
        const aiSummary = JSON.parse(raw);

        const { default: Transcript } = await import("../models/transcript.model.js");
        const updated = await Transcript.findByIdAndUpdate(
            doc._id,
            { $set: { aiSummary } },
            { new: true }
        ).lean();

        await Promise.all([
            safeRedisDel(RKEYS.cacheById(String(doc._id))),
            safeRedisDel(RKEYS.cacheByCode(String(doc.meetingCode))),
        ]);

        log.info("aiSummary generated and saved", { code: doc.meetingCode });
        return { status: 200, body: { success: true, aiSummary, transcript: updated } };
    } catch (err) {
        log.error("generateAiSummary error", { err: err.message });
        return { status: 500, body: { success: false, message: "Failed to generate AI summary" } };
    }
}

export async function updateAiSummaryService(req) {
    const idOrCode = String(req.params.id || "").trim();
    if (!idOrCode) return { status: 400, body: { success: false, message: "id or meetingCode required" } };

    const { secret, userId, secretHash } = resolveAuth(req);
    if (!secret && !userId) return { status: 403, body: { success: false, message: "Not authorized" } };

    const aiSummary = req.body?.aiSummary;
    if (!aiSummary || typeof aiSummary !== "object") {
        return { status: 400, body: { success: false, message: "aiSummary object required" } };
    }

    if (await isAiSummaryRateLimited(userId)) {
        return { status: 429, body: { success: false, message: "AI summary rate limit reached. Max 2 per 2 hours." } };
    }

    try {
        const isMongoId = /^[a-f\d]{24}$/i.test(idOrCode);
        let doc = null;
        if (isMongoId) doc = await findTranscriptById(idOrCode);
        if (!doc) doc = await findTranscriptByCode(idOrCode.toUpperCase());
        if (!doc) return { status: 404, body: { success: false, message: "Transcript not found" } };

        if (!isAuthorized(doc, userId, secretHash)) {
            return { status: 403, body: { success: false, message: "Not authorized" } };
        }

        const { default: Transcript } = await import("../models/transcript.model.js");
        const updated = await Transcript.findByIdAndUpdate(
            doc._id,
            { $set: { aiSummary } },
            { new: true }
        ).lean();

        // Invalidate cache
        await Promise.all([
            safeRedisDel(RKEYS.cacheById(String(doc._id))),
            safeRedisDel(RKEYS.cacheByCode(String(doc.meetingCode))),
        ]);

        log.info("aiSummary saved", { code: doc.meetingCode });
        return { status: 200, body: { success: true, transcript: updated } };
    } catch (err) {
        log.error("updateAiSummary error", { err: err.message });
        return { status: 500, body: { success: false, message: "Server error" } };
    }
}

export async function createTranscriptService(req) {
    await incr(RKEYS.metricTotal());

    const rawCode = req.body.meetingCode || req.body.meeting_code || req.body.code;
    if (!rawCode) return { status: 400, body: { success: false, message: "meetingCode is required" } };

    const code = String(rawCode).toUpperCase().trim();
    if (!validateMeetingCode(code)) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Invalid meetingCode format"
            }
        };
    }

    const { secret, userId, secretHash } = resolveAuth(req);
    if (!secret && !userId) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Not authorized"
            }
        };
    }

    const rawText = req.body.transcriptText || req.body.transcript || req.body.metadata?.transcriptText || "";
    const transcriptText = sanitizeText(rawText);

    if (transcriptText.length > TRANSCRIPT_MAX_TEXT_LENGTH) {
        return {
            status: 413,
            body: {
                success: false,
                message: `Transcript text exceeds the ${TRANSCRIPT_MAX_TEXT_LENGTH} character limit`
            }
        };
    }

    const cleanedLines = transcriptText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => !isNoiseLine(l));

    if (cleanedLines.length < NOISE_MIN_LINES) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Transcript empty or contains only noise after cleaning"
            }
        };
    }

    const finalText = cleanedLines.join("\n");

    const fileName = sanitizeText(req.body.fileName || "");
    const metadata = req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

    log.info("createTranscript debug", { code, secretHash, userId });

    try {
        const existing = await findTranscriptByCode(code);

        const finalOwnerId = existing?.ownerId || userId || null;
        const finalSecretHash = existing?.hostSecretHash || secretHash || null;

        const dbStart = Date.now();
        const doc = await createTranscriptDoc({
            meetingCode: code,
            ownerId: finalOwnerId,
            hostSecretHash: finalSecretHash,
            transcriptText: finalText,
            fileName,
            metadata,
        });
        log.info("created", { code, ms: Date.now() - dbStart });

        await Promise.all([
            safeRedisDel(RKEYS.cacheByCode(code)),
            safeRedisDel(RKEYS.cacheById(String(doc._id))),
        ]);

        return {
            status: 201,
            body: {
                success: true,
                transcript: doc
            }
        };
    } catch (err) {
        await incr(RKEYS.metricFailed());
        log.error("createTranscript error", { err: err.message });
        return { status: 500, body: { success: false, message: "Server error" } };
    }
}

export async function getTranscriptService(req) {
    await incr(RKEYS.metricTotal());

    const idOrCode = String(req.params.id || "").trim();
    if (!idOrCode) return {
        status: 400,
        body: {
            success: false,
            message: "id or meetingCode required"
        }
    };

    const { secret, userId, secretHash } = resolveAuth(req);
    if (!secret && !userId) return {
        status: 403,
        body: { success: false, message: "Not authorized" }
    };

    if (await isRateLimited(userId)) {
        return {
            status: 429,
            body: {
                success: false,
                message: "Too many requests, slow down"
            }
        };
    }

    const isMongoId = /^[a-f\d]{24}$/i.test(idOrCode);
    const cacheKey = isMongoId
        ? RKEYS.cacheById(idOrCode)
        : RKEYS.cacheByCode(idOrCode.toUpperCase());

    try {
        const cached = await safeRedisGet(cacheKey);
        if (cached !== null) {
            const doc = JSON.parse(cached);
            if (doc === null) return { status: 404, body: { success: false, message: "Transcript not found" } };
            if (!isAuthorized(doc, userId, secretHash)) return {
                status: 403, body: {
                    success: false,
                    message: "Not authorized"
                }
            };
            await incr(RKEYS.metricCached());

            log.info("cache hit", { key: cacheKey });
            return {
                status: 200,
                body: {
                    success: true,
                    transcript: doc
                }
            };
        }

        log.info("cache miss", { key: cacheKey });

        let doc = null;
        const dbStart = Date.now();
        if (isMongoId) doc = await findTranscriptById(idOrCode);
        if (!doc) doc = await findTranscriptByCode(idOrCode.toUpperCase());
        log.info("db query", { ms: Date.now() - dbStart });

        if (!doc) {
            await safeRedisSet(cacheKey, JSON.stringify(null), { EX: 30 });
            return {
                status: 404,
                body: {
                    success: false,
                    message: "Transcript not found"
                }
            };
        }

        if (!isAuthorized(doc, userId, secretHash)) {
            return {
                status: 403,
                body: {
                    success: false,
                    message: "Not authorized"
                }
            };
        }

        const payload = JSON.stringify(doc);
        await Promise.all([
            safeRedisSet(RKEYS.cacheById(String(doc._id)), payload, { EX: TRANSCRIPT_CACHE_TTL_SEC }),
            safeRedisSet(RKEYS.cacheByCode(String(doc.meetingCode)), payload, { EX: TRANSCRIPT_CACHE_TTL_SEC }),
        ]);

        return {
            status: 200,
            body: {
                success: true, transcript: doc
            }
        };
    } catch (err) {
        await incr(RKEYS.metricFailed());
        log.error("getTranscript error", { err: err.message });
        return {
            status: 500,
            body: {
                success: false, message: "Server error"
            }
        };
    }
}

export async function listTranscriptsService(req) {
    await incr(RKEYS.metricTotal());

    const { meeting_code, limit = LIST_DEFAULT_LIMIT } = req.query;
    const finalLimit = Math.min(Math.max(parseInt(limit, 10) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);

    const { secret, userId, secretHash } = resolveAuth(req);
    if (!secret && !userId) return {
        status: 403,
        body: {
            success: false,
            message: "Unauthorized"
        }
    };

    if (meeting_code) {
        const cleanCode = String(meeting_code).toUpperCase().trim();
        if (!validateMeetingCode(cleanCode)) {
            return {
                status: 400,
                body: {
                    success: false, message: "Invalid meeting_code format"
                }
            };
        }
    }

    const query = userId
        ? { ownerId: userId }
        : secretHash
            ? { hostSecretHash: secretHash }
            : null;

    if (!query) return {
        status: 403, body: {
            success: false, message: "Unauthorized"
        }
    };

    log.info("list query debug", { userId, hasSecret: !!secretHash, query });

    const meetingCodeFilter = meeting_code ? String(meeting_code).toUpperCase().trim() : null;

    try {
        const dbStart = Date.now();
        const docs = await listTranscriptDocs({ query, meetingCode: meetingCodeFilter, limit: finalLimit });
        log.info("listTranscripts complete", { count: docs.length, dbMs: Date.now() - dbStart });
        return {
            status: 200, body: {
                success: true, transcripts: docs
            }
        };
    } catch (err) {
        await incr(RKEYS.metricFailed());
        log.error("listTranscripts error", { err: err.message });
        return {
            status: 500,
            body: {
                success: false, message: "Server error"
            }
        };
    }
}