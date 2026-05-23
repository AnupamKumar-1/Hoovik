import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { io as Client } from "socket.io-client";
import { makeLogger } from "../utils/redis.utils.js";

import { getState, mkdirp, UPLOAD_BASE } from "../services/socket.service.js";

import {
  handleJoinCall,
  handleUpdateParticipantState,
  handleUpdateMeta,
  handleChatMessage,
  handleTranscriptionUpdate,
  handleKeywordsUpdate,
  handleLeave,
  validateCode,
  getParticipants,
  REDIS_READ_FAILED,
} from "../services/socket.service.js";
import { startTimer, endTimer } from "../observability/latency/latency.service.js";

import { LATENCY_LABELS } from "../observability/latency/latency.constants.js";
import fs from "fs";
import { Meeting } from "../models/meeting.model.js";

const cfg = JSON.parse(
  fs.readFileSync(new URL("../config/config.json", import.meta.url))
);

const SOCKET_MAX_HTTP_BUFFER = parseInt(process.env.SOCKET_MAX_HTTP_BUFFER || `${100 * 1024 * 1024}`, 10);

const log = makeLogger("socket");

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
      if (participants_map === REDIS_READ_FAILED) {
        log.warn("broadcastParticipants skipped: redis unavailable", { code });
        return;
      }
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

async function getHostSocketId(io, meetingCode) {
  try {
    const roomName = `meeting:${meetingCode}`;
    const socketsInRoom = await io.in(roomName).fetchSockets();

    const hostSocket = socketsInRoom.find((s) => s.data?.isHost === true);

    if (hostSocket) return hostSocket.id;
    const stateArr = await getState(meetingCode);
    if (stateArr === REDIS_READ_FAILED) return null;

    return stateArr?.[0] ?? null;

  } catch {
    const stateArr = await getState(meetingCode);
    if (stateArr === REDIS_READ_FAILED) return null;
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

    socket.on("declare-host", async (meetingCodeRaw, secret, ack) => {
      const code = String(meetingCodeRaw || "").trim().toUpperCase();
      if (!code || !validateCode(code)) {
        if (typeof ack === "function") ack({ ok: false, reason: "invalid_code" });
        return;
      }
      if (socket.data?.meetingCode !== code) {
        if (typeof ack === "function") ack({ ok: false, reason: "not_in_room" });
        return;
      }
      const verified = await Meeting.verifyHostSecret(code, secret);
      if (!verified) {
        log.warn("declare-host failed: bad secret", { socketId: socket.id, code });
        if (typeof ack === "function") ack({ ok: false, reason: "unauthorized" });
        return;
      }
      socket.data.isHost = true;
      log.info("host declared and verified", { socketId: socket.id, code });
      if (typeof ack === "function") ack({ ok: true });
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

    socket.on("disconnect", async () => {
      try {
        if (socket.data?.replaced) return;
        const code = socket.data?.meetingCode;
        const { userId } = socket.data || {};
        if (!code || !userId) return;
        await handleLeave(socket, code, io, userId);
        broadcastParticipants(code, io);
      } catch (err) {
        log.error("disconnect error", { err: err.message });
      }
    });
  });

  return io;
}