import { TRANSCRIPTS_ENABLED, EMOTIONS_ENABLED } from "../environment";

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

export const API_BASE =
  process.env.REACT_APP_API_URL ||
  "http://localhost:8000/api/v1";

export const ICE_CONFIG = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302"],
    },
    {
      urls: [
        "turn:in.relay.metered.ca:3478?transport=udp",
        "turn:in.relay.metered.ca:80",
        "turn:in.relay.metered.ca:443",
        "turn:in.relay.metered.ca:443?transport=tcp",
        "turns:in.relay.metered.ca:443"
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export const EMO_CONFIG = {
  captureIntervalMs: 3000,
};

export { EMOTIONS_ENABLED };