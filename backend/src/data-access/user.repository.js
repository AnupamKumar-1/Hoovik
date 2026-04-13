
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Meeting } from "../models/meeting.model.js";
import cfg from "../config/config.json" assert { type: "json" };

const HOST_POPULATE_FIELDS = cfg.user?.hostPopulateFields ?? "name username";
const ME_POPULATE_FIELDS = cfg.user?.mePopulateFields ?? "_id username name";

const MEETINGS_QUERY_LIMIT = cfg.user?.meetingsQueryLimit ?? 200;

export async function findUserByUsername(username) {
    return User.findOne({
        username
    }).select("_id username name password")
        .lean();
}

export async function findUserById(userId) {
    return User.findById(userId)
        .select(ME_POPULATE_FIELDS)
        .lean();
}

export async function findUserByUsernameLean(username) {

    return User.findOne({ username })
        .select("_id")
        .lean();
}

export async function createUser({ name, username, hashedPassword }) {
    const newUser = new User({
        name,
        username,
        password: hashedPassword
    });
    return newUser.save();
}

export async function findMeetingsByUser(objectUserId, userId) {
    const query = {
        $or: [
            { host: objectUserId },
            { ownerId: objectUserId },
            {
                participants: {
                    $elemMatch: {
                        $or: [
                            { "meta.userId": userId },
                            { userId: objectUserId },
                            { userId },
                        ],
                    },
                },
            },
        ],
    };

    return Meeting.find(query)
        .sort({ createdAt: -1 })
        .populate("host", HOST_POPULATE_FIELDS)
        .lean()
        .exec();
}

export async function findMeetingByCode(meetingCode) {
    return Meeting.findOne({
        meetingCode
    }).select("_id meetingCode")
        .lean().exec();
}

export async function createMeeting({ meetingCode, link, objectUserId, userId, name }) {
    const newMeeting = new Meeting({
        meetingCode,
        link,
        host: objectUserId,
        ownerId: objectUserId,
        participants: [{
            socketId: `init-${userId}-${Date.now()}`,
            name,
            userId,
            meta: { userId },
            joinedAt: new Date(),
        }],
    });
    return newMeeting.save();
}

export async function findMeetingForParticipant(meetingCode) {

    return Meeting.findOne({ meetingCode });
}

export async function saveMeeting(meeting) {
    return meeting.save();
}

export async function findMeetingsForUser(objectUserId, userId, mineOnly, limit) {
    let filter = {};
    if (objectUserId && mineOnly) {
        filter = {
            $or: [{
                    ownerId: objectUserId
            },
                { host: objectUserId },
                { "participants.meta.userId": userId

                }]
        };
    } else if (objectUserId) {
        filter = { $or: [{ host: objectUserId }, { ownerId: objectUserId }, { "participants.meta.userId": userId }, { active: true }] };
    } else {
        filter = { active: true };
    }

    const projection = {
  meetingCode: 1, 
  link: 1, 
  active: 1, 
  hostInfo: 1, 
  host: 1, 
  ownerId: 1, 
  createdAt: 1,
  lastActivityAt: 1,
  participants: 1
};

    return Meeting.find(filter, projection)
        .sort({ lastActivityAt: -1, createdAt: -1 })
        .limit(limit)
        .populate({ path: "host", model: "UserDb", select: HOST_POPULATE_FIELDS })
        .lean()
        .exec();
}

export async function upsertMeetingByCode(meetingCode, payload) {

    return Meeting.upsertByMeetingCode(meetingCode, payload);
}

export async function ensureMeetingIndexes() {
    const col = Meeting.collection;
    await Promise.all([
        col.createIndex({ meetingCode: 1 }, { unique: true, background: true }),

        col.createIndex({ ownerId: 1 }, { background: true }),
        col.createIndex({ host: 1 }, { background: true }),
        
        col.createIndex({ "participants.meta.userId": 1 }, { background: true }),
    ]);
}