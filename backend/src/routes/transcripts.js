import express from "express";
import passport from "passport";
import "../../config/passport.js";
import * as ctrl from "../controllers/transcript.controller.js";

const router = express.Router();

const optionalAuth = (req, res, next) => {
  passport.authenticate("jwt", { session: false }, (err, user) => {
    if (err) {
      console.warn("passport error:", err);
    }

    if (user) {
      req.user = user;
      console.log(" USER:", user._id || user.id || user.sub);
    } else {
      console.warn("⚠️ JWT failed or missing");
    }

    next();
  })(req, res, next);
};


router.post(
  "/",
  optionalAuth,
  ctrl.createTranscript
);

router.get(
  "/",
  optionalAuth,
  ctrl.listTranscripts 
);

router.get(
  "/:id",
  optionalAuth,
  ctrl.getTranscript 
);

export default router;