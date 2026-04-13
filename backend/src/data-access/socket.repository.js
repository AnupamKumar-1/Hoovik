import { Meeting } from "../models/meeting.model.js";

export async function findMeetingByCode(meetingCode) {
    return Meeting.findOne({
        meetingCode
    });
}

export async function addMeetingParticipant(socketId, name, meta) {

    const meeting = await Meeting.findOne({
        meetingCode: meta.meetingCode
    });
    if (!meeting) return null;

    await meeting.addParticipant({
        socketId,
        name,
        meta
    });
    return meeting;
}

export async function markParticipantLeft(meetingCode, socketId) {

    const meeting = await Meeting.findOne({
        meetingCode
    });
    if (!meeting) return null;
    await meeting.markParticipantLeft(socketId);
    return meeting;
}

export async function restoreMeetingParticipant(meetingCode, socketId, user, meta) {
    const meeting = await Meeting.findOne({
        meetingCode
    });
    if (!meeting) return null;
    await meeting.restoreParticipant(socketId, user, meta);
    return meeting;
}

export async function saveMeeting(meeting) {
    return meeting.save();
}

export async function updateMeetingParticipantMeta(meetingCode, socketId, meta) {
    const meeting = await Meeting.findOne({
        meetingCode
    });

    if (!meeting) return null;
    await meeting.updateParticipantMeta(socketId, meta);

    return meeting;
}

export async function addMeetingChatMessage(meetingCode, chatMsg) {
    const meeting = await Meeting.findOne({
        meetingCode
    });
    if (!meeting) return null;
    await meeting.addChatMessage(chatMsg);
    return meeting;
}

export async function updateMeetingAnalytics(meetingCode, data) {
    const meeting = await Meeting.findOne({
        meetingCode
    });
    if (!meeting) return null;

    await meeting.updateAnalytics(data);
    return meeting;
}