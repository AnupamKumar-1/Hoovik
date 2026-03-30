import { useRef } from "react";
import {
  EMO_CONFIG,
  EMOTIONS_ENABLED,
  EMOTION_ENDPOINT,
} from "../pages/meetConfig";

export default function useEmotionCapture({
  socketRef,
  remoteStreamsRef,
  myId,
  roomId,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
}) {
  const recordingState = useRef(new Map());
  const emoIntervalHandleRef = useRef(null);

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = (e) => reject(e);
        fr.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    });
  }

  function emitWithAckTimeout(event, payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      try {
        socketRef.current?.emit(event, payload, (ack) => {
          if (done) return;
          done = true;
          resolve({ ok: true, ack });
        });
      } catch (e) {
        if (!done) {
          done = true;
          resolve({ ok: false, reason: e });
        }
      }
      setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
  }

  function chooseSupportedMime(preferredList) {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
      return "";
    }
    for (const m of preferredList) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) {}
    }
    return "";
  }

  function getTypeForStream(stream) {
    if (!stream) return null;
    const audioCount = (stream.getAudioTracks && stream.getAudioTracks().length) || 0;
    const videoCount = (stream.getVideoTracks && stream.getVideoTracks().length) || 0;
    if (videoCount > 0) return "video";
    if (audioCount > 0) return "audio";
    return null;
  }

  function buildAnalyzeUrl() {
    return EMOTION_ENDPOINT;
  }

  async function recordAndSendClip({
    stream,
    meetingId,
    participantId,
    durationMs,
  }) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) return;

    const socket = socketRef.current;
    if (!stream || !socket || !socket.connected) return;
    if (!participantId) return;
    if (participantId === myId) return;

    if (recordingState.current.get(participantId)) return;
    recordingState.current.set(participantId, true);

    try {
      const type = getTypeForStream(stream);
      if (!type) return;

      let mime = "";
      if (type === "video") {
        mime = chooseSupportedMime(EMO_CONFIG.preferVideoMime) || "";
      } else {
        mime = chooseSupportedMime(EMO_CONFIG.preferAudioMime) || "";
      }

      let recorder;
      try {
        recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        mime = recorder.mimeType || mime;
      } catch (err) {
        try {
          recorder = new MediaRecorder(stream);
          mime = recorder.mimeType || "";
        } catch (err2) {
          return;
        }
      }

      const chunks = [];
      let stopped = false;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };

      recorder.onstop = async () => {
        if (stopped) return;
        stopped = true;

        if (!chunks.length) return;

        try {
          const blob = new Blob(chunks, {
            type: chunks[0].type || mime,
          });

          let arrayBuffer = null;
          try {
            arrayBuffer = await blob.arrayBuffer();
          } catch {
            arrayBuffer = null;
          }

          let ext = "webm";
          try {
            ext =
              (blob.type &&
                blob.type.split("/")[1].split(";")[0]) ||
              "webm";
            ext = ext.replace(/[^a-z0-9]/gi, "");
          } catch {}

          const filename = `${participantId}.${ext}`;

          const payload = {
            meetingId: (meetingId || "").toUpperCase(),
            participantId,
            type,
            buffer: arrayBuffer,
            mime: blob.type || mime,
            filename,
            timestamp: Date.now(),
          };

          let sentViaSocket = false;

          if (arrayBuffer) {
            try {
              const resp = await emitWithAckTimeout(
                EMO_CONFIG.eventName,
                payload,
                8000
              );
              if (resp && resp.ok) {
                sentViaSocket = true;
                return;
              }
            } catch {}
          }

          if (!sentViaSocket) {
            try {
              const dataUrl = await blobToDataURL(blob);
              const payloadBase64 = {
                meetingId: (meetingId || "").toUpperCase(),
                participantId,
                type,
                dataUrl,
                mime: blob.type || mime,
                filename,
                timestamp: Date.now(),
              };

              const resp2 = await emitWithAckTimeout(
                `${EMO_CONFIG.eventName}.base64`,
                payloadBase64,
                12000
              );
              if (resp2 && resp2.ok) {
                sentViaSocket = true;
                return;
              }
            } catch {}
          }

          if (!sentViaSocket && EMOTION_ENDPOINT) {
            try {
              const fd = new FormData();
              fd.append("meeting_id", (meetingId || "").toUpperCase());
              fd.append("participant_id", participantId);
              fd.append("type", type || "audio");
              fd.append("file", blob, filename);

              await fetch(buildAnalyzeUrl(), {
                method: "POST",
                body: fd,
              });
            } catch {}
          }
        } finally {
          recordingState.current.delete(participantId);
        }
      };

      recorder.start();

      setTimeout(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
      }, durationMs);
    } finally {
      if (recordingState.current.get(participantId)) {
        recordingState.current.delete(participantId);
      }
    }
  }

  function startPeriodicEmotionCapture({
    clipDurationMs = EMO_CONFIG.clipDurationMs,
    intervalMs = EMO_CONFIG.captureIntervalMs,
  } = {}) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) {
      stopPeriodicEmotionCapture();
      return;
    }

    stopPeriodicEmotionCapture();

    if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return;

    const doCapturePass = async () => {
      const streamsMap = remoteStreamsRef.current || {};
      for (const [participantId, stream] of Object.entries(streamsMap)) {
        if (!participantId || participantId === myId) continue;
        if (!stream) continue;

        recordAndSendClip({
          stream,
          meetingId: roomId,
          participantId,
          durationMs: clipDurationMs,
        });
      }
    };

    doCapturePass();
    emoIntervalHandleRef.current = setInterval(
      doCapturePass,
      intervalMs
    );
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