
import { Meeting } from "../models/meeting.model.js";

export async function findMeetingByCode(roomCode) {
    return Meeting.findOne({
        meetingCode: roomCode
    }).lean();
}

export async function findActiveMeetingByCode(roomCode) {
    return Meeting.findOne({
        meetingCode: roomCode.toUpperCase(),
        active: true
    }).lean();
}

export async function createMeetingRoom(payload) {
    return Meeting.create(payload);
}

export async function findRoomsByOwner(ownerId) {
    return Meeting.find({ ownerId })
        .sort({ createdAt: -1 })
        .select("meetingCode hostName createdAt active")
        .lean();
}