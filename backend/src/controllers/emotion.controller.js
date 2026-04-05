
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import os from "os";

const EMOTION_SERVICE_URL =
  process.env.EMOTION_SERVICE_URL || "http://localhost:5002/analyze";


function buildForm(meetingId, participantId, fileOrBuffer, type = "audio", opts = {}) {
  const form = new FormData();
  form.append("meeting_id", meetingId);
  form.append("participant_id", participantId);
  form.append("type", type);

  const mime = opts.mime || "";
  let filename = opts.filename || "";

  if (Buffer.isBuffer(fileOrBuffer)) {
    if (!filename) {
      const ext = type === "audio" ? "webm" : "mp4";
      filename = `${participantId}.${ext}`;
    }
    const opt = {};
    if (mime) opt.contentType = mime;
    opt.filename = filename;
    form.append("file", fileOrBuffer, opt);
  } else if (typeof fileOrBuffer === "string") {
    const resolved = fileOrBuffer;
    const base = path.basename(resolved);
    filename = filename || base;

    if (mime) {
      form.append("file", fs.createReadStream(resolved), {
        filename,
        contentType: mime,
      });
    } else {
      form.append("file", fs.createReadStream(resolved), { filename });
    }
  } else if (fileOrBuffer && typeof fileOrBuffer.pipe === "function") {
    if (!filename) {
      const ext = type === "audio" ? "webm" : "mp4";
      filename = `${participantId}.${ext}`;
    }
    if (mime) {
      form.append("file", fileOrBuffer, { filename, contentType: mime });
    } else {
      form.append("file", fileOrBuffer, { filename });
    }
  } else {
    throw new Error("fileOrBuffer must be a Buffer, file path string, or readable stream");
  }

  return form;
}

function getFormLength(form) {
  return new Promise((resolve, reject) => {
    form.getLength((err, length) => {
      if (err) return reject(err);
      resolve(length);
    });
  });
}

async function postForm(form, timeoutMs = 120000) {
  const headers = form.getHeaders();

  try {
    const length = await getFormLength(form);
    if (typeof length === "number") {
      headers["Content-Length"] = length;
    }
  } catch (lenErr) {
    console.warn("[EmotionService] could not compute form length:", lenErr?.message || lenErr);
  }

  return axios.post(EMOTION_SERVICE_URL, form, {
    headers,
    timeout: timeoutMs,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}


export async function sendToEmotionService(
  meetingId,
  participantId,
  fileOrBuffer,
  type = "audio",
  opts = {}
) {
  if (!meetingId || !participantId || !fileOrBuffer) {
    throw new Error("meetingId, participantId and fileOrBuffer are required");
  }

  if (type === "frame") {
    throw new Error("Frame type is no longer supported via HTTP. Use socket instead.");
  }

  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 120000;

  let cleanupTemp = null;

  try {
    const isStream =
      fileOrBuffer &&
      typeof fileOrBuffer === "object" &&
      typeof fileOrBuffer.pipe === "function";

    if (isStream) {
      if (fileOrBuffer.path && typeof fileOrBuffer.path === "string") {
        fileOrBuffer = String(fileOrBuffer.path);
      } else {
        const tmpName = path.join(
          os.tmpdir(),
          `emotion_upload_${Date.now()}_${Math.random().toString(36).slice(2)}`
        );

        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmpName);
          fileOrBuffer.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
        });

        fileOrBuffer = tmpName;
        cleanupTemp = tmpName;
      }
    }

    let form = buildForm(meetingId, participantId, fileOrBuffer, type, opts);

    console.log(`[EmotionService] Posting ${type} → ${EMOTION_SERVICE_URL}`);

    try {
      const res = await postForm(form, timeoutMs);
      return res.data;
    } catch (err) {
      const transient =
        !err.response &&
        ["ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ECONNRESET"].includes(err.code);

      if (transient) {
        console.log("[EmotionService] retrying...");
        form = buildForm(meetingId, participantId, fileOrBuffer, type, opts);
        const retryRes = await postForm(form, timeoutMs);
        return retryRes.data;
      }

      throw err;
    }
  } finally {
    if (cleanupTemp) {
      try {
        fs.unlinkSync(cleanupTemp);
      } catch { }
    }
  }
}


export async function uploadEmotionFileHandler(req, res) {
  try {
    const meetingId = req.body?.meeting_id || req.body?.meetingId;
    const participantId = req.body?.participant_id || req.body?.participantId;
    const type = req.body?.type || "audio"; 
    const file = req.file;

    if (!meetingId || !participantId || !file) {
      return res.status(400).json({
        ok: false,
        error: "meeting_id, participant_id and file are required",
      });
    }

    if (type === "frame") {
      return res.status(400).json({
        ok: false,
        error: "Frame upload not allowed via HTTP. Use socket.",
      });
    }

    const emotionResult = await sendToEmotionService(
      meetingId,
      participantId,
      file.path,
      type,
      {
        mime: file.mimetype,
        filename: file.originalname,
      }
    );

    return res.json({ ok: true, result: emotionResult });
  } catch (err) {
    console.error("[Emotion] error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (req.file?.path) {
      fs.unlink(req.file.path, () => { });
    }
  }
}