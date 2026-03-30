// backend/src/controllers/transcript.controller.js

import crypto from "crypto";
import Transcript from "../models/transcript.model.js";
import { Meeting } from "../models/meeting.model.js";

/**
 * Helper: read hostSecret from header / body / query
 */
function getHostSecretFromReq(req) {
  return (
    req.headers["x-host-secret"] ||
    req.body?.hostSecret ||
    req.query?.hostSecret ||
    null
  );
}

function isSha256(str) {
  return /^[a-f0-9]{64}$/i.test(str);
}

/**
 * Helper: compute sha256 hex
 */
function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

/**
 * Normalize user id
 */
function getUserIdFromReq(req) {
  if (!req?.user) return null;

  if (req.user.id) return String(req.user.id);
  if (req.user._id) return String(req.user._id);
  if (req.user.sub) return String(req.user.sub);

  return null;
}

/**
 * Verify hostSecret for meeting
 */
async function verifyHostSecretForMeeting(meetingCode, providedSecret) {
  if (!meetingCode || !providedSecret) return null;

  const providedHash = sha256Hex(providedSecret);

  const meeting = await Meeting.findOne({
  meetingCode: String(meetingCode).toUpperCase(),
  hostSecretHash: providedHash,
}).lean();
console.log("🔥 VERIFY SECRET FOR:", meetingCode);
console.log("🔥 PROVIDED HASH:", providedHash);
  return meeting || null;
}

/**
 * Find meetings by hostSecret
 */
async function findMeetingsByHostSecret(providedSecret) {
  if (!providedSecret) return [];

  const providedHash = sha256Hex(providedSecret);

  return await Meeting.find({
  hostSecretHash: providedHash,
}).lean();
}

/**
 * Find meetings by owner
 */
async function findMeetingsByOwnerId(ownerId) {
  return await Meeting.find({
    $or: [{ ownerId }, { host: ownerId }],
  }).lean();
}

/**
 * Authorize access
 */
async function authorizeMeetingAccess(meetingCode, providedSecret, reqUser) {
  if (!meetingCode) return null;

  const code = String(meetingCode).toUpperCase();

  // ✅ hostSecret check
  if (providedSecret) {
    const meeting = await verifyHostSecretForMeeting(code, providedSecret);
    if (meeting) return meeting;
  }

  // ✅ user ownership check
  if (reqUser) {
    const userId = getUserIdFromReq({ user: reqUser });

    if (userId) {
      const meeting = await Meeting.findOne({
        meetingCode: code,
        $or: [{ ownerId: userId }, { host: userId }],
      }).lean();

      if (meeting) return meeting;
    }
  }

  return null;
}

/**
 * CREATE / UPDATE transcript
 */
export async function createTranscript(req, res) {
  try {
    // ✅ ACCEPT ALL POSSIBLE FIELD NAMES
    const meetingCodeInput =
      req.body.meetingCode ||
      req.body.meeting_code ||
      req.body.code;

    const { transcriptText, fileName, createdAt, metadata } = req.body;

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;

    console.log("🔥 CREATE TRANSCRIPT");
    console.log("👉 RAW BODY:", req.body);
    console.log("👉 meetingCodeInput:", meetingCodeInput);
    console.log("👉 hostSecret:", hostSecret);
    console.log("👉 user:", reqUser?._id || reqUser?.id);

    // ❌ VALIDATION
    if (!meetingCodeInput) {
      console.error("❌ meetingCode missing");
      return res.status(400).json({
        success: false,
        message: "meetingCode is required",
      });
    }

    const code = String(meetingCodeInput).toUpperCase();

    // ✅ AUTH CHECK
    const meeting = await authorizeMeetingAccess(code, hostSecret, reqUser);

    if (!meeting) {
      console.error("❌ AUTH FAILED for:", code);
      return res.status(403).json({
        success: false,
        message: "not authorized",
      });
    }

    console.log("✅ AUTH SUCCESS for:", code);

    // ✅ PREPARE UPDATE
    const update = {
      meetingCode: code,
      transcriptText:
        transcriptText ||
        req.body.transcript || // fallback
        metadata?.transcriptText || // fallback
        "",
      fileName: fileName || null,
      metadata: metadata || {},
      updatedAt: new Date(),
    };

    if (createdAt) {
      update.createdAt = new Date(createdAt);
    }

    // ✅ UPSERT TRANSCRIPT
    const doc = await Transcript.findOneAndUpdate(
      { meetingCode: code },
      { $set: update },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    console.log("✅ TRANSCRIPT SAVED:", doc?._id);

    return res.json({
      success: true,
      transcript: doc,
    });

  } catch (err) {
    console.error("❌ createTranscript error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

export const saveTranscript = createTranscript;

/**
 * GET transcript by id or meetingCode
 */
export async function getTranscript(req, res) {
  try {
    const idOrCode = String(req.params.id || "").trim();

    if (!idOrCode) {
      return res.status(400).json({ success: false });
    }

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;

    let doc = null;

    // try by _id
    try {
      doc = await Transcript.findById(idOrCode).lean();
    } catch {}

    if (doc) {
      const meeting = await authorizeMeetingAccess(
        doc.meetingCode,
        hostSecret,
        reqUser
      );

      if (!meeting) {
        return res.status(403).json({ success: false });
      }

      return res.json({ success: true, transcript: doc });
    }

    // try by meetingCode
    const code = idOrCode.toUpperCase();

    const meeting = await authorizeMeetingAccess(
      code,
      hostSecret,
      reqUser
    );

    if (!meeting) {
      return res.status(403).json({ success: false });
    }

    doc = await Transcript.findOne({ meetingCode: code }).lean();

    if (!doc) {
      return res.status(404).json({ success: false });
    }

    return res.json({ success: true, transcript: doc });
  } catch (err) {
    console.error("getTranscript error:", err);
    return res.status(500).json({ success: false });
  }
}

export const getTranscriptByCode = getTranscript;

/**
 * LIST transcripts
 */
export async function listTranscripts(req, res) {
  try {
    const { meeting_code, limit = 50, mine } = req.query;

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;
    const userId = getUserIdFromReq({ user: reqUser });

    const finalLimit = Math.min(parseInt(limit, 10) || 50, 200);

    console.log("🔥 meeting_code:", meeting_code);
    console.log("🔥 userId:", userId);
    console.log("🔥 hostSecret:", hostSecret);

    // =========================================================
    // ✅ CASE 1: meeting_code
    // =========================================================
    if (meeting_code) {
      const code = String(meeting_code).toUpperCase();

      const meeting = await authorizeMeetingAccess(
        code,
        hostSecret,
        reqUser
      );

      if (!meeting) {
        return res.status(403).json({ success: false });
      }

      const docs = await Transcript.find({ meetingCode: code })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      return res.json({ success: true, transcripts: docs });
    }

    // =========================================================
    // ✅ CASE 2: hostSecret (FIXED PRIORITY)
    // =========================================================
    if (hostSecret) {
      const meetings = await findMeetingsByHostSecret(hostSecret);

      if (!meetings || meetings.length === 0) {
        return res.json({ success: true, transcripts: [] });
      }

      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({
        meetingCode: { $in: meetingCodes },
      })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      return res.json({ success: true, transcripts: docs });
    }

    // =========================================================
    // ✅ CASE 3: mine=true
    // =========================================================
    if (String(mine) === "true") {
      if (!userId) {
        return res.status(401).json({ success: false });
      }

      const meetings = await findMeetingsByOwnerId(userId);
      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({
        meetingCode: { $in: meetingCodes },
      })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      return res.json({ success: true, transcripts: docs });
    }

    // =========================================================
    // ✅ CASE 4: user fallback
    // =========================================================
    if (userId) {
      const meetings = await findMeetingsByOwnerId(userId);
      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({
        meetingCode: { $in: meetingCodes },
      })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      return res.json({ success: true, transcripts: docs });
    }

    // =========================================================
    // ❌ NO AUTH
    // =========================================================
    return res.status(403).json({
      success: false,
      message: "Unauthorized",
    });
  } catch (err) {
    console.error("listTranscripts error:", err);
    return res.status(500).json({ success: false });
  }
}