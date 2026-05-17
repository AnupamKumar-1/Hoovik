import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../../logs");
const LOG_FILE = path.join(LOG_DIR, `latency-${process.env.PORT}.log`);

function initLogFile() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const startMarker = `\n[PROCESS START] ${new Date().toISOString()}\n`;
    fs.appendFileSync(LOG_FILE, startMarker);
}

initLogFile();

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function formatEntry(entry) {
    const { label, latencyMs, ts, ...meta } = entry;
    const time = new Date(ts).toTimeString().slice(0, 8);

    const metaStr = Object.entries(meta)
        .map(([k, v]) => `${k}: ${v}`)
        .join("  ·  ");

    let latencyStr = "";

    if (latencyMs !== null && latencyMs !== undefined) {
        const ms =
            latencyMs < 1
                ? latencyMs.toFixed(3)
                : latencyMs.toFixed(1);

        latencyStr = (ms + " ms").padStart(10);
    } else {
        latencyStr = "".padStart(10);
    }

    return `[${time}]  ${label.padEnd(20)}  ${latencyStr}  ${metaStr}\n`;
}

export function startTimer() {
    return process.hrtime.bigint();
}

export function endTimer(label, start, meta = {}) {
    const elapsedNs = process.hrtime.bigint() - start;
    const latencyMs = Number(elapsedNs) / 1_000_000;

    const entry = {
        label,
        latencyMs: parseFloat(latencyMs.toFixed(3)),
        ...meta,
        ts: new Date().toISOString(),
    };

    const line = formatEntry(entry);

    console.log(line);
    logStream.write(line);

    return latencyMs;
}

export function logEvent(label, meta = {}) {
    const entry = {
        label,
        latencyMs: null,
        ...meta,
        ts: new Date().toISOString(),
    };

    const line = formatEntry(entry);

    console.log(line);
    logStream.write(line);
}
