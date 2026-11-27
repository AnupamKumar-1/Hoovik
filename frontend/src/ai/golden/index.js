import shortMeeting from "./shortMeeting.js";
import piiMeeting from "./piiMeeting.js";
import unstatedMeeting from "./unstatedMeeting.js";
import giantTurnMeeting from "./giantTurnMeeting.js";
import { mediumMeeting, longMeeting } from "./mediumLongMeetings.js";

export const GOLDEN = [
  shortMeeting,
  mediumMeeting,
  longMeeting,
  piiMeeting,
  unstatedMeeting,
  giantTurnMeeting,
];

export const goldenById = Object.fromEntries(GOLDEN.map((g) => [g.id, g]));
export { shortMeeting, mediumMeeting, longMeeting, piiMeeting, unstatedMeeting, giantTurnMeeting };
export { joinText } from "./builder.js";
