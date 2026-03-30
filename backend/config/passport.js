import dotenv from "dotenv";
dotenv.config();

import passport from "passport";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import { User } from "../src/models/user.model.js";

if (!process.env.JWT_SECRET) {
  console.error("❌ ERROR: JWT_SECRET is not set.");
}

const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
};

passport.use(
  new JwtStrategy(opts, async (payload, done) => {
    try {
console.log("PASSPORT SECRET:", process.env.JWT_SECRET);
      const user = await User.findById(payload.sub).lean();

      if (!user) {
        console.warn("❌ User not found for JWT:", payload.sub);
        return done(null, false);
      }

      const normalizedUser = {
        _id: user._id.toString(),
        id: user._id.toString(),
        username: user.username,
        name: user.name,
      };

      console.log("✅ USER AUTHENTICATED:", normalizedUser);

      return done(null, normalizedUser);
    } catch (err) {
      console.error("❌ JWT Strategy Error:", err);
      return done(err, false);
    }
  })
);

export default passport;