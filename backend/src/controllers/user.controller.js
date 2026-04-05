
import httpStatus from "http-status";
import crypto from "crypto";
import { User } from "../models/user.model.js";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Meeting } from "../models/meeting.model.js";


const sendError = (res, status, message) =>
  res.status(status).json({ success: false, message });

const getUserId = (user) => {
  if (!user) return null;
  return user._id || user.id || user.sub || (typeof user === "string" ? user : null);
};


const logout = async (req, res) => {
  try {
    
    const refreshToken = req.cookies ? req.cookies.refreshToken : null;


    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
    });

    return res.status(httpStatus.OK).json({ success: true, message: "Logged out" });
  } catch (err) {
    console.error("logout error:", err.stack || err);


    try {
      res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Strict",
        path: "/",
      });
    } catch (e) {

    }

    return sendError(res, httpStatus.INTERNAL_SERVER_ERROR, "Failed to logout");
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username?.trim() || !password?.trim()) {
    return sendError(res, httpStatus.BAD_REQUEST, "Username and password are required.");
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return sendError(res, httpStatus.NOT_FOUND, "User not found.");
    }
    console.log("LOGIN SECRET:", process.env.JWT_SECRET);
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return sendError(res, httpStatus.UNAUTHORIZED, "Invalid username or password.");
    }

    const payload = {
  _id: user._id.toString(),
  sub: user._id.toString(),
  username: user.username,
  name: user.name,
};
    const expiresIn = "1h";
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

    res.status(httpStatus.OK).json({
      success: true,
      accessToken: token,
      expiresIn,
      message: "Login successful.",
      user: { _id: user._id, username: user.username, name: user.name },
    });
  } catch (error) {
    console.error("login error:", error.stack || error);
    sendError(res, httpStatus.INTERNAL_SERVER_ERROR, `Something went wrong: ${error.message}`);
  }
};


const register = async (req, res) => {
  const { name, username, password } = req.body;
  if (!name?.trim() || !username?.trim() || !password?.trim()) {
    return sendError(res, httpStatus.BAD_REQUEST, "Name, username, and password are required.");
  }

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return sendError(res, httpStatus.CONFLICT, "User already exists.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, username, password: hashedPassword });

    await newUser.save();
    res.status(httpStatus.CREATED).json({ success: true, message: "User registered successfully." });
  } catch (error) {
    console.error("register error:", error.stack || error);
    sendError(res, httpStatus.INTERNAL_SERVER_ERROR, `Something went wrong: ${error.message}`);
  }
};


const getUserHistory = async (req, res) => {
  try {
    const userId = getUserId(req.user);
const objectUserId = userId ? new mongoose.Types.ObjectId(userId) : null;

    if (!userId) {
      return sendError(res, httpStatus.UNAUTHORIZED, "Unauthorized. Missing user id.");
    }

    const query = {
      $or: [
        { host: objectUserId },
         { ownerId: objectUserId },
        { "participants.meta.userId": String(userId) },
        { "participants.userId": String(userId) },
      ],
    };

    const meetings = await Meeting.find(query)
      .sort({ createdAt: -1 })
      .populate("host", "name username")
      .lean()
      .exec();

    const clientOrigin = process.env.CLIENT_ORIGIN || `http://localhost:${process.env.CLIENT_PORT || 3000}`;

    const withLinks = meetings.map((m) => {
      if (m.meetingCode) m.meetingCode = String(m.meetingCode).toUpperCase();
      if (!m.link && m.meetingCode) {
        m.link = `${clientOrigin}/room/${m.meetingCode}`;
      }

      let hostName = "Unknown";
      if (m.host) {
        if (typeof m.host === "object" && (m.host.name || m.host.username)) {
          hostName = m.host.name || m.host.username;
        } else if (m.host.name) {
          hostName = m.host.name;
        } else if (m.host.userId && m.host.name) {
          hostName = m.host.name;
        }
      }
      m.hostName = hostName;

      m.participants = (m.participants || []).map((p) => {
        const userId = p?.meta?.userId || p?.userId || null;
        const name = p?.name || p?.meta?.name || p?.meta?.display || "Guest";
        return {
          socketId: p?.socketId || null,
          userId,
          name,
          joinedAt: p?.joinedAt || p?.createdAt || null,
          leftAt: p?.leftAt || null,
        };
      });

      return m;
    });

    return res.status(httpStatus.OK).json({ success: true, meetings: withLinks });
  } catch (error) {
    console.error("getUserHistory error:", error.stack || error);
    sendError(res, httpStatus.INTERNAL_SERVER_ERROR, `Something went wrong: ${error.message}`);
  }
};


const addToHistory = async (req, res) => {
  const rawCode = (req.body.meeting_code || req.body.meetingCode || "").toString().trim();
  if (!rawCode) return sendError(res, httpStatus.BAD_REQUEST, "Meeting code is required.");
  const meeting_code = rawCode.toUpperCase();

  try {
    const userId = getUserId(req.user);
const objectUserId = userId ? new mongoose.Types.ObjectId(userId) : null;

    if (!userId) return sendError(res, httpStatus.UNAUTHORIZED, "Unauthorized. Missing user id.");

    const existing = await Meeting.findOne({ meetingCode: meeting_code }).lean().exec();
    if (existing) {
      return res.status(httpStatus.OK).json({ success: true, message: "Meeting already exists.", meeting: existing });
    }

    const link = req.body.link || req.body.url || null;
    const synthSocketId = `init-${String(userId)}-${Date.now()}`;
    const participantEntry = {
      socketId: synthSocketId,
      name: req.user?.name || req.user?.username || "Host",
      meta: { userId: String(userId) },
      joinedAt: new Date(),
    };

    const newMeeting = new Meeting({
  meetingCode: meeting_code,
  link,
  host: new mongoose.Types.ObjectId(userId),
ownerId: new mongoose.Types.ObjectId(userId),

  participants: [participantEntry]
});
    await newMeeting.save();

    res.status(httpStatus.CREATED).json({ success: true, message: "Meeting created and saved to history.", meeting: newMeeting });
  } catch (error) {
    console.error("addToHistory error:", error.stack || error);
    sendError(res, httpStatus.INTERNAL_SERVER_ERROR, `Something went wrong: ${error.message}`);
  }
};


const addParticipant = async (req, res) => {
  try {
    const userId = getUserId(req.user);
const objectUserId = userId ? new mongoose.Types.ObjectId(userId) : null;
    if (!userId) return sendError(res, httpStatus.UNAUTHORIZED, "Unauthorized. Missing user id.");

    const codeParam = (req.params?.code || req.body?.meeting_code || req.body?.meetingCode || "").toString().trim();
    if (!codeParam) return sendError(res, httpStatus.BAD_REQUEST, "Meeting code is required (param or body).");
    const meetingCode = codeParam.toUpperCase();

    const meeting = await Meeting.findOne({ meetingCode });
    if (!meeting) return sendError(res, httpStatus.NOT_FOUND, "Meeting not found.");

    const participantName = (req.body.name || req.user?.name || req.user?.username || "Guest").toString();

    const existingParticipant = meeting.participants.find((p) => {
      if (!p) return false;
      const metaUserId = p.meta?.userId ? String(p.meta.userId) : null;
      const directUserId = p.userId ? String(p.userId) : null;
      return metaUserId === String(userId) || directUserId === String(userId);
    });

    if (existingParticipant) {
      existingParticipant.joinedAt = new Date();
      existingParticipant.leftAt = null;
      existingParticipant.name = participantName;
      await meeting.save();
    } else {
      const synthSocketId = `user-${String(userId)}-${Date.now()}`;
      meeting.participants.push({
        socketId: synthSocketId,
        name: participantName,
        meta: { userId: String(userId) },
        joinedAt: new Date(),
      });
      await meeting.save();
    }

    if (!meeting.host) {
  meeting.host = new mongoose.Types.ObjectId(userId);
}

if (!meeting.ownerId) {
  meeting.ownerId = new mongoose.Types.ObjectId(userId);
}

await meeting.save();

    res.status(httpStatus.OK).json({ success: true, meeting });
  } catch (error) {
    console.error("addParticipant error:", error.stack || error);
    sendError(res, httpStatus.INTERNAL_SERVER_ERROR, `Something went wrong: ${error.message}`);
  }
};


const getMeetings = async (req, res) => {
  try {
    const userId = getUserId(req.user);
const objectUserId = userId ? new mongoose.Types.ObjectId(userId) : null;
    const mineOnly = String(req.query?.mine || "false").toLowerCase() === "true";

    let filter = {};
    if (userId && mineOnly) {
      filter = {
        $or: [
      { ownerId: objectUserId },
      { host: objectUserId },
      { "participants.meta.userId": String(userId) },
    ],
      };
    } else if (userId) {
  filter = {
    $or: [
      { host: objectUserId },
      { ownerId: objectUserId },
      { "participants.meta.userId": String(userId) },
      { active: true }
    ],
  };
} else {
      filter = { active: true };
    }

    const meetings = await Meeting.find(filter)
      .sort({ lastActivityAt: -1, createdAt: -1 })
      .limit(200)
      .populate({ path: "host", model: "UserDb", select: "name username" })
      .lean()
      .exec();

    return res.status(httpStatus.OK).json({ meetings });
  } catch (err) {
    console.error("getMeetings error:", err.stack || err);
    return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ success: false, message: "Failed to fetch meetings", detail: err.message });
  }
};


const upsertMeeting = async (req, res) => {
  try {
    const body = req.body || {};

    const meetingCodeRaw =
      body.meetingCode || body.meeting_code || body.code || body.meeting;

    if (!meetingCodeRaw) {
      return res.status(400).json({
        success: false,
        message: "meetingCode is required",
      });
    }

    const meetingCode = String(meetingCodeRaw).toUpperCase();

    const payload = {};

    const userId = getUserId(req.user);
    const objectUserId = userId
      ? new mongoose.Types.ObjectId(userId)
      : null;

    if (objectUserId) {
      payload.host = objectUserId;
      payload.ownerId = objectUserId;
    }

    const rawSecret = crypto.randomBytes(32).toString("hex");

    const hostSecretHash = crypto
      .createHash("sha256")
      .update(rawSecret)
      .digest("hex");


    payload.hostSecretHash = hostSecretHash;


    payload.hostInfo = {
      name: body.hostName || body.host_name || null,
      userId: userId || null,
    };

    const saved = await Meeting.upsertByMeetingCode(
      meetingCode,
      payload
    );


    return res.json({
      success: true,
      meeting: saved,
      hostSecret: rawSecret,
    });

  } catch (err) {
    console.error("upsertMeeting error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to upsert meeting",
    });
  }
};


export {
  login,
  register,
  getUserHistory,
  addToHistory,
  addParticipant,
  getMeetings,
  upsertMeeting,
  logout,
}