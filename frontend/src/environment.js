const IS_PROD = process.env.NODE_ENV === "production";

const SERVER = IS_PROD
  ? process.env.REACT_APP_SERVER_URL
  : "http://localhost:8000";

export const TRANSCRIPTS_ENABLED = true;
export const EMOTIONS_ENABLED = true;

export default SERVER;