import dotenv from "dotenv";
dotenv.config();

import passport from "passport";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";
import { User } from "../src/models/user.model.js";

if (!process.env.JWT_SECRET) {
  console.error("passport: JWT_SECRET is not set — authentication will fail");
}

const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
};

passport.use(
  new JwtStrategy(opts, async (payload, done) => {
    try {
      const user = await User.findById(payload.sub).lean();

      if (!user) {
        console.warn(`passport: no user found for token subject ${payload.sub}`);
        return done(null, false);
      }

      const normalizedUser = {
        _id: user._id.toString(),
        id: user._id.toString(),
        username: user.username,
        name: user.name,
      };

      return done(null, normalizedUser);
    } catch (err) {
      console.error("passport: JWT strategy error —", err.message);
      return done(err, false);
    }
  })
);

export default passport;