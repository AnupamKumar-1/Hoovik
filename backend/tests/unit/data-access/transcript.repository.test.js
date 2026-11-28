import { describe, it, expect, vi, beforeEach } from "vitest";

const model = vi.hoisted(() => {
    const chain = { sort: vi.fn(), limit: vi.fn(), lean: vi.fn() };
    chain.sort.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    chain.lean.mockResolvedValue([]);
    return {
        chain,
        find: vi.fn(() => chain),
        findByIdAndUpdate: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ ok: true }) })),
    };
});

vi.mock("../../../src/models/transcript.model.js", () => ({
    default: { find: model.find, findByIdAndUpdate: model.findByIdAndUpdate },
}));
vi.mock("../../../src/models/meeting.model.js", () => ({ Meeting: { findOne: vi.fn() } }));

import {
    listTranscriptDocs,
    updateTranscriptPrivacy,
    updateTranscriptAiSummary,
} from "../../../src/data-access/transcript.repository.js";

beforeEach(() => vi.clearAllMocks());

describe("transcript repository", () => {
    it("the list projection includes privacy so the UI can disable cloud controls", async () => {
        await listTranscriptDocs({ query: { ownerId: "u" }, limit: 5 });
        const projection = model.find.mock.calls[0][1];
        expect(projection.privacy).toBe(1);
        expect(projection.aiSummary).toBe(1);
    });

    it("updates only the privacy field", async () => {
        await updateTranscriptPrivacy("id1", "confidential");
        expect(model.findByIdAndUpdate).toHaveBeenCalledWith("id1", { $set: { privacy: "confidential" } }, { new: true });
    });

    it("updates only the aiSummary field", async () => {
        const summary = { summary: "s" };
        await updateTranscriptAiSummary("id1", summary);
        expect(model.findByIdAndUpdate).toHaveBeenCalledWith("id1", { $set: { aiSummary: summary } }, { new: true });
    });
});
