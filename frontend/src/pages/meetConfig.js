import { TRANSCRIPTS_ENABLED, IS_PROD } from "../environment";

export const SOCKET_SERVER_URL =
  process.env.REACT_APP_SIGNALING_URL || "http://localhost:8000";

export const TRANSCRIPT_ENDPOINT = (() => {
  if (!TRANSCRIPTS_ENABLED) return null;

  const env =
    process.env.REACT_APP_TRANSCRIPT_URL ||
    process.env.REACT_APP_AI_URL;

  if (!env) return "http://localhost:5001/process_meeting";

  const trimmed = env.replace(/\/+$/, "");
  return trimmed.endsWith("/process_meeting")
    ? trimmed
    : `${trimmed}/process_meeting`;
})();

export const EMOTIONS_ENABLED =
  typeof IS_PROD !== "undefined" ? !IS_PROD : true;



export const API_BASE =
  process.env.REACT_APP_API_URL ||
  "http://localhost:8000/api/v1";

export const ICE_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export const EMO_CONFIG = {
  captureIntervalMs: 3000,
};