import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createServer } from "node:http";
import mongoose from "mongoose";
import cors from "cors";
import passport from "passport";
import "../config/passport.js";
import "./models/user.model.js";
import "./models/meeting.model.js";
import userRoutes from "./routes/users.routes.js";
import roomsRoutes from "./routes/rooms.js";
import meetingsRoutes from "./routes/meetings.routes.js";
import transcriptRoutes from "./routes/transcripts.js";
import emotionRoutes from "./routes/emotion.routes.js";
import { connectToSocket } from "./controllers/socket.controller.js";
import { logout } from "./controllers/user.controller.js";
import { connectRedis, redisPub, redisSub } from "./infra/redis.js";
import transcriptProxyRoutes from "./routes/transcriptProxy.routes.js";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const server = createServer(app);

const allowedOrigins = [
  "https://skymeetai.onrender.com",
  "http://localhost:3000",
];

const EMOTION_SERVICE_URL = process.env.EMOTION_SERVICE_URL;

if (!EMOTION_SERVICE_URL) {
  console.error("EMOTION_SERVICE_URL not set");
  process.exit(1);
}

const emotionProxy = createProxyMiddleware({
  target: EMOTION_SERVICE_URL,
  changeOrigin: true,
  ws: true,
  secure: false,
  pathRewrite: {
    "^/emotion-socket": "",
  },
  onProxyReqWs(proxyReq) {
    proxyReq.setHeader("Origin", "https://skymeetai.onrender.com");
  },
  onProxyRes(proxyRes, req, res) {
    // Strip all CORS headers from the upstream response so they are never
    // forwarded to the client.  The upstream service may return them as a
    // plain string *or* as an array (when the value was duplicated), so we
    // delete every possible key variant before setting our own values once.
    const corHeaders = [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-allow-methods",
      "access-control-allow-headers",
    ];
    for (const header of corHeaders) {
      delete proxyRes.headers[header];
    }

    // Write the authoritative CORS headers directly onto the outgoing
    // response object.  Using res.setHeader() guarantees a single value
    // regardless of what http-proxy-middleware does with proxyRes.headers.
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
  },
});

app.use("/emotion-socket", (req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    return res.sendStatus(204);
  }
  next();
});

app.use("/emotion-socket", emotionProxy);

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/emotion-socket")) {
    emotionProxy.upgrade(req, socket, head);
  }
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/emotion-socket")) return next();
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, origin);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-host-secret",
      "x-user-token",
    ],
  })(req, res, next);
});

app.use(passport.initialize());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/rooms", roomsRoutes);
app.use("/api/v1/transcripts/proxy", transcriptProxyRoutes);
app.use("/api/v1/transcripts", transcriptRoutes);
app.use("/api/v1/emotion", emotionRoutes);
app.use("/api/v1/meetings", meetingsRoutes);

app.post("/api/v1/auth/logout", logout);

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error(`server: unhandled error on ${req.method} ${req.originalUrl} —`, err.message);
  const status = err?.status ?? 500;
  res.status(status).json({
    success: false,
    message: err?.message ?? "Internal server error",
  });
});

app.set("port", process.env.PORT || 8000);

const start = async () => {
  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    console.info(`server: MongoDB connected to ${db.connection.host}`);
  } catch (err) {
    console.error("server: MongoDB connection failed —", err.message);
    process.exit(1);
  }

  try {
    await connectRedis();
    console.info("server: Redis connected");
  } catch (err) {
    console.error("server: Redis connection failed —", err.message);
    process.exit(1);
  }

  server.listen(app.get("port"), "0.0.0.0", () => {
    console.info(`server: listening on port ${app.get("port")}`);

    try {
      connectToSocket(
        server,
        {
          origin: "https://skymeetai.onrender.com",
          credentials: true,
        },
        redisPub,
        redisSub
      );
      console.info("server: socket manager initialized");
    } catch (err) {
      console.error("server: socket manager failed to initialize —", err.message);
    }
  });

  server.on("error", (err) => {
    console.error("server: HTTP server error —", err.message);
  });
};

console.log("SERVER PORT:", process.env.PORT);

process.on("unhandledRejection", (reason) => {
  console.error("server: unhandled promise rejection —", reason?.message ?? reason);
});

process.on("uncaughtException", (err) => {
  console.error("server: uncaught exception —", err.message);
  process.exit(1);
});

start();