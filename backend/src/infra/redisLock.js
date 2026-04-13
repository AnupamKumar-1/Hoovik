
import crypto from "crypto";
import redisClient from "./redis.js";

const LOCK_TTL_MS = parseInt(process.env.REDIS_LOCK_TTL_MS || "10000", 10);
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_WAIT_MS = parseInt(process.env.REDIS_LOCK_MAX_WAIT_MS || "8000", 10);

function lockKey(code) {
    return `lock:room:${code}`;
}

async function acquireLock(code, token) {
    const result = await redisClient.set(lockKey(code), token, {
        NX: true,
        PX: LOCK_TTL_MS,
    });
    return result === "OK";
}

async function releaseLock(code, token) {
    const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1]
        then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `;
    await redisClient.eval(script, {
        keys: [lockKey(code)],
        arguments: [token],
    });
}

export async function withRoomLock(code, fn) {
    const token = crypto.randomUUID();
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;

    while (true) {
        const acquired = await acquireLock(code, token);
        if (acquired) break;
        if (Date.now() >= deadline) {
            throw new Error(`[redisLock] timeout acquiring lock for room: ${code}`);
        }
        const jitter = Math.random() * 50;
        await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS + jitter));
    }

    try {
        return await fn();
    } finally {
        await releaseLock(code, token);
    }
}