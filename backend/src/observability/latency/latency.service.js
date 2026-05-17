import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// ES modules don't have __dirname, so we make it ourselves
const currentFile = fileURLToPath(import.meta.url)
const currentFolder = path.dirname(currentFile)

// Use PORT from env, otherwise call it "dev" for local testing
const port = process.env.PORT || "dev"

// Put all logs in a /logs folder 3 levels up
const logsFolder = path.resolve(currentFolder, "../../../logs")
fs.mkdirSync(logsFolder, { recursive: true })

// Each port gets its own log file: latency-3000.log, latency-dev.log, etc
const logFile = path.join(logsFolder, `latency-${port}.log`)
const logStream = fs.createWriteStream(logFile, { flags: "a" })

// Mark when the app started
logStream.write(`\n[PROCESS START] ${new Date().toISOString()}\n`)

// Pretty format: [14:22:03]  API_CALL    142.7 ms  status: 200
function formatLog({ label, latencyMs, timestamp, ...details }) {
    const time = new Date(timestamp).toTimeString().slice(0, 8)
    
    const detailsText = Object.entries(details)
        .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
        .join("  ·  ")
    
    const latencyText = latencyMs != null 
        ? `${latencyMs < 1 ? latencyMs.toFixed(3) : latencyMs.toFixed(1)} ms`.padStart(10)
        : " ".repeat(10)
    
    return `[${time}]  ${label.padEnd(20)}  ${latencyText}  ${detailsText}\n`
}

// Call this before doing something slow
export function startTimer() {
    return process.hrtime.bigint()
}

// Call this after. It logs how long it took
export function endTimer(label, startTime, extraData = {}) {
    const elapsedNs = process.hrtime.bigint() - startTime
    const latencyMs = Number(elapsedNs) / 1_000_000
    
    const logLine = formatLog({
        label,
        latencyMs: parseFloat(latencyMs.toFixed(3)),
        timestamp: new Date().toISOString(),
        ...extraData
    })
    
    process.stdout.write(logLine)  // show in console
    logStream.write(logLine)       // save to file
    
    return latencyMs
}

// For logging events without timing
export function logEvent(label, extraData = {}) {
    const logLine = formatLog({
        label,
        latencyMs: null,
        timestamp: new Date().toISOString(),
        ...extraData
    })
    
    process.stdout.write(logLine)
    logStream.write(logLine)
}

// Make sure we close the file properly when the app stops
process.on("exit", () => logStream.end())
process.on("SIGINT", () => logStream.end(() => process.exit(0)))
process.on("SIGTERM", () => logStream.end(() => process.exit(0)))