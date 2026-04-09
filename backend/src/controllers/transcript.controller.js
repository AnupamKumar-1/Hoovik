import crypto from "crypto";
import Transcript from "../models/transcript.model.js";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function getHostSecret(req) {
  const raw =
    req.headers["x-host-secret"] ||
    req.body?.hostSecret ||
    req.query?.hostSecret ||
    null;
  if (!raw || typeof raw !== "string" || raw.length < 8 || raw.length > 256) return null;
  return raw;
}

function getUserId(req) {
  const u = req?.user;
  if (!u) return null;
  return String(u.id || u._id || u.sub || "");
}

export async function createTranscript(req, res) {
  try {
    const rawCode = req.body.meetingCode || req.body.meeting_code || req.body.code;
    if (!rawCode) {
      return res.status(400).json({ success: false, message: "meetingCode is required" });
    }

    const code = String(rawCode).toUpperCase().trim();
    const secret = getHostSecret(req);
    const userId = getUserId(req);

    if (!secret && !userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { transcriptText, fileName, metadata } = req.body;

    const doc = await Transcript.create({
      meetingCode: code,
      ownerId: userId || null,
      hostSecretHash: secret ? sha256Hex(secret) : null,
      transcriptText: transcriptText || req.body.transcript || metadata?.transcriptText || "",
      fileName: fileName || null,
      metadata: metadata || {},
    });

    return res.status(201).json({ success: true, transcript: doc });
  } catch (err) {
    console.error("createTranscript error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

export const saveTranscript = createTranscript;

export async function getTranscript(req, res) {
  try {
    const idOrCode = String(req.params.id || "").trim();
    if (!idOrCode) {
      return res.status(400).json({ success: false, message: "id or meetingCode required" });
    }

    const secret = getHostSecret(req);
    const userId = getUserId(req);

    if (!secret && !userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    let doc = null;

    if (idOrCode.match(/^[a-f\d]{24}$/i)) {
      doc = await Transcript.findById(idOrCode).lean();
    }

    if (!doc) {
      doc = await Transcript.findOne({ meetingCode: idOrCode.toUpperCase() }).lean();
    }

    if (!doc) {
      return res.status(404).json({ success: false, message: "Transcript not found" });
    }

    const secretHash = secret ? sha256Hex(secret) : null;
    const ownerMatch = userId && doc.ownerId === userId;
    const secretMatch = secretHash && doc.hostSecretHash === secretHash;

    if (!ownerMatch && !secretMatch) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    return res.json({ success: true, transcript: doc });
  } catch (err) {
    console.error("getTranscript error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

export const getTranscriptByCode = getTranscript;

export async function listTranscripts(req, res) {
  try {
    const { meeting_code, limit = 50 } = req.query;
    const finalLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const secret = getHostSecret(req);
    const userId = getUserId(req);

    if (!secret && !userId) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const orClauses = [];
    if (secret) orClauses.push({ hostSecretHash: sha256Hex(secret) });
    if (userId) orClauses.push({ ownerId: userId });

    const baseQuery = { $or: orClauses };

    if (meeting_code) {
      baseQuery.meetingCode = String(meeting_code).toUpperCase().trim();
    }

    const docs = await Transcript.find(
      baseQuery,
      { transcriptText: 1, meetingCode: 1, fileName: 1, metadata: 1, createdAt: 1, ownerId: 1 }
    )
      .sort({ createdAt: -1 })
      .limit(finalLimit)
      .lean();

    return res.json({ success: true, transcripts: docs });
  } catch (err) {
    console.error("listTranscripts error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}