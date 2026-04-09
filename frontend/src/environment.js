export const IS_PROD = true;

export const SERVER = IS_PROD
  ? "https://skymeetai-production.up.railway.app"
  : "http://192.168.1.15:8000";

export const TRANSCRIPTS_ENABLED = true;

export default SERVER;
