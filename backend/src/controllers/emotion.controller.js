import { sendToEmotionService } from "../services/emotion.service.js";
import { safeUnlink } from "../utils/helpers.utils.js";
import { makeLogger } from "../utils/redis.utils.js";
import fs from "fs";

const cfg = JSON.parse(
  fs.readFileSync(new URL("../config/config.json", import.meta.url))
);
const DEFAULT_TYPE = cfg.emotion?.defaultType ?? "audio";
const EMOTION_MAX_FILE_BYTES = parseInt(process.env.EMOTION_MAX_FILE_BYTES || `${200 * 1024 * 1024}`, 10);
const ALLOWED_TYPES = ["audio", "video"];

const log = makeLogger("emotion");

export { sendToEmotionService };

export async function uploadEmotionFileHandler(req, res) {
  try {
    const meetingId = req.body?.meeting_id || req.body?.meetingId;

    const participantId = req.body?.participant_id || req.body?.participantId;

    const type = req.body?.type || DEFAULT_TYPE;

    const file = req.file;

    if (!meetingId || !participantId || !file) {

      return res.status(400).json({
        ok: false,
        error: "meeting_id, participant_id and file are required"
      });
    }

    if (type === "frame") {

      return res.status(400).json({
        ok: false,
        error: "Frame upload not allowed via HTTP. Use socket."
      });
    }

    if (!ALLOWED_TYPES.includes(type)) {

      return res.status(400).json({
        ok: false,
        error: `Invalid type. Must be one of: ${ALLOWED_TYPES.join(", ")}`

      });

    }

    if (file.size > EMOTION_MAX_FILE_BYTES) {

      return res.status(413).json({
        ok: false,
        error: "File too large" });
    }

    const result = await sendToEmotionService(meetingId, participantId, file.path, type, {

      mime: file.mimetype,
      filename: file.originalname,
    });

    if (result === null) {

      return res.status(202).json({
        ok: true,
        result: null,
        reason: "skipped"
      });
    }

    if (result?.error === true) {
      return res.status(503).json({

        ok: false,
        error: result.reason || "service_failure"
      });
    }

    return res.json({ ok: true, result });

  } catch (err) {

    log.error("handler error",
      {
        err: err.message
      });

    return res.status(500).json({
      ok: false,
      error: "Emotion service unavailable" });
  } finally {

    if (req.file?.path) await safeUnlink(req.file.path);

  }
}