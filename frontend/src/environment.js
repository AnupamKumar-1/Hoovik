export const IS_PROD = false;

export const SERVER = IS_PROD
  ? "http://localhost:8000"
  : "http://localhost:8000";

export const TRANSCRIPTS_ENABLED = !IS_PROD;

export default SERVER;
