import express from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import "../../config/passport.js";
import * as ctrl from "../controllers/transcript.controller.js";

const router = express.Router();

const transcriptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests" },
});

const aAuth = (req, _res, next) => {
  passport.authenticate("jwt", { session: false }, (_err, user) => {
    if (user) req.user = user;
    next();
  })(req, _res, next);
};

router.use(transcriptLimiter);

router.post("/", aAuth, ctrl.createTranscript);
router.get("/", aAuth, ctrl.listTranscripts);
router.get("/:id", aAuth, ctrl.getTranscript);

export default router;