import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const workerState = vi.hoisted(() => ({ handler: null }));

vi.mock("bullmq", () => {
    const addMock = vi.fn().mockResolvedValue({ id: "job-1" });
    return {
        Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
        Worker: vi.fn().mockImplementation((_name, handler) => {
            workerState.handler = handler;
            return { on: vi.fn() };
        }),
    };
});

vi.mock("../../../src/models/ragChunk.model.js", () => ({
    default: { deleteMany: vi.fn(), insertMany: vi.fn(), aggregate: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../../src/models/ragSession.model.js", () => ({
    default: { findOne: vi.fn(), findOneAndUpdate: vi.fn(), findByIdAndUpdate: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock("../../../src/utils/redis.utils.js", () => ({
    makeLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    safeRedisGet: vi.fn(),
    safeRedisSet: vi.fn(),
    safeRedisDel: vi.fn(),
    safeRedisIncr: vi.fn(),
    safeRedisExpire: vi.fn(),
}));
vi.mock("../../../src/services/transcript.service.js", () => ({
    isAuthorized: vi.fn(),
    resolveAuth: vi.fn(),
}));
vi.mock("../../../src/data-access/transcript.repository.js", () => ({
    findTranscriptById: vi.fn(),
    findTranscriptByCode: vi.fn(),
}));
vi.mock("../../../src/infra/redis.js", () => ({ connectRedis: vi.fn() }));
vi.mock("../../../src/models/transcriptRequest.model.js", () => ({
    TranscriptRequest: { exists: vi.fn() },
}));

import RagChunk from "../../../src/models/ragChunk.model.js";
import { safeRedisGet, safeRedisSet, safeRedisDel, safeRedisIncr, safeRedisExpire } from "../../../src/utils/redis.utils.js";
import { isAuthorized, resolveAuth } from "../../../src/services/transcript.service.js";
import { findTranscriptById, findTranscriptByCode } from "../../../src/data-access/transcript.repository.js";
import { TranscriptRequest } from "../../../src/models/transcriptRequest.model.js";

let rag;
let indexQueue;

beforeAll(async () => {
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.NOMIC_API_KEY = "test-nomic-key";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    rag = await import("../../../src/services/rag.service.js");
    indexQueue = rag.indexQueue;
});

const doc = (over = {}) => ({
    _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    ownerId: "owner1",
    hostSecretHash: "h",
    meetingCode: "MEET1",
    metadata: { segments: [{ start: 0, end: 2, speaker: "A", text: "hello there everyone" }] },
    transcriptText: "hello there everyone",
    aiSummary: null,
    ...over,
});

let fetchMock;

beforeEach(() => {
    vi.clearAllMocks();
    safeRedisIncr.mockResolvedValue(1);
    safeRedisExpire.mockResolvedValue(true);
    safeRedisGet.mockResolvedValue(null);
    safeRedisSet.mockResolvedValue(true);
    safeRedisDel.mockResolvedValue(true);
    resolveAuth.mockReturnValue({ secret: null, userId: "owner1", secretHash: null });
    isAuthorized.mockReturnValue(true);
    findTranscriptById.mockResolvedValue(null);
    findTranscriptByCode.mockResolvedValue(doc());
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("RAG index and confidential transcripts", () => {
    it("refuses indexing: 403 with a clear message, nothing queued, nothing sent", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const r = await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("CONFIDENTIAL_TRANSCRIPT");
        expect(r.body.message).toMatch(/confidential/i);
        expect(indexQueue.add).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(safeRedisSet).not.toHaveBeenCalled();
    });

    it("a refusal does not use up the index quota", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(safeRedisIncr).not.toHaveBeenCalled();
    });

    it("also refuses a reader who was granted access through an approved request", async () => {
        resolveAuth.mockReturnValue({ secret: null, userId: "reader1", secretHash: null });
        isAuthorized.mockReturnValue(false);
        TranscriptRequest.exists.mockResolvedValue({ _id: "req" });
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const r = await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("CONFIDENTIAL_TRANSCRIPT");
        expect(indexQueue.add).not.toHaveBeenCalled();
    });

    it("does not reveal the flag to someone who is not authorised", async () => {
        resolveAuth.mockReturnValue({ secret: null, userId: "stranger", secretHash: null });
        isAuthorized.mockReturnValue(false);
        TranscriptRequest.exists.mockResolvedValue(null);
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const r = await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(r.status).toBe(403);
        expect(r.body.code).toBeUndefined();
        expect(r.body.message).toBe("Not authorized");
    });

    it("standard transcripts are still queued exactly as before (regression)", async () => {
        const r = await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(r.status).toBe(202);
        expect(indexQueue.add).toHaveBeenCalledTimes(1);
    });

    it("a transcript with no privacy field (created before this change) is still queued", async () => {
        const old = doc();
        expect("privacy" in old).toBe(false);
        findTranscriptByCode.mockResolvedValue(old);
        const r = await rag.indexTranscriptService({ params: { id: "MEET1" } });
        expect(r.status).toBe(202);
    });
});

describe("RAG query and confidential transcripts", () => {
    it("refuses queries: 403, no embedding request, no LLM request", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        safeRedisGet.mockImplementation(async (k) => (k.includes("rag:index:status:") ? "ready" : null));
        const result = await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "what was decided?" } });
        expect(result.status).toBe(403);
        expect(result.body.code).toBe("CONFIDENTIAL_TRANSCRIPT");
        expect(result.body.message).toMatch(/confidential/i);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(RagChunk.aggregate).not.toHaveBeenCalled();
    });

    it("writes the refusal to the HTTP response when one is supplied", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
        await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "q" } }, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json.mock.calls[0][0].code).toBe("CONFIDENTIAL_TRANSCRIPT");
    });

    it("a refusal does not use up the query quota", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "q" } });
        expect(safeRedisIncr).not.toHaveBeenCalled();
    });

    it("standard transcripts still reach the normal flow (regression)", async () => {
        const result = await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "q" } });
        expect(result.status).toBe(424);
        expect(result.body.indexStatus).toBe("not_indexed");
    });

    it("keeps the earlier status order for standard transcripts: 404 unknown, 429 over quota", async () => {
        findTranscriptByCode.mockResolvedValue(null);
        expect((await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "q" } })).status).toBe(404);
        findTranscriptByCode.mockResolvedValue(doc());
        safeRedisIncr.mockResolvedValue(10_000);
        expect((await rag.ragQueryService({ params: { id: "MEET1" }, body: { question: "q" } })).status).toBe(429);
    });
});

describe("RAG index worker and confidential transcripts", () => {
    const job = () => ({
        data: {
            transcriptId: "aaaaaaaaaaaaaaaaaaaaaaaa",
            meetingCode: "MEET1",
            ownerId: "owner1",
            segments: [{ start: 0, end: 2, speaker: "A", text: "hello there everyone" }],
            rawText: "hello there everyone",
            aiSummary: null,
            computedChecksum: "abc",
        },
    });

    it("skips a job queued before the transcript was marked confidential: no embedding call, no chunks stored", async () => {
        expect(typeof workerState.handler).toBe("function");
        findTranscriptById.mockResolvedValue(doc({ privacy: "confidential" }));
        await workerState.handler(job());
        expect(fetchMock).not.toHaveBeenCalled();
        expect(RagChunk.insertMany).not.toHaveBeenCalled();
        expect(RagChunk.deleteMany).not.toHaveBeenCalled();
        expect(safeRedisDel).toHaveBeenCalledWith("rag:index:status:aaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("still indexes a standard transcript", async () => {
        findTranscriptById.mockResolvedValue(doc());
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1, 0.2]] }) });
        await workerState.handler(job());
        expect(fetchMock).toHaveBeenCalled();
        expect(RagChunk.insertMany).toHaveBeenCalled();
    });
});
