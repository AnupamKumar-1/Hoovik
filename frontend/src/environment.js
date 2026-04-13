export const IS_PROD = true;

export const SERVER = IS_PROD
  ? "https://skymeetai-production.up.railway.app"
  : "http://localhost:8000";

export const TRANSCRIPTS_ENABLED = !IS_PROD;

export default SERVER;