import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

export async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function hashBuffer(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

export function sha256Hex(input) {
    return crypto.createHash("sha256").update(String(input)).digest("hex");
}

export async function getFileSize(filePath) {
    try {
        const s = await fs.promises.stat(filePath);
        return s.size;
    } catch {
        return null;
    }
}

export async function safeUnlink(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (e) {
        console.warn(JSON.stringify({
            level: "warn", service: "file",
            msg: "unlink failed", filePath,

            err: e.message, ts: new Date().toISOString() }));
    }
}

export function toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw;

    if (raw instanceof ArrayBuffer) return Buffer.from(raw);

    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

    if (raw?.data && Array.isArray(raw.data)) return Buffer.from(raw.data);

    throw new Error("unsupported buffer type");
}

export async function writeTempFile(stream) {

    const tmpName = path.join(
        os.tmpdir(),
        `emotion_upload_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`
    );

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpName);
        stream.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
    });
    return tmpName;
    
}