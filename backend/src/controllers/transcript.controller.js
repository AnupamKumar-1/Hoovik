import { makeLogger } from "../utils/redis.utils.js";
import {
  createTranscriptService,
  getTranscriptService,
  listTranscriptsService,
} from "../services/transcript.service.js";

const log = makeLogger("transcript");

export async function createTranscript(req, res) {
  const requestStart = Date.now();
  try {
    const { status, body } = await createTranscriptService(req);
    log.info("createTranscript complete", { totalMs: Date.now() - requestStart });
    return res.status(status).json(body);
  } catch (err) {
    log.error("createTranscript error", { err: err.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

export const saveTranscript = createTranscript;

export async function getTranscript(req, res) {
  const requestStart = Date.now();
  try {
    const { status, body } = await getTranscriptService(req);
    log.info("getTranscript complete", { totalMs: Date.now() - requestStart });
    return res.status(status).json(body);
  } catch (err) {
    log.error("getTranscript error", { err: err.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

export const getTranscriptByCode = getTranscript;

export async function listTranscripts(req, res) {
  const requestStart = Date.now();
  try {
    const { status, body } = await listTranscriptsService(req);
    log.info("listTranscripts complete", { totalMs: Date.now() - requestStart });
    return res.status(status).json(body);
  } catch (err) {
    log.error("listTranscripts error", { err: err.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}