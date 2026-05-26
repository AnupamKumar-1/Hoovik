import httpStatus from "http-status";
import { makeLogger } from "../utils/redis.utils.js";
import {
  loginService,
  registerService,
  getUserHistoryService,
  addToHistoryService,
  addParticipantService,
  getMeetingsService,
  upsertMeetingService,
  getMeService,
  ensureMeetingIndexes,
  logoutService,
  refreshTokenService,
} from "../services/user.service.js";

const log = makeLogger("user");

const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Strict",
  path: "/",
};

const logout = async (req, res) => {
  const { status, body } = await logoutService(req);
  res.clearCookie("refreshToken", cookieOpts);
  return res.status(status).json(body);
};

const login = async (req, res) => {
  const { status, body, cookies } = await loginService(req);
  if (cookies?.refreshToken) {
    res.cookie("refreshToken", cookies.refreshToken.value, {
      ...cookieOpts,
      maxAge: cookies.refreshToken.ttlSec * 1000,
    });
  }
  return res.status(status).json(body);
};

const refreshToken = async (req, res) => {
  const { status, body, cookies } = await refreshTokenService(req);
  if (cookies?.refreshToken) {
    res.cookie("refreshToken", cookies.refreshToken.value, {
      ...cookieOpts,
      maxAge: cookies.refreshToken.ttlSec * 1000,
    });
  }
  return res.status(status).json(body);
};

const register = async (req, res) => {
  const { status, body } = await registerService(req);
  return res.status(status).json(body);
};

const getUserHistory = async (req, res) => {
  const { status, body } = await getUserHistoryService(req);
  return res.status(status).json(body);
};

const addToHistory = async (req, res) => {
  const { status, body } = await addToHistoryService(req);
  return res.status(status).json(body);
};

const addParticipant = async (req, res) => {
  const { status, body } = await addParticipantService(req);
  return res.status(status).json(body);
};

const getMeetings = async (req, res) => {
  const { status, body } = await getMeetingsService(req);
  return res.status(status).json(body);
};

const upsertMeeting = async (req, res) => {
  const { status, body } = await upsertMeetingService(req);
  return res.status(status).json(body);
};

const getMe = async (req, res) => {
  const { status, body } = await getMeService(req);
  return res.status(status).json(body);
};

export {
  login,
  register,
  refreshToken,
  getUserHistory,
  addToHistory,
  addParticipant,
  getMeetings,
  upsertMeeting,
  logout,
  getMe,
  ensureMeetingIndexes,
};