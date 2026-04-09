import { Server } from "socket.io";
import { io as Client } from "socket.io-client";
import sanitizeHtml from "sanitize-html";
import { Meeting } from "../models/meeting.model.js";
import { sendToEmotionService } from "./emotion.controller.js";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const mkdirp = (p) => fs.promises.mkdir(p, { recursive: true });
const unlink = (p) => fs.promises.rm(p, { force: true, maxRetries: 2, recursive: true });
const stat = (p) => fs.promises.stat(p).catch(() => null);
const writeFile = (p, buf) => fs.promises.writeFile(p, buf);

const EMOTION_SOCKET_URL = process.env.EMOTION_SOCKET_URL || "http://localhost:5002";
const UPLOAD_BASE = path.join(os.tmpdir(), "meet_uploads");
const PARTIAL_UPLOAD_MAX_BYTES = parseInt(process.env.PARTIAL_UPLOAD_MAX_BYTES || `${200 * 1024 * 1024}`, 10);
const PARTIAL_UPLOAD_TTL_MS = parseInt(process.env.PARTIAL_UPLOAD_TTL_MS || `${10 * 60 * 1000}`, 10);

const meetingState = {};
const meetingParticipants = {};
const PARTIAL_UPLOADS = new Map();
const EMOTION_CLIENTS = new Map();
const roomLocks = new Map();

function makeUploadDir(key) {
  const safeKey = key.replace(/[^\w\-_.]/g, "_");
  return path.join(UPLOAD_BASE, `${safeKey}_${crypto.randomBytes(6).toString("hex")}`);
}

function sanitizeName(raw) {
  return sanitizeHtml(String(raw || "Guest")).slice(0, 200) || "Guest";
}

function resolveUserId(meta, socket) {
  return meta?.userId
    ? String(meta.userId)
    : socket.handshake.auth?.userId || socket.id;
}

function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw?.data && Array.isArray(raw.data)) return Buffer.from(raw.data);
  throw new Error("unsupported buffer type");
}

async function withRoomLock(code, fn) {
  while (roomLocks.get(code)) {
    await roomLocks.get(code);
  }
  let resolve;
  const lock = new Promise((r) => { resolve = r; });
  roomLocks.set(code, lock);
  try {
    return await fn();
  } finally {
    roomLocks.delete(code);
    resolve();
  }
}

async function broadcastParticipants(code, io) {
  if (!meetingParticipants[code]) return;
  const participants = Array.from(meetingParticipants[code].values()).map((p) => ({
    id: p.socketId,
    meta: p.meta || {},
  }));
  io.in(`meeting:${code}`).emit("participants-updated", participants);
}

async function finalizeAnalytics(meeting) {
  console.log(`[socket] Finalizing analytics for meeting ${meeting.meetingCode}`);
}

async function handleLeave(socket, code, io, userId) {
  const meeting = await Meeting.findOne({ meetingCode: code });
  if (!meeting) return;

  await meeting.markParticipantLeft(socket.id);

  if (meetingState[code]) {
    meetingState[code] = meetingState[code].filter((id) => id !== socket.id);
    if (meetingState[code].length === 0) {
      delete meetingState[code];
      await finalizeAnalytics(meeting);
    }
  }

  if (meetingParticipants[code]) {
    meetingParticipants[code].delete(userId);
    if (meetingParticipants[code].size === 0) delete meetingParticipants[code];
  }

  socket.leave(`meeting:${code}`);
  socket.to(`meeting:${code}`).emit("user-left", socket.id);
  await broadcastParticipants(code, io);
}

function disconnectEmotionClient(clientKey) {
  const client = EMOTION_CLIENTS.get(clientKey);
  if (!client) return;
  try { client.disconnect(); } catch { }
  EMOTION_CLIENTS.delete(clientKey);
}

export function connectToSocket(
  server,
  corsOptions = { origin: "http://localhost:3000", methods: ["GET", "POST"], credentials: true }
) {
  const io = new Server(server, {
    cors: corsOptions,
    maxHttpBufferSize: parseInt(process.env.SOCKET_MAX_HTTP_BUFFER || `${100 * 1024 * 1024}`, 10),
    transports: ["websocket", "polling"],
    allowEIO3: true,
  });

  mkdirp(UPLOAD_BASE).catch(() => { });

  const cleanupInterval = setInterval(async () => {
    const now = Date.now();
    for (const [key, meta] of PARTIAL_UPLOADS.entries()) {
      if (now - (meta.createdAt || 0) > PARTIAL_UPLOAD_TTL_MS) {
        PARTIAL_UPLOADS.delete(key);
        await unlink(meta.dir).catch(() => { });
      }
    }
  }, 60_000);

  global.io = io;
  global.meetingState = meetingState;
  global.meetingParticipants = meetingParticipants;

  io.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);

    socket.on("join-call", async (meetingCodeRaw, meta = {}) => {
      try {
        const code = String(meetingCodeRaw || "").trim().toUpperCase();
        if (!code) return socket.emit("error", "Invalid meeting code");

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) return socket.emit("error", "Room does not exist. Please create it first.");

        const name = sanitizeName(meta.name);
        const userId = resolveUserId(meta, socket);
        const clientKey = `${code}__${userId}`;
        const cleanMeta = { ...meta, name };

        disconnectEmotionClient(clientKey);

        await withRoomLock(code, async () => {
          if (!meetingParticipants[code]) meetingParticipants[code] = new Map();
          if (!meetingState[code]) meetingState[code] = [];

          if (meetingParticipants[code].has(userId)) {
            const existing = meetingParticipants[code].get(userId);
            const oldSocketId = existing.socketId;

            meetingState[code] = meetingState[code].filter((id) => id !== oldSocketId);

            const oldSocket = io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
              oldSocket.data.replaced = true;
              oldSocket.leave(`meeting:${code}`);
              oldSocket.removeAllListeners();
              oldSocket.emit = () => { };
              try { oldSocket.disconnect(true); } catch { }
            }

            existing.socketId = socket.id;
            existing.meta = cleanMeta;

            if (!meetingState[code].includes(socket.id)) {
              meetingState[code].push(socket.id);
            }

            await meeting.restoreParticipant(socket.id, { userId, name }, cleanMeta);
          } else {
            meetingParticipants[code].set(userId, { socketId: socket.id, userId, meta: cleanMeta });

            if (!meetingState[code].includes(socket.id)) {
              meetingState[code].push(socket.id);
            }

            await meeting.addParticipant({ socketId: socket.id, name, meta: cleanMeta });
          }

          socket.data = { meetingCode: code, name, meta: cleanMeta, userId };
          meeting.active = true;
          await meeting.save();

          const roomName = `meeting:${code}`;
          socket.join(roomName);

          const politeRole = meetingState[code].indexOf(socket.id) !== 0;

          const existingPeers = Array.from(meetingParticipants[code].values())
            .filter((p) => p.socketId !== socket.id)
            .map((p) => ({
              id: p.socketId,
              meta: p.meta || {},
              polite: meetingState[code].indexOf(p.socketId) !== 0,
            }));

          socket.emit("existing-participants", existingPeers);
          socket.emit("assigned-role", { polite: politeRole });

          const rawHistory = Array.isArray(meeting.chat) ? meeting.chat : [];
          const normalizedHistory = rawHistory.map((m, idx) => {
            const id =
              m.id ||
              m._id ||
              (m.ts
                ? `${m.userId || m.from || "anon"}_${new Date(m.ts).getTime()}_${idx}`
                : crypto.randomBytes(8).toString("hex"));

            const ts =
              m.ts && typeof m.ts === "number"
                ? m.ts
                : m.ts
                  ? new Date(m.ts).getTime()
                  : Date.now();

            const stableUserId = m.userId || m.from || m.fromSocketId || m.sender || null;
            const msgName = m.meta?.name || m.name || "Guest";

            return {
              id,
              text: String(m.text || ""),
              from: stableUserId,
              userId: stableUserId,
              name: msgName,
              meta: { ...(m.meta || {}), name: msgName },
              ts,
            };
          });

          socket.emit("chat-history", normalizedHistory);

          socket.to(roomName).emit("user-joined", {
            id: socket.id,
            meta: cleanMeta,
            polite: politeRole,
          });

          await broadcastParticipants(code, io);

          setTimeout(() => {
            broadcastParticipants(code, io);
          }, 200);

          console.log(`[socket] ${name} (${socket.id}) joined ${code} — polite:${politeRole}`);

        });
      } catch (err) {
        console.error("[socket][join-call]", err);
        socket.emit("error", "Failed to join call");
      }
    });

    socket.on("update-participant-state", async (data = {}) => {
      try {
        const code = socket.data?.meetingCode;

        if (!code) return;

        console.log("VALID STATE UPDATE:", data);

        const { muted, screen } = data;

        const metaUpdate = {};
        if (muted !== undefined) metaUpdate.muted = !!muted;
        if (screen !== undefined) metaUpdate.screen = !!screen;

        socket.data.meta = {
          ...(socket.data.meta || {}),
          ...metaUpdate,
        };

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (meeting) {
          await meeting.updateParticipantMeta(socket.id, socket.data.meta);
        }

        if (meetingParticipants[code]?.has(socket.data.userId)) {
          meetingParticipants[code].get(socket.data.userId).meta = socket.data.meta;
        }

        io.in(`meeting:${code}`).emit("update-participant-state", {
          peerId: socket.id,
          muted: socket.data.meta.muted === true,
        });

      } catch (err) {
        console.error("[socket][update-participant-state]", err);
      }
    });

    socket.on("update-meta", async (metaUpdate = {}) => {
      try {
        const code = socket.data?.meetingCode;
        if (!code) return;

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) return;

        if (!metaUpdate || typeof metaUpdate !== "object") metaUpdate = {};

        const normalized = { ...metaUpdate };
        if (normalized.name !== undefined) normalized.name = sanitizeName(normalized.name) || socket.data.name;
        if (normalized.muted !== undefined) normalized.muted = !!normalized.muted;
        if (normalized.video !== undefined) normalized.video = !!normalized.video;
        if (normalized.screen !== undefined) normalized.screen = !!normalized.screen;

        socket.data.meta = { ...(socket.data.meta || {}), ...normalized };

        await meeting.updateParticipantMeta(socket.id, socket.data.meta);

        if (meetingParticipants[code]?.has(socket.data.userId)) {
          meetingParticipants[code].get(socket.data.userId).meta = socket.data.meta;
        }

        io.in(`meeting:${code}`).emit("participant-meta-updated", {
          id: socket.id,
          meta: socket.data.meta,
        });

        await broadcastParticipants(code, io);
      } catch (err) {
        console.error("[socket][update-meta]", err);
      }
    });

    socket.on("signal", (targetId, message) => {
      try {
        const code = socket.data?.meetingCode;
        if (!code || !meetingState[code]) return;
        io.to(targetId).emit("signal", socket.id, message);
      } catch (err) {
        console.error("[socket][signal]", err);
      }
    });

    socket.on("chat-message", async (meetingCodeRaw, msg = {}, ack) => {
      try {
        const code = String(meetingCodeRaw || "").trim().toUpperCase();
        if (!code) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const userId = socket.data?.userId || socket.id;
        const name = socket.data?.meta?.name || socket.data?.name || "Guest";
        const msgId = msg.id || crypto.randomBytes(10).toString("hex");
        const ts = Date.now();

        const chatMsg = {
          id: msgId,
          userId,
          from: userId,
          fromSocketId: socket.id,
          name,
          meta: { name, userId },
          text: sanitizeHtml(String(msg.text || "").slice(0, 2000)),
          ts,
        };

        try {
          await meeting.addChatMessage(chatMsg);
        } catch (dbErr) {
          console.warn("[socket][chat-message] persist failed:", dbErr?.message || dbErr);
        }

        const payload = {
          id: chatMsg.id,
          text: chatMsg.text,
          from: chatMsg.from,
          fromSocketId: chatMsg.fromSocketId,
          userId: chatMsg.userId,
          name: chatMsg.name,
          meta: chatMsg.meta,
          ts: chatMsg.ts,
        };

        socket.to(`meeting:${code}`).emit("chat-message", payload);
        socket.emit("chat-ack", payload);

        if (typeof ack === "function") ack({ ok: true });

        console.log(`[chat] ${name} (${userId}) -> ${code}: "${chatMsg.text}"`);
      } catch (err) {
        console.error("[socket][chat-message]", err);
        if (typeof ack === "function") ack({ ok: false });
        socket.emit("error", "Failed to send chat message");
      }
    });

    socket.on("transcription-update", async (chunk) => {
      try {
        const code = socket.data?.meetingCode;
        if (!code) return;

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) return;

        const cleanChunk = sanitizeHtml(String(chunk || "").slice(0, 500));
        await meeting.updateAnalytics({ transcription: cleanChunk });

        socket.to(`meeting:${code}`).emit("transcription-update", {
          from: socket.id,
          text: cleanChunk,
        });
      } catch (err) {
        console.error("[socket][transcription-update]", err);
      }
    });

    socket.on("emotion.chunk", async (payload = {}, ack) => {
      try {
        const meetingId = payload.meetingId || payload.meeting_id || payload.meeting || socket.data?.meetingCode;
        const participantId = payload.participantId || payload.participant_id || payload.from || socket.data?.userId;
        const seq = Number.isFinite(Number(payload.seq)) ? Number(payload.seq) : null;
        const totalChunks = Number.isFinite(Number(payload.totalChunks)) ? Number(payload.totalChunks) : null;
        const chunkRaw = payload.chunk;
        const filename = payload.filename || `upload_${Date.now()}.bin`;
        const maxBytes = Number(payload.maxBytes) || PARTIAL_UPLOAD_MAX_BYTES;

        if (!meetingId || !participantId || seq === null || totalChunks === null || !chunkRaw) {
          if (typeof ack === "function") ack({ ok: false, reason: "missing_fields" });
          return;
        }

        const key = `${String(meetingId).trim().toUpperCase()}__${String(participantId)}`;
        let meta = PARTIAL_UPLOADS.get(key);

        if (!meta) {
          if (totalChunks <= 0 || totalChunks > 50000) {
            if (typeof ack === "function") ack({ ok: false, reason: "invalid_totalChunks" });
            return;
          }
          const dir = makeUploadDir(key);
          await mkdirp(dir);
          meta = { dir, totalChunks, receivedBytes: 0, receivedCount: 0, filename, createdAt: Date.now(), maxBytes };
          PARTIAL_UPLOADS.set(key, meta);
        }

        let bufChunk;
        try {
          bufChunk = toBuffer(chunkRaw);
        } catch {
          if (typeof ack === "function") ack({ ok: false, reason: "invalid_chunk" });
          return;
        }

        if (meta.receivedBytes + bufChunk.length > meta.maxBytes) {
          PARTIAL_UPLOADS.delete(key);
          await unlink(meta.dir).catch(() => { });
          if (typeof ack === "function") ack({ ok: false, reason: "too_large" });
          return;
        }

        if (seq < 0 || seq >= meta.totalChunks) {
          if (typeof ack === "function") ack({ ok: false, reason: "invalid_seq" });
          return;
        }

        await writeFile(path.join(meta.dir, `chunk_${seq}`), bufChunk);

        meta.receivedBytes += bufChunk.length;
        meta.receivedCount += 1;
        meta.createdAt = Date.now();

        if (typeof ack === "function") ack({ ok: true, seq, receivedCount: meta.receivedCount });
      } catch (err) {
        console.error("[socket][emotion.chunk]", err);
        if (typeof ack === "function") ack({ ok: false, reason: "internal" });
      }
    });

    socket.on("emotion.chunk.abort", async (metaReq = {}, ack) => {
      try {
        const meetingId = metaReq.meetingId || metaReq.meeting_id || metaReq.meeting || socket.data?.meetingCode;
        const participantId = metaReq.participantId || metaReq.participant_id || metaReq.from || socket.data?.userId;

        if (!meetingId || !participantId) {
          if (typeof ack === "function") ack({ ok: false, reason: "missing" });
          return;
        }

        const key = `${String(meetingId).trim().toUpperCase()}__${String(participantId)}`;
        const meta = PARTIAL_UPLOADS.get(key);

        if (meta) {
          PARTIAL_UPLOADS.delete(key);
          await unlink(meta.dir).catch(() => { });
        }

        if (typeof ack === "function") ack({ ok: true });
      } catch (err) {
        console.error("[socket][emotion.chunk.abort]", err);
        if (typeof ack === "function") ack({ ok: false, reason: "internal" });
      }
    });

    socket.on("emotion.chunk.complete", async (metaReq = {}, ack) => {
      try {
        const meetingId = metaReq.meetingId || metaReq.meeting_id || metaReq.meeting || socket.data?.meetingCode;
        const participantId = metaReq.participantId || metaReq.participant_id || metaReq.from || socket.data?.userId;
        const type = (metaReq.type || "video").toLowerCase();

        if (!meetingId || !participantId) {
          if (typeof ack === "function") ack({ ok: false, reason: "missing" });
          return;
        }

        const key = `${String(meetingId).trim().toUpperCase()}__${String(participantId)}`;
        const meta = PARTIAL_UPLOADS.get(key);

        if (!meta) {
          if (typeof ack === "function") ack({ ok: false, reason: "missing_upload" });
          return;
        }

        const missing = [];
        for (let i = 0; i < meta.totalChunks; i++) {
          if (!(await stat(path.join(meta.dir, `chunk_${i}`)))) missing.push(i);
        }

        if (missing.length > 0) {
          if (typeof ack === "function") ack({ ok: false, reason: "missing_chunks", missing });
          return;
        }

        const finalFilename = meta.filename || `upload_${Date.now()}.bin`;
        const finalPath = path.join(meta.dir, `assembled_${finalFilename}`);
        const writeStream = fs.createWriteStream(finalPath, { flags: "w" });

        for (let i = 0; i < meta.totalChunks; i++) {
          await new Promise((res, rej) => {
            const rs = fs.createReadStream(path.join(meta.dir, `chunk_${i}`));
            rs.on("error", rej);
            rs.on("end", res);
            rs.pipe(writeStream, { end: false });
          });
        }

        await new Promise((res, rej) => {
          writeStream.end(res);
          writeStream.on("error", rej);
        });

        const finalStat = await stat(finalPath);

        if (!finalStat) {
          PARTIAL_UPLOADS.delete(key);
          await unlink(meta.dir).catch(() => { });
          if (typeof ack === "function") ack({ ok: false, reason: "assemble_failed" });
          return;
        }

        if (finalStat.size > meta.maxBytes) {
          PARTIAL_UPLOADS.delete(key);
          await unlink(meta.dir).catch(() => { });
          if (typeof ack === "function") ack({ ok: false, reason: "too_large_final" });
          return;
        }

        PARTIAL_UPLOADS.delete(key);

        let emotionRes;
        try {
          emotionRes = await sendToEmotionService(
            String(meetingId).trim().toUpperCase(),
            String(participantId),
            finalPath,
            type,
            { mime: metaReq.mime, filename: finalFilename, timeoutMs: metaReq.timeoutMs || undefined }
          );
        } catch (svcErr) {
          await unlink(meta.dir).catch(() => { });
          if (typeof ack === "function") ack({ ok: false, reason: "service_error", message: svcErr?.message || String(svcErr) });
          return;
        }

        try {
          const m = await Meeting.findOne({ meetingCode: String(meetingId).trim().toUpperCase() });
          if (m) await m.updateAnalytics({ emotionScores: emotionRes });
        } catch (dbErr) {
          console.warn("[emotion.chunk.complete] analytics persist failed:", dbErr);
        }

        const hostSocketId = meetingState[String(meetingId).trim().toUpperCase()]?.[0] ?? null;

        if (hostSocketId) {
          io.to(hostSocketId).emit("emotion.update", {
            meeting_id: String(meetingId).trim().toUpperCase(),
            participant_id: String(participantId),
            type,
            emotion: emotionRes,
            ts: Date.now(),
          });
        }

        await unlink(meta.dir).catch(() => { });

        if (typeof ack === "function") ack({ ok: true });
      } catch (err) {
        console.error("[socket][emotion.chunk.complete]", err);
        if (typeof ack === "function") ack({ ok: false, reason: "internal" });
      }
    });

    socket.on("emotion-update", async (data) => {
      try {
        const code = socket.data?.meetingCode;
        if (!code || typeof data !== "object") return;

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) return;

        await meeting.updateAnalytics({ emotionScores: data });

        const hostSocketId = meetingState[code]?.[0] ?? null;

        if (hostSocketId) {
          io.to(hostSocketId).emit("emotion-update", { from: socket.id, scores: data });
        } else {
          socket.to(`meeting:${code}`).emit("emotion-update", { from: socket.id, scores: data });
        }
      } catch (err) {
        console.error("[socket][emotion-update]", err);
      }
    });

    socket.on("keywords-update", async (keywords) => {
      try {
        const code = socket.data?.meetingCode;
        if (!code || !Array.isArray(keywords)) return;

        const meeting = await Meeting.findOne({ meetingCode: code });
        if (!meeting) return;

        const cleanKeywords = keywords.map((k) => sanitizeHtml(String(k).slice(0, 100)));
        await meeting.updateAnalytics({ keywords: cleanKeywords });

        socket.to(`meeting:${code}`).emit("keywords-update", { from: socket.id, keywords: cleanKeywords });
      } catch (err) {
        console.error("[socket][keywords-update]", err);
      }
    });

    socket.on("leave-call", async (meetingCodeRaw) => {
      try {
        const code = String(meetingCodeRaw || "").trim().toUpperCase();
        const { userId } = socket.data || {};
        await handleLeave(socket, code, io, userId);
      } catch (err) {
        console.error("[socket][leave-call]", err);
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

        if (!meetingCode || !participantId || !buffer) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        let buf;
        try {
          buf = toBuffer(buffer);
        } catch {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        if (typeof ack === "function") ack({ ok: true });

        const clientKey = `${meetingCode}__${participantId}`;
        let tempSocket = EMOTION_CLIENTS.get(clientKey);

        if (!tempSocket) {
          tempSocket = Client(EMOTION_SOCKET_URL, {
            transports: ["websocket"],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            auth: { meeting_id: meetingCode, participant_id: participantId },
          });

          tempSocket.on("emotion.result", async (res) => {
            try {
              const meeting = await Meeting.findOne({ meetingCode });
              if (meeting) await meeting.updateAnalytics({ emotionScores: res });

              const hostSocketId = meetingState[meetingCode]?.[0];
              if (hostSocketId) {
                io.to(hostSocketId).emit("emotion.result", {
                  participant_id: participantId,
                  result: res,
                  ts: Date.now(),
                });
              }
            } catch (e) {
              console.error("[emotion.result]", e);
            }
          });

          tempSocket.on("connect_error", (err) => {
            console.error("[emotion socket]", err.message);
          });

          EMOTION_CLIENTS.set(clientKey, tempSocket);
        }

        if (tempSocket.connected) {
          tempSocket.emit("frame", { frame: buf });
        } else {
          tempSocket.once("connect", () => tempSocket.emit("frame", { frame: buf }));
        }
      } catch (err) {
        console.error("[emotion.frame]", err);
        if (typeof ack === "function") ack({ ok: false });
      }
    });

    socket.on("disconnect", async () => {
      try {
        if (socket.data?.replaced) return;

        const code = socket.data?.meetingCode;
        const { userId } = socket.data || {};
        if (!code || !userId) return;

        disconnectEmotionClient(`${code}__${userId}`);
        await handleLeave(socket, code, io, userId);
      } catch (err) {
        console.error("[socket][disconnect]", err);
      }
    });
  });

  if (typeof process !== "undefined") {
    const cleanup = () => clearInterval(cleanupInterval);
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  return io;
}