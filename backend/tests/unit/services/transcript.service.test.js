import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
    process.env.GROQ_API_KEY = "test-groq-key";
});

vi.mock("../../../src/utils/redis.utils.js", () => ({
    makeLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    safeRedisGet: vi.fn(),
    safeRedisSet: vi.fn(),
    safeRedisDel: vi.fn(),
    safeRedisIncr: vi.fn(),
    safeRedisExpire: vi.fn(),
}));

vi.mock("../../../src/data-access/transcript.repository.js", () => ({
    createTranscriptDoc: vi.fn(),
    findTranscriptById: vi.fn(),
    findTranscriptByCode: vi.fn(),
    listTranscriptDocs: vi.fn(),
    updateTranscriptPrivacy: vi.fn(),
    updateTranscriptAiSummary: vi.fn(),
}));

vi.mock("../../../src/models/transcriptRequest.model.js", () => ({
    TranscriptRequest: { findOne: vi.fn(), find: vi.fn() },
}));

import {
    safeRedisGet,
    safeRedisSet,
    safeRedisDel,
    safeRedisIncr,
    safeRedisExpire,
} from "../../../src/utils/redis.utils.js";
import {
    findTranscriptById,
    findTranscriptByCode,
    listTranscriptDocs,
    updateTranscriptPrivacy,
    updateTranscriptAiSummary,
} from "../../../src/data-access/transcript.repository.js";
import { TranscriptRequest } from "../../../src/models/transcriptRequest.model.js";
import { sha256Hex } from "../../../src/utils/helpers.utils.js";

let svc;
beforeAll(async () => {
    svc = await import("../../../src/services/transcript.service.js");
});

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const SECRET = "host-secret-value";
const OID = "aaaaaaaaaaaaaaaaaaaaaaaa";

const makeDoc = (over = {}) => ({
    _id: OID,
    meetingCode: "ROOM-1",
    ownerId: OWNER,
    hostSecretHash: sha256Hex(SECRET),
    transcriptText: "secret meeting text",
    metadata: { segments: [{ start: 0, end: 3, speaker: "Priya", text: "We ship Friday", emotion: "neutral" }] },
    aiSummary: null,
    ...over,
});

const req = ({ user, secret, body = {}, params = { id: "ROOM-1" }, query = {} } = {}) => ({
    params,
    body,
    query,
    headers: secret ? { "x-host-secret": secret } : {},
    user: user ? { id: user } : undefined,
});

const summaryBody = (over = {}) => ({
    aiSummary: {
        summary: "Short local summary.",
        key_points: ["one"],
        insights: {},
        decisions: [],
        action_items: [],
        provenance: { source: "on-device", policy: "local-only", mode: "only_on_device" },
        ...over,
    },
});

beforeEach(() => {
    vi.resetAllMocks();
    safeRedisIncr.mockResolvedValue(1);
    safeRedisExpire.mockResolvedValue(true);
    safeRedisGet.mockResolvedValue(null);
    safeRedisSet.mockResolvedValue(true);
    safeRedisDel.mockResolvedValue(true);
    findTranscriptByCode.mockResolvedValue(makeDoc());
    findTranscriptById.mockResolvedValue(null);
    updateTranscriptAiSummary.mockImplementation(async (_id, aiSummary) => makeDoc({ aiSummary }));
    updateTranscriptPrivacy.mockImplementation(async (_id, privacy) => makeDoc({ privacy }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("PATCH summary (client-made summaries)", () => {
    it("saves a valid on-device summary and invalidates both cache keys", async () => {
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        expect(r.status).toBe(200);
        expect(updateTranscriptAiSummary).toHaveBeenCalledTimes(1);
        const [id, stored] = updateTranscriptAiSummary.mock.calls[0];
        expect(id).toBe(OID);
        expect(stored.provenance.source).toBe("on-device");
        expect(safeRedisDel).toHaveBeenCalledWith(svc.RKEYS.cacheById(OID));
        expect(safeRedisDel).toHaveBeenCalledWith(svc.RKEYS.cacheByCode("ROOM-1"));
    });

    it("stores the sanitised copy, not the raw body", async () => {
        const body = summaryBody({ evil: "x", action_items: [{ task: "t", owner: "Priya", $set: { ownerId: "me" } }] });
        await svc.updateAiSummaryService(req({ user: OWNER, body }));
        const stored = updateTranscriptAiSummary.mock.calls[0][1];
        expect(stored.evil).toBeUndefined();
        expect(stored.action_items[0].$set).toBeUndefined();
    });

    it.each([
        ["missing aiSummary", {}, 400],
        ["missing provenance", { aiSummary: { summary: "s" } }, 400],
        ["wrong source", summaryBody({ provenance: { source: "groq" } }), 400],
        ["wrong types", summaryBody({ key_points: "nope" }), 400],
        ["oversize", summaryBody({ summary: "x".repeat(250_000) }), 413],
    ])("rejects %s without touching the database", async (_name, body, status) => {
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body }));
        expect(r.status).toBe(status);
        expect(r.body.success).toBe(false);
        expect(updateTranscriptAiSummary).not.toHaveBeenCalled();
        expect(findTranscriptByCode).not.toHaveBeenCalled();
    });

    it("uses its own limiter key, separate from the Groq summary limiter", async () => {
        await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        const keys = safeRedisIncr.mock.calls.map((c) => c[0]);
        expect(keys).toContain(svc.RKEYS.clientSummaryRate(OWNER));
        expect(keys).not.toContain(svc.RKEYS.aiSummaryRate(OWNER));
        expect(svc.RKEYS.clientSummaryRate(OWNER)).not.toBe(svc.RKEYS.aiSummaryRate(OWNER));
    });

    it("returns 429 once the client-summary limit is exceeded, and does not save", async () => {
        safeRedisIncr.mockResolvedValue(10_000);
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        expect(r.status).toBe(429);
        expect(updateTranscriptAiSummary).not.toHaveBeenCalled();
    });

    it("an exhausted Groq quota does not block saving a local summary", async () => {
        safeRedisIncr.mockImplementation(async (key) => (key === svc.RKEYS.aiSummaryRate(OWNER) ? 10_000 : 1));
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        expect(r.status).toBe(200);
    });

    it("the host-secret path is not rate limited, as before", async () => {
        safeRedisIncr.mockResolvedValue(10_000);
        const r = await svc.updateAiSummaryService(req({ secret: SECRET, body: summaryBody() }));
        expect(r.status).toBe(200);
        expect(safeRedisIncr).not.toHaveBeenCalled();
    });

    it("rejects callers with no credentials", async () => {
        const r = await svc.updateAiSummaryService(req({ body: summaryBody() }));
        expect(r.status).toBe(403);
        expect(updateTranscriptAiSummary).not.toHaveBeenCalled();
    });

    it("a non-owner cannot save a summary", async () => {
        const r = await svc.updateAiSummaryService(req({ user: STRANGER, body: summaryBody() }));
        expect(r.status).toBe(403);
        expect(updateTranscriptAiSummary).not.toHaveBeenCalled();
    });

    it("a wrong host secret cannot save a summary", async () => {
        const r = await svc.updateAiSummaryService(req({ secret: "wrong", body: summaryBody() }));
        expect(r.status).toBe(403);
    });

    it("an approved reader (not the owner) cannot save a summary", async () => {
        TranscriptRequest.findOne.mockResolvedValue({ status: "approved" });
        const r = await svc.updateAiSummaryService(req({ user: STRANGER, body: summaryBody() }));
        expect(r.status).toBe(403);
    });

    it("returns 404 for an unknown transcript", async () => {
        findTranscriptByCode.mockResolvedValue(null);
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        expect(r.status).toBe(404);
    });

    it("accepts a local summary for a confidential transcript", async () => {
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        updateTranscriptAiSummary.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.updateAiSummaryService(req({ user: OWNER, body: summaryBody() }));
        expect(r.status).toBe(200);
        expect(updateTranscriptAiSummary).toHaveBeenCalledTimes(1);
        expect(r.body.transcript.privacy).toBe("confidential");
    });
});

describe("POST summary (Groq) and confidential transcripts", () => {
    const groqOk = () => vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: "cloud summary", key_points: [] }) } }] }),
    });

    it("refuses with 403 and a clear message, and never calls Groq", async () => {
        const fetchMock = groqOk();
        vi.stubGlobal("fetch", fetchMock);
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));

        const r = await svc.generateAiSummaryService(req({ user: OWNER }));
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("CONFIDENTIAL_TRANSCRIPT");
        expect(r.body.message).toMatch(/confidential/i);
        expect(r.body.message).toMatch(/on-device/i);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(updateTranscriptAiSummary).not.toHaveBeenCalled();
    });

    it("refuses the host-secret holder too", async () => {
        const fetchMock = groqOk();
        vi.stubGlobal("fetch", fetchMock);
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.generateAiSummaryService(req({ secret: SECRET }));
        expect(r.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a refusal does not use up the Groq quota", async () => {
        vi.stubGlobal("fetch", groqOk());
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        await svc.generateAiSummaryService(req({ user: OWNER }));
        expect(safeRedisIncr).not.toHaveBeenCalled();
    });

    it("does not reveal the confidential flag to someone who is not authorised", async () => {
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.generateAiSummaryService(req({ user: STRANGER }));
        expect(r.status).toBe(403);
        expect(r.body.message).toBe("Not authorized");
        expect(r.body.code).toBeUndefined();
    });

    it("standard transcripts behave exactly as before (regression)", async () => {
        const fetchMock = groqOk();
        vi.stubGlobal("fetch", fetchMock);
        const r = await svc.generateAiSummaryService(req({ user: OWNER }));
        expect(r.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(updateTranscriptAiSummary).toHaveBeenCalledWith(OID, { summary: "cloud summary", key_points: [] });
        expect(safeRedisDel).toHaveBeenCalledWith(svc.RKEYS.cacheById(OID));
        expect(r.body.transcript.privacy).toBe("standard");
    });

    it("a transcript with no privacy field (created before this change) still works", async () => {
        const fetchMock = groqOk();
        vi.stubGlobal("fetch", fetchMock);
        const doc = makeDoc();
        expect("privacy" in doc).toBe(false);
        findTranscriptByCode.mockResolvedValue(doc);
        const r = await svc.generateAiSummaryService(req({ user: OWNER }));
        expect(r.status).toBe(200);
    });

    it("keeps the previous status codes for standard transcripts: 429 over quota, 404 unknown, 403 stranger", async () => {
        vi.stubGlobal("fetch", groqOk());
        safeRedisIncr.mockResolvedValue(10_000);
        expect((await svc.generateAiSummaryService(req({ user: OWNER }))).status).toBe(429);
        safeRedisIncr.mockResolvedValue(1);
        findTranscriptByCode.mockResolvedValue(null);
        expect((await svc.generateAiSummaryService(req({ user: OWNER }))).status).toBe(404);
        findTranscriptByCode.mockResolvedValue(makeDoc());
        expect((await svc.generateAiSummaryService(req({ user: STRANGER }))).status).toBe(403);
    });
});

describe("PATCH privacy", () => {
    it("lets the owner mark a transcript confidential and invalidates caches", async () => {
        const r = await svc.updateTranscriptPrivacyService(req({ user: OWNER, body: { privacy: "confidential" } }));
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ success: true, privacy: "confidential", meetingCode: "ROOM-1" });
        expect(r.body.transcriptText).toBeUndefined();
        expect(updateTranscriptPrivacy).toHaveBeenCalledWith(OID, "confidential");
        expect(safeRedisDel).toHaveBeenCalledWith(svc.RKEYS.cacheById(OID));
        expect(safeRedisDel).toHaveBeenCalledWith(svc.RKEYS.cacheByCode("ROOM-1"));
    });

    it("lets the owner switch back to standard", async () => {
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.updateTranscriptPrivacyService(req({ user: OWNER, body: { privacy: "standard" } }));
        expect(r.status).toBe(200);
        expect(updateTranscriptPrivacy).toHaveBeenCalledWith(OID, "standard");
    });

    it("the host-secret holder can change it", async () => {
        const r = await svc.updateTranscriptPrivacyService(req({ secret: SECRET, body: { privacy: "confidential" } }));
        expect(r.status).toBe(200);
    });

    it("a non-owner cannot change it", async () => {
        const r = await svc.updateTranscriptPrivacyService(req({ user: STRANGER, body: { privacy: "confidential" } }));
        expect(r.status).toBe(403);
        expect(updateTranscriptPrivacy).not.toHaveBeenCalled();
    });

    it("an approved reader cannot change it", async () => {
        TranscriptRequest.findOne.mockResolvedValue({ status: "approved" });
        const r = await svc.updateTranscriptPrivacyService(req({ user: STRANGER, body: { privacy: "standard" } }));
        expect(r.status).toBe(403);
        expect(updateTranscriptPrivacy).not.toHaveBeenCalled();
    });

    it("rejects a wrong host secret and missing credentials", async () => {
        expect((await svc.updateTranscriptPrivacyService(req({ secret: "wrong", body: { privacy: "confidential" } }))).status).toBe(403);
        expect((await svc.updateTranscriptPrivacyService(req({ body: { privacy: "confidential" } }))).status).toBe(403);
    });

    it.each([[undefined], [""], ["private"], [true], [{ nested: "object" }]])("rejects invalid value %j", async (value) => {
        const r = await svc.updateTranscriptPrivacyService(req({ user: OWNER, body: { privacy: value } }));
        expect(r.status).toBe(400);
        expect(updateTranscriptPrivacy).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown transcript", async () => {
        findTranscriptByCode.mockResolvedValue(null);
        const r = await svc.updateTranscriptPrivacyService(req({ user: OWNER, body: { privacy: "confidential" } }));
        expect(r.status).toBe(404);
    });

    it("is idempotent: setting the current value writes nothing", async () => {
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.updateTranscriptPrivacyService(req({ user: OWNER, body: { privacy: "confidential" } }));
        expect(r.status).toBe(200);
        expect(updateTranscriptPrivacy).not.toHaveBeenCalled();
    });
});

describe("privacy is returned to the client", () => {
    it("GET returns privacy for a confidential transcript", async () => {
        findTranscriptByCode.mockResolvedValue(makeDoc({ privacy: "confidential" }));
        const r = await svc.getTranscriptService(req({ user: OWNER }));
        expect(r.status).toBe(200);
        expect(r.body.transcript.privacy).toBe("confidential");
    });

    it("GET returns standard for a transcript stored before the field existed", async () => {
        const r = await svc.getTranscriptService(req({ user: OWNER }));
        expect(r.body.transcript.privacy).toBe("standard");
    });

    it("GET returns privacy on a cache hit too", async () => {
        safeRedisGet.mockResolvedValue(JSON.stringify(makeDoc({ privacy: "confidential" })));
        const r = await svc.getTranscriptService(req({ user: OWNER }));
        expect(r.body.transcript.privacy).toBe("confidential");
        expect(findTranscriptByCode).not.toHaveBeenCalled();
    });

    it("the list endpoint returns privacy for every transcript", async () => {
        TranscriptRequest.find.mockReturnValue({ lean: async () => [] });
        listTranscriptDocs.mockResolvedValue([makeDoc({ privacy: "confidential" }), makeDoc({ _id: "b", meetingCode: "ROOM-2" })]);
        const r = await svc.listTranscriptsService(req({ user: OWNER }));
        expect(r.status).toBe(200);
        expect(r.body.transcripts.map((t) => t.privacy)).toEqual(["confidential", "standard"]);
    });
});
