import { Router } from "express";
import passport from "passport";
import "../../config/passport.js";
import {
  addToHistory,
  getUserHistory,
  login,
  register,
  addParticipant,
  logout,
  upsertMeeting,
  getMe,
} from "../controllers/user.controller.js";

const router = Router();

const jwtAuth = passport.authenticate("jwt", { session: false });

router.post("/login", login);
router.post("/register", register);

router.post("/logout", jwtAuth, logout);

router.post("/add_to_activity", jwtAuth, addToHistory);
router.get("/get_all_activity", jwtAuth, getUserHistory);

router.post("/meetings/:code/participants", jwtAuth, addParticipant);
router.post("/add_participant", jwtAuth, addParticipant);
router.post("/meetings", jwtAuth, upsertMeeting);
router.get("/me", jwtAuth, getMe);
export default router;