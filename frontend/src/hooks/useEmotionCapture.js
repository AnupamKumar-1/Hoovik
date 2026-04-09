import { useRef } from "react";
import { EMO_CONFIG, EMOTIONS_ENABLED } from "../pages/meetConfig";

export default function useEmotionCapture({
  socketRef,
  remoteStreamsRef,
  myId,
  roomId,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
  activeSpeakerIdRef,
}) {
  const recordingState = useRef(new Map());
  const emoIntervalHandleRef = useRef(null);

  async function recordAndSendClip({ stream, meetingId, participantId }) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) return;

    const socket = socketRef.current;
    if (!stream || !socket || !socket.connected) return;
    if (!participantId || participantId === myId) return;
    if (recordingState.current.get(participantId)) return;

    recordingState.current.set(participantId, true);

    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      try {
        await video.play();
      } catch {
        recordingState.current.delete(participantId);
        return;
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85)
      );

      if (!blob) return;

      const arrayBuffer = await blob.arrayBuffer();

      socket.emit("emotion.frame", {
        meetingId: (meetingId || "").toUpperCase(),
        participantId,
        buffer: arrayBuffer,
      });
    } catch (e) {
      console.warn("emotion capture failed", e);
    } finally {
      recordingState.current.delete(participantId);
    }
  }

  function startPeriodicEmotionCapture({
    intervalMs = EMO_CONFIG.captureIntervalMs,
  } = {}) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) {
      stopPeriodicEmotionCapture();
      return;
    }

    stopPeriodicEmotionCapture();

    if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return;

    const doCapturePass = async () => {
      const activeSpeakerId = activeSpeakerIdRef?.current;
      if (!activeSpeakerId || activeSpeakerId === myId) return;

      const streamsMap = remoteStreamsRef.current || {};
      const stream = streamsMap[activeSpeakerId];
      if (!stream) return;

      recordAndSendClip({
        stream,
        meetingId: roomId,
        participantId: activeSpeakerId,
      });
    };

    doCapturePass();
    emoIntervalHandleRef.current = setInterval(doCapturePass, intervalMs);
  }

  function stopPeriodicEmotionCapture() {
    if (emoIntervalHandleRef.current) {
      clearInterval(emoIntervalHandleRef.current);
      emoIntervalHandleRef.current = null;
    }
    recordingState.current.clear();
  }

  return {
    startPeriodicEmotionCapture,
    stopPeriodicEmotionCapture,
  };
}