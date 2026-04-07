export const IS_PROD = true;

export const SERVER = IS_PROD
  ? "https://skymeetai-backend.onrender.com"
  : "http://192.168.1.15:8000";

export const TRANSCRIPTS_ENABLED = !IS_PROD;

export default SERVER;
