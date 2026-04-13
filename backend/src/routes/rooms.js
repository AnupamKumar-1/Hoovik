import express from "express";
import crypto from "crypto";
import { startTimer, endTimer } from "../observability/latency/latency.service.js";
import { LATENCY_LABELS } from "../observability/latency/latency.constants.js";
import {
  findMeetingByCode,
  findActiveMeetingByCode,
  createMeetingRoom,
  findRoomsByOwner,
} from "../data-access/rooms.repository.js";

const router = express.Router();

function generateHostSecretPair() {
  const hostSecret = crypto.randomBytes(32).toString("hex");
  const hostSecretHash = crypto.createHash("sha256").update(hostSecret).digest("hex");
  return { hostSecret, hostSecretHash };
}

function generateRoomCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

router.post("/", async (req, res) => {
  const start = startTimer();
  try {
    const { hostName } = req.body;

    if (!hostName || typeof hostName !== "string" || !hostName.trim()) {
      return res.status(400).json({ error: "Host name is required" });
    }

    let roomCode;
    let tries = 0;
    const maxTries = 5;
    do {
      roomCode = generateRoomCode();
      const existing = await findMeetingByCode(roomCode);
      if (!existing) break;
      tries += 1;
    } while (tries < maxTries);

    if (tries >= maxTries) {
      return res.status(500).json({ error: "Failed to generate unique room code, try again" });
    }

    const { hostSecret, hostSecretHash } = generateHostSecretPair();

    const meetingPayload = {
      meetingCode: roomCode,
      hostName: hostName.trim(),
      participants: [],
      chat: [],
      active: true,
      createdAt: new Date(),
      transcription: null,
      emotionAnalysis: null,
      hostSecretHash,
    };

    if (req.user && req.user.id) {
      meetingPayload.ownerId = req.user.id;
    }

    const meeting = await createMeetingRoom(meetingPayload);

    endTimer(LATENCY_LABELS.SOCKET_JOIN, start, {
      route: "POST /rooms",
      roomCode,
    });

    console.log(`[Room Created] ${roomCode} by ${hostName} ${meetingPayload.ownerId ? `(ownerId=${meetingPayload.ownerId})` : ""}`);
    res.status(201).json({
      message: "Room created successfully",
      roomCode: meeting.meetingCode,
      hostSecret,
      owner: !!meetingPayload.ownerId,
    });
  } catch (err) {
    endTimer(LATENCY_LABELS.SOCKET_JOIN, start, { route: "POST /rooms", error: true });
    console.error("Error creating room:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:roomCode", async (req, res) => {
  try {
    const { roomCode } = req.params;

    if (!roomCode || typeof roomCode !== "string") {
      return res.status(400).json({ error: "Room code is required" });
    }

    const meeting = await findActiveMeetingByCode(roomCode);

    if (!meeting) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json({
      roomCode: meeting.meetingCode,
      hostName: meeting.hostName,
      createdAt: meeting.createdAt,
      participantsCount: Array.isArray(meeting.participants) ? meeting.participants.length : 0,
      hasOwner: !!meeting.ownerId,
    });
  } catch (err) {
    console.error("Error fetching room:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/mine", async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const rooms = await findRoomsByOwner(req.user.id);
    res.json({ rooms });
  } catch (err) {
    console.error("Error fetching owner rooms:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;