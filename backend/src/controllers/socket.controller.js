import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { io as Client } from "socket.io-client";
import { makeLogger } from "../utils/redis.utils.js";
import { sendToEmotionService } from "./emotion.controller.js";
import { getState, mkdirp, UPLOAD_BASE } from "../services/socket.service.js";

import {
  handleJoinCall,
  handleUpdateParticipantState,
  handleUpdateMeta,
  handleChatMessage,
  handleTranscriptionUpdate,
  handleEmotionChunk,
  handleEmotionChunkAbort,
  handleEmotionChunkComplete,
  handleEmotionUpdate,
  handleKeywordsUpdate,
  handleLeave,
  validateCode,
  getParticipants,
} from "../services/socket.service.js";
import { startTimer, endTimer } from "../observability/latency/latency.service.js";

import { LATENCY_LABELS } from "../observability/latency/latency.constants.js";
import { updateMeetingAnalytics } from "../data-access/socket.repository.js";
import fs from "fs";

const cfg = JSON.parse(
  fs.readFileSync(new URL("../config/config.json", import.meta.url))
);

const EMOTION_SOCKET_URL = process.env.EMOTION_SOCKET_URL || "http://localhost:5002";
const SOCKET_MAX_HTTP_BUFFER = parseInt(process.env.SOCKET_MAX_HTTP_BUFFER || `${100 * 1024 * 1024}`, 10);
const EMOTION_RECONNECT_ATTEMPTS = cfg.emotionClients?.reconnectionAttempts ?? 5;
const EMOTION_RECONNECT_DELAY = cfg.emotionClients?.reconnectionDelay ?? 1000;

const log = makeLogger("socket");
const EMOTION_CLIENTS = new Map();
let broadcastDebounceTimers = new Map();

function toNodeBuffer(raw) {

  if (Buffer.isBuffer(raw)) return raw;

  if (raw instanceof Uint8Array) return Buffer.from(raw);

  if (raw instanceof ArrayBuffer) return Buffer.from(raw);

  if (typeof raw === "string") return Buffer.from(raw, "base64");

  if (raw && typeof raw === "object" && raw.type === "Buffer" && Array.isArray(raw.data)) {

    return Buffer.from(raw.data);
  }
  throw new Error("Cannot convert to Buffer: unsupported type " + typeof raw);
}

function broadcastParticipants(code, io) {

  if (broadcastDebounceTimers.has(code)) clearTimeout(broadcastDebounceTimers.get(code));

  broadcastDebounceTimers.set(code, setTimeout(async () => {

    broadcastDebounceTimers.delete(code);
    try {

      const participants_map = await getParticipants(code);
      if (!participants_map.size) return;

      const participants = Array.from(participants_map.values())
        .map((p) => ({
          id: p.socketId, meta: p.meta || {}
        }));

      io.in(`meeting:${code}`).emit("participants-updated", participants);

    } catch (e) {

      log.error("broadcastParticipants error", {
        code, err: e.message
      });
    }
  }, 150));
}

function cleanupEmotionClient(clientKey) {

  const client = EMOTION_CLIENTS.get(clientKey);
  if (!client) return;

  try {
    client.disconnect();
  } catch { }

  EMOTION_CLIENTS.delete(clientKey);
}

function createEmotionClient(clientKey, meetingCode, participantId, io) {

  const tempSocket = Client(EMOTION_SOCKET_URL, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: EMOTION_RECONNECT_ATTEMPTS,
    reconnectionDelay: EMOTION_RECONNECT_DELAY,

    auth: {
      meeting_id: meetingCode,
      participant_id: participantId

    },
  });

  tempSocket.on("emotion.result", async (res) => {

    log.info("emotion result from Python", { participantId, meetingCode, res });

    try {
      const emotion = res?.result?.emotion;
      const confidence = res?.result?.confidence;

      await updateMeetingAnalytics(meetingCode, { emotionScores: res });

      const hostSocketId = await getHostSocketId(io, meetingCode);

      if (hostSocketId) {

        // log.info("emitting emotion.result to host", { hostSocketId, participantId, emotion });

        io.to(hostSocketId).emit("emotion.result", {
          participantId,
          result: { emotion, confidence },
          ts: Date.now(),
        });

      } else {

        log.warn("no host socket found, broadcasting to room", { meetingCode });

        io.in(`meeting:${meetingCode}`)
          .emit("emotion.result", {
            participantId,
            result: { emotion, confidence },
            ts: Date.now(),
          });
      }
    } catch (e) {

      log.error("emotion.result handler error", { err: e.message });

    }
  });

  tempSocket.on("connect_error", (err) => {

    log.error("emotion socket connect_error", { clientKey, err: err.message });
  });

  tempSocket.on("disconnect", (reason) => {

    log.warn("emotion socket disconnected", { clientKey, reason });
    EMOTION_CLIENTS.delete(clientKey);

  });

  EMOTION_CLIENTS.set(clientKey, tempSocket);
  return tempSocket;
}

async function getHostSocketId(io, meetingCode) {
  try {
    const roomName = `meeting:${meetingCode}`;
    const socketsInRoom = await io.in(roomName).fetchSockets();

    const hostSocket = socketsInRoom.find((s) => s.data?.isHost === true);

    if (hostSocket) return hostSocket.id;
    const stateArr = await getState(meetingCode);

    return stateArr?.[0] ?? null;


  } catch {
    const stateArr = await getState(meetingCode);
    return stateArr?.[0] ?? null;
  }
}

export function connectToSocket(
  server,
  corsOptions = {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"], credentials: true
  },
  pubClient,
  subClient
) {
  const io = new Server(server, {
    cors: corsOptions,
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER,

    transports: cfg.socket?.transports ?? ["websocket", "polling"],
    allowEIO3: cfg.socket?.allowEIO3 ?? true,

  });

  io.adapter(createAdapter(pubClient, subClient));
  mkdirp(UPLOAD_BASE).catch(() => { });

  io.on("connection", (socket) => {
    log.info("connected", { socketId: socket.id });

    socket.on("join-call", async (meetingCodeRaw, meta = {}) => {
      try {
        const result = await handleJoinCall(socket, io, meetingCodeRaw, meta);
        if (result) broadcastParticipants(result.code, io);
      } catch (err) {
        log.error("join-call error", { err: err.message });
        socket.emit("error", "Failed to join call");
      }
    });

    socket.on("declare-host", (meetingCodeRaw) => {
      const code = String(meetingCodeRaw || "").trim().toUpperCase();
      if (!code || !validateCode(code)) return;
      if (socket.data?.meetingCode !== code) return;
      socket.data.isHost = true;
      log.info("host declared", { socketId: socket.id, code });
    });

    socket.on("update-participant-state", async (data = {}) => {
      try {
        await handleUpdateParticipantState(socket, io, data);
      } catch (err) {
        log.error("update-participant-state error", { err: err.message });
      }
    });

    socket.on("update-meta", async (metaUpdate = {}) => {
      try {
        const code = await handleUpdateMeta(socket, io, metaUpdate);
        if (code) broadcastParticipants(code, io);
      } catch (err) {
        log.error("update-meta error", { err: err.message });
      }
    });

    socket.on("signal", (targetId, message) => {
      const start = startTimer();
      try {
        const code = socket.data?.meetingCode;
        if (!code) return;
        io.to(targetId).emit("signal", socket.id, message);

      } catch (err) {
        log.error("signal error", { err: err.message });

      } finally {

        endTimer(LATENCY_LABELS.SOCKET_SIGNAL, start, { from: socket.id, to: targetId });
      }
    });

    socket.on("chat-message", async (meetingCodeRaw, msg = {}, ack) => {
      try {
        const result = await handleChatMessage(socket, io, meetingCodeRaw, msg);
        if (typeof ack === "function") ack(result);
      } catch (err) {
        log.error("chat-message error", { err: err.message });
        if (typeof ack === "function") ack({ ok: false });
        socket.emit("error", "Failed to send chat message");
      }
    });

    socket.on("transcription-update", async (chunk) => {
      try {
        await handleTranscriptionUpdate(socket, io, chunk);
      } catch (err) {
        log.error("transcription-update error", { err: err.message });
      }
    });

    socket.on("emotion.chunk", async (payload = {}, ack) => {
      try {
        const result = await handleEmotionChunk(socket, payload);

        if (typeof ack === "function") ack(result);

      } catch (err) {

        log.error("emotion.chunk error", { err: err.message });
        if (typeof ack === "function") ack({ ok: false, reason: "internal" });

      }
    });

    socket.on("emotion.chunk.abort", async (metaReq = {}, ack) => {
      try {
        const result = await handleEmotionChunkAbort(socket, metaReq);
        if (typeof ack === "function") ack(result);

      } catch (err) {

        log.error("emotion.chunk.abort error", { err: err.message });
        if (typeof ack === "function") ack({
          ok: false,
          reason: "internal"
        });
      }
    });

    socket.on("emotion.chunk.complete", async (metaReq = {}, ack) => {
      try {
        const result = await handleEmotionChunkComplete(socket, io, metaReq, sendToEmotionService);
        if (typeof ack === "function") ack(result);
      } catch (err) {
        log.error("emotion.chunk.complete error", { err: err.message });
        if (typeof ack === "function") ack({ ok: false, reason: "internal" });
      }
    });

    socket.on("emotion-update", async (data) => {
      try {
        await handleEmotionUpdate(socket, io, data);
      } catch (err) {
        log.error("emotion-update error", { err: err.message });
      }
    });

    socket.on("keywords-update", async (keywords) => {
      try {
        await handleKeywordsUpdate(socket, io, keywords);
      } catch (err) {
        log.error("keywords-update error", { err: err.message });
      }
    });

    socket.on("leave-call", async (meetingCodeRaw) => {
      try {
        const code = String(meetingCodeRaw || "").trim().toUpperCase();
        const { userId } = socket.data || {};
        await handleLeave(socket, code, io, userId);
        broadcastParticipants(code, io);
      } catch (err) {
        log.error("leave-call error", { err: err.message });
      }
    });

    socket.on("emotion.frame", async (payload, ack) => {
      try {
        if (!payload || typeof payload !== "object") {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const meetingCode = String(payload.meetingId || "").trim().toUpperCase();
        const participantId = payload.participantId || socket.data?.userId;
        const buffer = payload.buffer || payload.data;

        if (!meetingCode || !participantId || !buffer || !validateCode(meetingCode)) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        let buf;
        try {
          buf = toNodeBuffer(buffer);
        } catch (e) {
          log.warn("emotion.frame toNodeBuffer failed", { err: e.message });
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        if (buf.length === 0) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        if (typeof ack === "function") ack({ ok: true });

        const clientKey = `${meetingCode}__${participantId}`;
        let tempSocket = EMOTION_CLIENTS.get(clientKey);

        if (tempSocket && !tempSocket.connected && !tempSocket.active) {
          cleanupEmotionClient(clientKey);
          tempSocket = null;
        }

        if (!tempSocket) {
          tempSocket = createEmotionClient(clientKey, meetingCode, participantId, io);
        }

        if (tempSocket.connected) {
          tempSocket.emit("frame", buf);
        } else {
          tempSocket.once("connect", () => tempSocket.emit("frame", buf));
        }

      } catch (err) {
        log.error("emotion.frame error", { err: err.message });
        if (typeof ack === "function") ack({ ok: false });
      }
    });

    socket.on("disconnect", async () => {
      try {
        if (socket.data?.replaced) return;
        const code = socket.data?.meetingCode;
        const { userId } = socket.data || {};
        if (!code || !userId) return;
        cleanupEmotionClient(`${code}__${userId}`);
        await handleLeave(socket, code, io, userId);
        broadcastParticipants(code, io);
      } catch (err) {
        log.error("disconnect error", { err: err.message });
      }
    });
  });

  return io;
}