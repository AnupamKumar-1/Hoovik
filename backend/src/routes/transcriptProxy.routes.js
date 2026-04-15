import express from "express";
import multer from "multer";
import FormData from "form-data";

const router = express.Router();
const upload = multer();

router.post(["/", "/process_meeting"], upload.any(), async (req, res) => {
    try {
        const form = new FormData();

        Object.entries(req.body || {}).forEach(([key, value]) => {
            form.append(key, value);
        });

        (req.files || []).forEach((file) => {
            form.append("audio_files", file.buffer, file.originalname);
        });

        const response = await fetch(process.env.Ts_SERVICE_URL, {
            method: "POST",
            headers: {
                "x-host-secret": req.headers["x-host-secret"] || "",
                "x-user-token": req.headers["x-user-token"] || "",
            },
            body: form,
        });

        const text = await response.text();

        try {
            const data = JSON.parse(text);
            res.status(response.status).json(data);
        } catch {
            res.status(response.status).send(text);
        }
    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).json({ success: false, error: "Proxy failed" });
    }
});

export default router;