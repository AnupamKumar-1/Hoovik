import { Router } from "express";
import mongoose from "mongoose";
import { isRedisReady } from "../infra/redis.js";

const router = Router();

router.get("/", (req, res) => {
  const mongoHealthy = mongoose.connection.readyState === 1;
  const redisHealthy = isRedisReady();

  const isHealthy = mongoHealthy && redisHealthy;

  return res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    uptime: process.uptime(),
    dependencies: {
      mongo: mongoHealthy ? "connected" : "disconnected",
      redis: redisHealthy ? "connected" : "disconnected",
    },
  });
});

export default router;