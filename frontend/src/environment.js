export const IS_PROD = true;

export const SERVER = IS_PROD
  ? "https://skymeetai-production.up.railway.app"
  : "http://localhost:8000";

export const TRANSCRIPTS_ENABLED = true;

export const EMOTIONS_ENABLED = true;

export default SERVER;