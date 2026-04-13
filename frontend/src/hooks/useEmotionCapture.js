import { useRef } from "react";
import { EMO_CONFIG, EMOTIONS_ENABLED } from "../pages/meetConfig";


const CAPTURE_WIDTH = 720;
const CAPTURE_HEIGHT = 540;
const JPEG_QUALITY = 0.82;
const BURST_COUNT_DEFAULT = 1;
const BURST_COUNT_MANY = 1;
const MANY_THRESHOLD = 4;
const BURST_GAP_MS = 200;


const INTER_PARTICIPANT_DELAY_MS = 80;

const DEFAULT_INTERVAL_MS = 700;
const ACTIVE_SPEAKER_DEPRIORITISE_EVERY = 4;

export default function useEmotionCapture({
  socketRef,
  remoteStreamsRef,
  participantsMetaRef,
  myId,
  roomId,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
  activeSpeakerIdRef,
}) {
  const recordingState = useRef(new Map());
  const emoIntervalHandleRef = useRef(null);
  const canvasCache = useRef(new Map());
  const videoCache = useRef(new Map());
  const passCounterRef = useRef(0);


  function getCanvas(participantId) {
    if (!canvasCache.current.has(participantId)) {
      const canvas = document.createElement("canvas");
      canvas.width = CAPTURE_WIDTH;
      canvas.height = CAPTURE_HEIGHT;
      canvasCache.current.set(participantId, {
        canvas,
        ctx: canvas.getContext("2d"),
      });
    }
    return canvasCache.current.get(participantId);
  }

  async function getVideo(participantId, stream) {
    let entry = videoCache.current.get(participantId);

    if (!entry || entry.stream !== stream) {
      if (entry) entry.video.srcObject = null;
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      entry = { video, stream };
      videoCache.current.set(participantId, entry);
    }

    const { video } = entry;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        videoCache.current.delete(participantId);
        return null;
      }
    }

    return (video.videoWidth && video.videoHeight) ? video : null;
  }


  function drawFullFrame(ctx, video) {
    ctx.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
  }

  async function captureAndSend({ canvas, ctx, video, participantId, socket }) {
    drawFullFrame(ctx, video);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));

    if (!blob || blob.size < 1000) return;

    const buffer = new Uint8Array(await blob.arrayBuffer());
    socket.emit("emotion.frame", {
      meetingId: (roomId || "").toUpperCase(),
      participantId,
      buffer,
    });
  }

  async function sendBurst({ stream, participantId, burstCount }) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) return;
    const socket = socketRef.current;
    if (!stream || !socket?.connected || !participantId) return;
    if (!stream.getVideoTracks().length) return;
    if (recordingState.current.get(participantId)) return;

    recordingState.current.set(participantId, true);
    try {
      const video = await getVideo(participantId, stream);
      if (!video) return;

      const { canvas, ctx } = getCanvas(participantId);
      for (let i = 0; i < burstCount; i++) {
        if (!socket.connected) break;
        await captureAndSend({ canvas, ctx, video, participantId, socket });
        if (i < burstCount - 1) {
          await new Promise((r) => setTimeout(r, BURST_GAP_MS));
        }
      }
    } catch (e) {
      console.warn("emotion burst failed pid=%s", participantId, e);
    } finally {
      recordingState.current.delete(participantId);
    }
  }


  function resolveParticipantId(streamId) {
    const meta = participantsMetaRef?.current?.find((p) => p.id === streamId);
    return meta?.meta?.userId || streamId;
  }


  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }


  async function doCapturePass() {
    const streamsMap = remoteStreamsRef.current || {};
    let entries = Object.entries(streamsMap).filter(([id]) => id !== myId);
    if (!entries.length) return;

    passCounterRef.current += 1;
    const passCount = passCounterRef.current;
    const activeSpeakerId = activeSpeakerIdRef?.current;
    const burstCount = entries.length > MANY_THRESHOLD
      ? BURST_COUNT_MANY
      : BURST_COUNT_DEFAULT;

    shuffle(entries);

    if (passCount % ACTIVE_SPEAKER_DEPRIORITISE_EVERY === 0 && activeSpeakerId) {
      const idx = entries.findIndex(([id]) => id === activeSpeakerId);
      if (idx > -1) {
        const [entry] = entries.splice(idx, 1);
        entries.push(entry);
      }
    }


    for (let i = 0; i < entries.length; i++) {
      const [streamId, stream] = entries[i];
      const participantId = resolveParticipantId(streamId);

      sendBurst({ stream, participantId, burstCount }).catch((e) =>
        console.warn("burst error pid=%s", participantId, e)
      );

      if (i < entries.length - 1) {
        await new Promise((r) => setTimeout(r, INTER_PARTICIPANT_DELAY_MS));
      }
    }
  }

  function startPeriodicEmotionCapture({
    intervalMs = EMO_CONFIG?.captureIntervalMs ?? DEFAULT_INTERVAL_MS,
  } = {}) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) {
      stopPeriodicEmotionCapture();
      return;
    }
    stopPeriodicEmotionCapture();
    if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return;

    doCapturePass();
    emoIntervalHandleRef.current = setInterval(doCapturePass, intervalMs);
  }

  function stopPeriodicEmotionCapture() {
    if (emoIntervalHandleRef.current) {
      clearInterval(emoIntervalHandleRef.current);
      emoIntervalHandleRef.current = null;
    }
    recordingState.current.clear();
    canvasCache.current.clear();
    videoCache.current.forEach(({ video }) => { video.srcObject = null; });
    videoCache.current.clear();
    passCounterRef.current = 0;
  }

  return {
    startPeriodicEmotionCapture,
    stopPeriodicEmotionCapture,
  };
}