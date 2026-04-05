
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  uploadEmotionFileHandler,
  sendToEmotionService,
} from "../controllers/emotion.controller.js";

const router = express.Router();

function ensureAuth(req, res, next) {

  return next();
}


const TMP_UPLOAD_DIR = process.env.EMOTION_UPLOAD_TMP_DIR || "/tmp/emotion_uploads";

if (!fs.existsSync(TMP_UPLOAD_DIR)) {
  try {
    fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.warn(`[emotion.routes] could not create tmp dir ${TMP_UPLOAD_DIR}:`, err.message);
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TMP_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const safeBase = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${safeBase}${ext}`);
  },
});


function fileFilter(req, file, cb) {
  const mime = file.mimetype || "";
  if (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/")
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only image/audio/video files are allowed"));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {

    fileSize: parseInt(process.env.EMOTION_MAX_FILE_BYTES || String(6 * 1024 * 1024), 10),
  },
});


router.post(
  "/upload",
  ensureAuth,
  upload.single("file"),
  async (req, res, next) => {
    try {

      return await uploadEmotionFileHandler(req, res);
    } catch (err) {

      console.error("[emotion.routes] /upload handler error:", err);
      return res.status(500).json({ ok: false, error: err.message || "internal error" });
    }
  }
);

router.get("/status", (req, res) => {
  res.json({
    ok: true,
    msg: "emotion routes healthy",
    tmpUploadDir: TMP_UPLOAD_DIR,
  });
});


router.post("/proxy-test", ensureAuth, upload.single("file"), async (req, res) => {
  try {
    const meetingId = req.body?.meeting_id || req.body?.meetingId;
    const participantId = req.body?.participant_id || req.body?.participantId;
    const type = req.body?.type || "frame";
    if (!meetingId || !participantId || !req.file) {
      return res.status(400).json({ ok: false, error: "meeting_id, participant_id and file required" });
    }


    const result = await sendToEmotionService(meetingId, participantId, req.file.path, type);


    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      
    }

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("[emotion.routes] /proxy-test error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal error" });
  }
});

export default router;
