import crypto from "crypto";
import Transcript from "../models/transcript.model.js";
import { Meeting } from "../models/meeting.model.js";

function getHostSecretFromReq(req) {
  return (
    req.headers["x-host-secret"] ||
    req.body?.hostSecret ||
    req.query?.hostSecret ||
    null
  );
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function getUserIdFromReq(req) {
  if (!req?.user) return null;
  if (req.user.id) return String(req.user.id);
  if (req.user._id) return String(req.user._id);
  if (req.user.sub) return String(req.user.sub);
  return null;
}

async function verifyHostSecretForMeeting(meetingCode, providedSecret) {
  if (!meetingCode || !providedSecret) return null;

  const providedHash = sha256Hex(providedSecret);

  const meeting = await Meeting.findOne({
    meetingCode: String(meetingCode).toUpperCase(),
    hostSecretHash: providedHash,
  }).lean();

  return meeting || null;
}

async function findMeetingsByHostSecret(providedSecret) {
  if (!providedSecret) return [];

  const providedHash = sha256Hex(providedSecret);

  return await Meeting.find({ hostSecretHash: providedHash }).lean();
}

async function findMeetingsByOwnerId(ownerId) {
  return await Meeting.find({
    $or: [{ ownerId }, { host: ownerId }],
  }).lean();
}

async function authorizeMeetingAccess(meetingCode, providedSecret, reqUser) {
  if (!meetingCode) return null;

  const code = String(meetingCode).toUpperCase();

  if (providedSecret) {
    const meeting = await verifyHostSecretForMeeting(code, providedSecret);
    if (meeting) return meeting;
  }

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

export async function createTranscript(req, res) {
  try {
    const meetingCodeInput =
      req.body.meetingCode ||
      req.body.meeting_code ||
      req.body.code;

    const { transcriptText, fileName, createdAt, metadata } = req.body;

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;

    if (!meetingCodeInput) {
      console.error("createTranscript: meetingCode missing");
      return res.status(400).json({
        success: false,
        message: "meetingCode is required",
      });
    }

    const code = String(meetingCodeInput).toUpperCase();

    const meeting = await authorizeMeetingAccess(code, hostSecret, reqUser);

    if (!meeting) {
      console.warn(`createTranscript: auth failed for meeting ${code}`);
      return res.status(403).json({
        success: false,
        message: "not authorized",
      });
    }

    const update = {
      meetingCode: code,
      transcriptText:
        transcriptText ||
        req.body.transcript ||
        metadata?.transcriptText ||
        "",
      fileName: fileName || null,
      metadata: metadata || {},
      updatedAt: new Date(),
    };

    if (createdAt) {
      update.createdAt = new Date(createdAt);
    }

    const doc = await Transcript.findOneAndUpdate(
      { meetingCode: code },
      { $set: update },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    console.info(`createTranscript: saved transcript for meeting ${code}`);

    return res.json({
      success: true,
      transcript: doc,
    });

  } catch (err) {
    console.error("createTranscript: server error", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

export const saveTranscript = createTranscript;

export async function getTranscript(req, res) {
  try {
    const idOrCode = String(req.params.id || "").trim();

    if (!idOrCode) {
      return res.status(400).json({ success: false, message: "id or meetingCode required" });
    }

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;

    let doc = null;

    try {
      doc = await Transcript.findById(idOrCode).lean();
    } catch { }

    if (doc) {
      const meeting = await authorizeMeetingAccess(
        doc.meetingCode,
        hostSecret,
        reqUser
      );

      if (!meeting) {
        console.warn(`getTranscript: auth failed for transcript ${idOrCode}`);
        return res.status(403).json({ success: false });
      }

      return res.json({ success: true, transcript: doc });
    }

    const code = idOrCode.toUpperCase();

    const meeting = await authorizeMeetingAccess(code, hostSecret, reqUser);

    if (!meeting) {
      console.warn(`getTranscript: auth failed for meeting ${code}`);
      return res.status(403).json({ success: false });
    }

    doc = await Transcript.findOne({ meetingCode: code }).lean();

    if (!doc) {
      return res.status(404).json({ success: false, message: "Transcript not found" });
    }

    return res.json({ success: true, transcript: doc });

  } catch (err) {
    console.error("getTranscript: server error", err.message);
    return res.status(500).json({ success: false });
  }
}

export const getTranscriptByCode = getTranscript;

export async function listTranscripts(req, res) {
  try {
    const { meeting_code, limit = 50, mine } = req.query;

    const hostSecret = getHostSecretFromReq(req);
    const reqUser = req.user;
    const userId = getUserIdFromReq({ user: reqUser });

    const finalLimit = Math.min(parseInt(limit, 10) || 50, 200);

    if (meeting_code) {
      const code = String(meeting_code).toUpperCase();

      const meeting = await authorizeMeetingAccess(code, hostSecret, reqUser);

      if (!meeting) {
        console.warn(`listTranscripts: auth failed for meeting ${code}`);
        return res.status(403).json({ success: false });
      }

      const docs = await Transcript.find({ meetingCode: code })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      return res.json({ success: true, transcripts: docs });
    }

    if (hostSecret) {
      const meetings = await findMeetingsByHostSecret(hostSecret);

      if (!meetings || meetings.length === 0) {
        return res.json({ success: true, transcripts: [] });
      }

      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({ meetingCode: { $in: meetingCodes } })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      console.info(`listTranscripts: returned ${docs.length} transcripts via hostSecret`);

      return res.json({ success: true, transcripts: docs });
    }

    if (String(mine) === "true") {
      if (!userId) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }

      const meetings = await findMeetingsByOwnerId(userId);
      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({ meetingCode: { $in: meetingCodes } })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      console.info(`listTranscripts: returned ${docs.length} transcripts for user ${userId}`);

      return res.json({ success: true, transcripts: docs });
    }

    if (userId) {
      const meetings = await findMeetingsByOwnerId(userId);
      const meetingCodes = meetings.map((m) => m.meetingCode);

      const docs = await Transcript.find({ meetingCode: { $in: meetingCodes } })
        .sort({ createdAt: -1 })
        .limit(finalLimit)
        .lean();

      console.info(`listTranscripts: returned ${docs.length} transcripts for user ${userId}`);

      return res.json({ success: true, transcripts: docs });
    }

    console.warn("listTranscripts: request with no valid auth");
    return res.status(403).json({
      success: false,
      message: "Unauthorized",
    });

  } catch (err) {
    console.error("listTranscripts: server error", err.message);
    return res.status(500).json({ success: false });
  }
}