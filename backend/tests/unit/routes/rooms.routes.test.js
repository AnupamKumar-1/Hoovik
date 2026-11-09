import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";

// Prevent the real JWT authentication configuration from loading.
vi.mock("../../../config/passport.js", () => ({}));

// Replace database functions with mock functions.
vi.mock("../../../src/data-access/rooms.repository.js", () => ({
    findMeetingByCode: vi.fn(),
    findActiveMeetingByCode: vi.fn(),
    createMeetingRoom: vi.fn(),
    findRoomsByOwner: vi.fn(),
}));

import {
    findActiveMeetingByCode,
} from "../../../src/data-access/rooms.repository.js";

import roomsRouter from "../../../src/routes/rooms.js";

describe("GET /api/v1/rooms/:roomCode", () => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        const app = express();

        app.use("/api/v1/rooms", roomsRouter);

        server = app.listen(0);

        await new Promise((resolve) => {
            server.once("listening", resolve);
        });

        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 400 for an invalid room code without querying the database", async () => {
        const response = await fetch(`${baseUrl}/api/v1/rooms/A3F9C12G`);

        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe("Invalid room code format");

        expect(findActiveMeetingByCode).not.toHaveBeenCalled();
    });

    it("allows a valid room code to reach the database lookup", async () => {
        const mockMeeting = {
            meetingCode: "A3F9C12B",
            hostName: "Test Host",
            createdAt: new Date("2026-01-01"),
            participants: [{ name: "Test Host" }],
            ownerId: "user123",
        };

        findActiveMeetingByCode.mockResolvedValue(mockMeeting);

        const response = await fetch(`${baseUrl}/api/v1/rooms/A3F9C12B`);

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.roomCode).toBe("A3F9C12B");
        expect(body.hostName).toBe("Test Host");
        expect(findActiveMeetingByCode).toHaveBeenCalledWith("A3F9C12B");
    });
});
