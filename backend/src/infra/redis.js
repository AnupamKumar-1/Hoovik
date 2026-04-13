
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function makeClient(name) {
    const c = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy: (r) =>
                Math.min(r * 100 + Math.random() * 100, 3000), },
    });
    c.on("error", (err) => console.error(`[redis:${name}]`, err.message));
    c.on("reconnecting", () => console.warn(`[redis:${name}] reconnecting...`));
    return c;
}

export const redisClient = makeClient("data");
export const redisPub = makeClient("pub");
export const redisSub = makeClient("sub");

export async function connectRedis() {
    await Promise.all([
        redisClient.isOpen ? null : redisClient.connect(),
        redisPub.isOpen ? null : redisPub.connect(),
        redisSub.isOpen ? null : redisSub.connect(),
    ]);
}

export default redisClient;