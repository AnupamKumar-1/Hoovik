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

const COOKIE_BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Strict",
  path: "/",
};

function setRefreshCookie(res, cookiePayload) {
  if (cookiePayload?.refreshToken) {
    res.cookie("refreshToken", cookiePayload.refreshToken.value, {
      ...COOKIE_BASE,
      maxAge: cookiePayload.refreshToken.ttlSec * 1000,
    });
  }
}

function clearRefreshCookie(res) {
  res.clearCookie("refreshToken", COOKIE_BASE);
}

const login = async (req, res) => {
  const { status, body, cookies } = await loginService(req);
  setRefreshCookie(res, cookies);
  return res.status(status).json(body);
};

const register = async (req, res) => {
  const { status, body } = await registerService(req);
  return res.status(status).json(body);
};

const refreshToken = async (req, res) => {
  const { status, body, cookies } = await refreshTokenService(req);
  setRefreshCookie(res, cookies);
  return res.status(status).json(body);
};

const logout = async (req, res) => {
  const { status, body } = await logoutService(req);
  clearRefreshCookie(res);
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