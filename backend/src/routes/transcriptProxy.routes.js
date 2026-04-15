import express from "express";
import multer from "multer";
import FormData from "form-data";
import fetch from "node-fetch";

const router = express.Router();
const upload = multer();

router.post("/proxy", upload.any(), async (req, res) => {
    try {
        const form = new FormData();

        Object.entries(req.body).forEach(([key, value]) => {
            form.append(key, value);
        });

        req.files.forEach((file) => {
            form.append("audio_files", file.buffer, file.originalname);
        });

        const response = await fetch(
            process.env.Ts_SERVICE_URL,
            {
                method: "POST",
                headers: {
                    ...form.getHeaders(),
                    "x-host-secret": req.headers["x-host-secret"] || "",
                    "x-user-token": req.headers["x-user-token"] || "",
                },
                body: form,
            }
        );

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).json({ success: false, error: "Proxy failed" });
    }
});

export default router;