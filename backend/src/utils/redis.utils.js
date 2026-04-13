


import { redisClient } from "../infra/redis.js";

export function makeLogger(service) {
    return {
        info: (msg, meta = {}) => console.log(JSON.stringify({
            level: "info",
            service,
            msg, ...meta,
            ts: new Date().toISOString()
        })),
        warn: (msg, meta = {}) => console.warn(JSON.stringify({
            level: "warn",
            service,
            msg, ...meta,
            ts: new Date().toISOString()
        })),
        error: (msg, meta = {}) => console.error(JSON.stringify({
            level: "error",
            service,
            msg,
            ...meta,
            ts: new Date().toISOString()
        })),
    };
}

const log = makeLogger("redis");

export async function safeRedisGet(key) {
    try {
        return await redisClient.get(key);
    } catch (e) {
        log.warn("redis get failed", { key, err: e.message });
        return null;
    }
}
export async function safeRedisSet(key, value, opts = {}) {
    try { return await redisClient.set(key, value, opts);

    } catch (e) {
        log.warn("redis set failed",
            {
                key,
                err: e.message
            });
            return null;
    }
}
export async function safeRedisDel(key) {
    try { return await redisClient.del(key);

    }
    catch (e) {
        log.warn("redis del failed",
            {
                key, err: e.message
            });
            return null;
        }
}
export async function safeRedisIncr(key) {

    try { return await redisClient.incr(key);

    } catch (e) {
        log.warn("redis incr failed", {
            key, err: e.message
        }); return null;
    }
}
export async function safeRedisExpire(key, ttl) {
    try { return await redisClient.expire(key, ttl);

    } catch (e) {
        log.warn("redis expire failed", {
            key, err: e.message
        });
        return null;
    }
}

export async function batchDel(...keys) {
    try {
        if (!keys.length) return;

        const multi = redisClient.multi();
        keys.forEach((k) => multi.del(k));
        await multi.exec();
    } catch { }
}

export async function isRateLimited(key, max, windowSec) {
    try {
        const script = `
            local count = redis.call("INCR", KEYS[1])
            if count == 1 then
                redis.call("EXPIRE", KEYS[1], ARGV[1])
            end
            return count
        `;
        const count = await redisClient.eval(script, {
            keys: [key],
            arguments: [windowSec],
        });
        return count > max;
    } catch {
        return false;
    }
}