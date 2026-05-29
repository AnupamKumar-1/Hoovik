import { Router } from "express";
import passport from "passport";
import { body, validationResult } from "express-validator";
import rateLimit from "express-rate-limit";
import "../../config/passport.js";
import {
  addToHistory,
  getUserHistory,
  login,
  register,
  refreshToken,
  addParticipant,
  logout,
  upsertMeeting,
  getMe,
} from "../controllers/user.controller.js";

const router = Router();

const jwtAuth = passport.authenticate("jwt", { session: false });

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ message: errors.array()[0].msg });
  }
  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again later." },
  skipSuccessfulRequests: true,
});

const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many refresh attempts." },
});

const loginRules = [
  body("username")
    .trim()
    .toLowerCase()
    .isLength({ min: 3, max: 32 })
    .withMessage("Username must be 3–32 characters.")
    .matches(/^[a-z0-9_.-]+$/)
    .withMessage("Username may only contain letters, numbers, _, ., and -."),
  body("password")
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be 8–128 characters."),
];

const registerRules = [
  body("name")
    .trim()
    .isLength({ min: 1, max: 64 })
    .withMessage("Name is required and must be under 64 characters.")
    .escape(),
  body("username")
    .trim()
    .toLowerCase()
    .isLength({ min: 3, max: 32 })
    .withMessage("Username must be 3–32 characters.")
    .matches(/^[a-z0-9_.-]+$/)
    .withMessage("Username may only contain letters, numbers, _, ., and -."),
  body("password")
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be 8–128 characters.")
    .matches(/[A-Z]/)
    .withMessage("Password must contain at least one uppercase letter.")
    .matches(/[0-9]/)
    .withMessage("Password must contain at least one number."),
];

router.post("/login", authLimiter, loginRules, validate, login);
router.post("/register", authLimiter, registerRules, validate, register);
router.post("/refresh", refreshLimiter, refreshToken);
router.post("/logout", jwtAuth, logout);

router.post("/add_to_activity", jwtAuth, addToHistory);
router.get("/get_all_activity", jwtAuth, getUserHistory);
router.post("/meetings/:code/participants", jwtAuth, addParticipant);
router.post("/add_participant", jwtAuth, addParticipant);
router.post("/meetings", jwtAuth, upsertMeeting);
router.get("/me", jwtAuth, getMe);

export default router;