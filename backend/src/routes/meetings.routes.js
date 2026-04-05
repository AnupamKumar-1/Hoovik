
import { Router } from "express";
import passport from "passport";
import "../../config/passport.js";

import {
  addParticipant,
  getMeetings,
  upsertMeeting,
} from "../controllers/user.controller.js";

const router = Router();

const jwtAuth = passport.authenticate("jwt", { session: false });

const optionalAuth = (req, res, next) =>
  passport.authenticate("jwt", { session: false }, (err, user) => {
    if (err) return next(err);
    if (user) req.user = user;
    return next();
  })(req, res, next);


const safe = (fn, name = "handler") => async (req, res, next) => {
  console.debug(`[meetings] ${req.method} ${req.originalUrl} - query=${JSON.stringify(req.query)} bodyPresent=${!!req.body}`);
  try {
    await Promise.resolve(fn(req, res, next));
  } catch (err) {
    console.error(`[meetings] error in ${name}:`, err && (err.stack || err));

    res.status(err && err.status ? err.status : 500).json({
      success: false,
      message: err && err.message ? err.message : "Internal Server Error",

      ...(process.env.NODE_ENV !== "production" ? { stack: err && err.stack } : {}),
    });
  }
};


router.get("/", optionalAuth, safe(getMeetings, "getMeetings"));
router.post("/", jwtAuth, safe(upsertMeeting, "upsertMeeting"));


router.post("/:code/participants", jwtAuth, safe(addParticipant, "addParticipant"));
router.post("/add_participant", jwtAuth, safe(addParticipant, "addParticipant"));

export default router;