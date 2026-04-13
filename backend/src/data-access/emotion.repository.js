
import { Meeting } from "../models/meeting.model.js";

export async function findMeetingByCode(meetingCode) {

    return Meeting.findOne({ meetingCode });
}

export async function updateMeetingEmotionAnalytics(meetingCode, emotionScores) {

    const meeting = await findMeetingByCode(meetingCode);

    if (meeting) await meeting.updateAnalytics({
        emotionScores
    });
    
    return meeting;
}