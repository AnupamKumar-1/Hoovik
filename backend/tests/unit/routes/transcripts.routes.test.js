import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";

vi.hoisted(() => {
    process.env.GROQ_API_KEY = "test-groq-key";
});

// Real routes, controller and service. Auth is simulated from a test header; storage is mocked.
vi.mock("../../../config/passport.js", () => ({}));
vi.mock("passport", () => ({
    default: {
        authenticate: (_name, _opts, cb) => (req) => {
            const id = req.headers["x-test-user"];
            cb(null, id ? { id } : false);
        },
    },
}));

vi.mock("../../../src/utils/redis.utils.js", () => ({
    makeLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    safeRedisGet: vi.fn().mockResolvedValue(null),
    safeRedisSet: vi.fn().mockResolvedValue(true),
    safeRedisDel: vi.fn().mockResolvedValue(true),
    safeRedisIncr: vi.fn().mockResolvedValue(1),
    safeRedisExpire: vi.fn().mockResolvedValue(true),
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
    TranscriptRequest: { findOne: vi.fn().mockResolvedValue(null), find: vi.fn() },
}));

import {
    findTranscriptByCode,
    updateTranscriptPrivacy,
    updateTranscriptAiSummary,
} from "../../../src/data-access/transcript.repository.js";
import transcriptsRouter from "../../../src/routes/transcripts.js";

const doc = (over = {}) => ({
    _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    meetingCode: "ROOM-1",
    ownerId: "owner",
    hostSecretHash: null,
    transcriptText: "text",
    metadata: { segments: [{ start: 0, end: 1, speaker: "A", text: "hi there folks" }] },
    ...over,
});

describe("transcript routes (HTTP)", () => {
    let server;
    let base;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use("/api/v1/transcripts", transcriptsRouter);
        server = app.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}/api/v1/transcripts`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        findTranscriptByCode.mockResolvedValue(doc());
        updateTranscriptPrivacy.mockResolvedValue(doc({ privacy: "confidential" }));
        updateTranscriptAiSummary.mockResolvedValue(doc());
    });

    const call = (method, path, { user, body } = {}) =>
        fetch(`${base}${path}`, {
            method,
            headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });

    it("PATCH /:id/privacy lets the owner mark a transcript confidential", async () => {
        const res = await call("PATCH", "/ROOM-1/privacy", { user: "owner", body: { privacy: "confidential" } });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({ success: true, privacy: "confidential" });
        expect(updateTranscriptPrivacy).toHaveBeenCalledWith("aaaaaaaaaaaaaaaaaaaaaaaa", "confidential");
    });

    it("PATCH /:id/privacy is 403 for a non-owner and 403 when anonymous", async () => {
        expect((await call("PATCH", "/ROOM-1/privacy", { user: "stranger", body: { privacy: "confidential" } })).status).toBe(403);
        expect((await call("PATCH", "/ROOM-1/privacy", { body: { privacy: "confidential" } })).status).toBe(403);
        expect(updateTranscriptPrivacy).not.toHaveBeenCalled();
    });

    it("PATCH /:id/privacy is 400 for an invalid value", async () => {
        const res = await call("PATCH", "/ROOM-1/privacy", { user: "owner", body: { privacy: "secret" } });
        expect(res.status).toBe(400);
    });

    it("POST /:id/summary on a confidential transcript is 403 with a readable message", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const res = await call("POST", "/ROOM-1/summary", { user: "owner", body: {} });
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.message).toMatch(/confidential/i);
        const groqCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes("groq.com"));
        expect(groqCalls).toHaveLength(0);
        fetchSpy.mockRestore();
    });

    it("PATCH /:id/summary accepts a local summary for a confidential transcript", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const res = await call("PATCH", "/ROOM-1/summary", {
            user: "owner",
            body: { aiSummary: { summary: "Local only.", provenance: { source: "on-device", policy: "local-only", mode: "only_on_device" } } },
        });
        expect(res.status).toBe(200);
        expect(updateTranscriptAiSummary).toHaveBeenCalledTimes(1);
    });

    it("PATCH /:id/summary rejects a summary with no provenance", async () => {
        const res = await call("PATCH", "/ROOM-1/summary", { user: "owner", body: { aiSummary: { summary: "No provenance." } } });
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe("MISSING_PROVENANCE");
    });

    it("GET /:id returns the privacy setting", async () => {
        findTranscriptByCode.mockResolvedValue(doc({ privacy: "confidential" }));
        const res = await call("GET", "/ROOM-1", { user: "owner" });
        expect(res.status).toBe(200);
        expect((await res.json()).transcript.privacy).toBe("confidential");
    });
});
