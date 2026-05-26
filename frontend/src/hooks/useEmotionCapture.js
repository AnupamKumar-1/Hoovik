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
const MIN_INTERVAL_MS = 200;
const ACTIVE_SPEAKER_DEPRIORITISE_EVERY = 4;
const BACKPRESSURE_RESTORE_DELAY_MS = 8000;

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHUNK_DURATION_MS = 100;
const AUDIO_CHUNK_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_CHUNK_DURATION_MS) / 1000; // 1600

function isMobileBrowser() {
  if (typeof navigator !== "object") return false;
  return /android|iphone|ipad|ipod|mobile|tablet/i.test(navigator.userAgent);
}


export default function useEmotionCapture({
  ensureSocket,
  getSocketForParticipant,
  remoteStreamsRef,
  participantsMetaRef,
  myId,
  roomId,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
  activeSpeakerIdRef,
  localStreamRef,
  serverCapsRef,
}) {
  const recordingState = useRef(new Map());
  const emoIntervalHandleRef = useRef(null);
  const canvasCache = useRef(new Map());
  const videoCache = useRef(new Map());
  const passCounterRef = useRef(0);
  const currentIntervalMsRef = useRef(null);
  const backpressureRestoreTimerRef = useRef(null);


  const participantMediaStateRef = useRef(new Map());

  const audioStateRef = useRef(new Map());

  function getCanvas(participantId) {
    if (!canvasCache.current.has(participantId)) {
      const canvas = document.createElement("canvas");
      canvas.width = CAPTURE_WIDTH;
      canvas.height = CAPTURE_HEIGHT;
      canvasCache.current.set(participantId, { canvas, ctx: canvas.getContext("2d") });
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
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      if (isMobileBrowser()) {
        video.style.cssText =
          "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
      }
      entry = { video, stream };
      videoCache.current.set(participantId, entry);
    }
    const { video } = entry;
    if (video.paused) {
      try { await video.play(); }
      catch {
        if (video.parentNode) video.parentNode.removeChild(video);
        video.srcObject = null;
        videoCache.current.delete(participantId);
        return null;
      }
    }
    return video.videoWidth && video.videoHeight ? video : null;
  }

  function getVideoRotation(video) {
    try {
      const track = video.srcObject?.getVideoTracks?.()?.[0];
      const settings = track?.getSettings?.() ?? {};
      return settings.facingMode ? (settings.rotation ?? 0) : 0;
    } catch { return 0; }
  }

  function drawFullFrame(ctx, video) {
    const rotation = getVideoRotation(video);
    if (rotation === 0) { ctx.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT); return; }
    ctx.save();
    ctx.translate(CAPTURE_WIDTH / 2, CAPTURE_HEIGHT / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    const isPortrait = rotation === 90 || rotation === 270;
    const drawW = isPortrait ? CAPTURE_HEIGHT : CAPTURE_WIDTH;
    const drawH = isPortrait ? CAPTURE_WIDTH : CAPTURE_HEIGHT;
    ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
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
    const socket = ensureSocket(participantId);
    if (!socket?.connected || !stream || !participantId) return;
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
        if (i < burstCount - 1) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
      }
    } catch (e) {
      console.warn("[EmotionCapture] burst failed pid=%s", participantId, e);
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


  async function ensureParticipantAudio(participantId, stream, socket) {
    if (audioStateRef.current.has(participantId)) return;
    const audioTracks = stream.getAudioTracks?.() ?? [];
    if (!audioTracks.length) return;

    audioStateRef.current.set(participantId, null);

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) { audioStateRef.current.delete(participantId); return; }

      const ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });

      const processorCode = `
        class ChunkProcessor extends AudioWorkletProcessor {
          constructor(options) {
            super();
            this._chunkSize = options.processorOptions.chunkSize;
            this._buf = new Float32Array(0);
          }
          process(inputs) {
            const input = inputs[0]?.[0];
            if (!input || !input.length) return true;
            const merged = new Float32Array(this._buf.length + input.length);
            merged.set(this._buf);
            merged.set(input, this._buf.length);
            this._buf = merged;
            while (this._buf.length >= this._chunkSize) {
              const chunk = this._buf.slice(0, this._chunkSize);
              this._buf = this._buf.slice(this._chunkSize);
              // Transfer the underlying buffer (zero-copy) to the main thread
              this.port.postMessage(chunk.buffer, [chunk.buffer]);
            }
            return true;
          }
        }
        registerProcessor('emotion-chunk-processor', ChunkProcessor);
      `;

      const blobUrl = URL.createObjectURL(
        new Blob([processorCode], { type: "application/javascript" })
      );

      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      if (!audioStateRef.current.has(participantId)) {
        await ctx.close();
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, "emotion-chunk-processor", {
        processorOptions: { chunkSize: AUDIO_CHUNK_SAMPLES },
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });

      workletNode.port.onmessage = (event) => {

        if (!audioStateRef.current.has(participantId)) return;
        if (!socket?.connected) return;

        const mediaState = participantMediaStateRef.current.get(participantId);
        if (mediaState && !mediaState.micEnabled) return;
        socket.emit("audio_chunk", new Uint8Array(event.data));
      };

      source.connect(workletNode);
      audioStateRef.current.set(participantId, { ctx, source, workletNode });
    } catch (err) {
      console.warn("[EmotionCapture] audio setup failed pid=%s", participantId, err);
      audioStateRef.current.delete(participantId);
    }
  }

  function releaseParticipantAudio(participantId) {
    const entry = audioStateRef.current.get(participantId);
    if (!entry) {

      audioStateRef.current.delete(participantId);
      return;
    }
    audioStateRef.current.delete(participantId);
    try { entry.workletNode.port.onmessage = null; entry.workletNode.port.close(); entry.workletNode.disconnect(); } catch { }
    try { entry.source.disconnect(); } catch { }
    try { entry.ctx.close(); } catch { }
  }

  function stopAudioCapture() {
    for (const [pid] of audioStateRef.current) {
      releaseParticipantAudio(pid);
    }
  }


  function _resolveNormalIntervalMs() {
    const caps = serverCapsRef?.current;
    if (caps?.targetFps > 0) return Math.max(MIN_INTERVAL_MS, Math.round(1000 / caps.targetFps));
    return EMO_CONFIG?.captureIntervalMs ?? DEFAULT_INTERVAL_MS;
  }

  function _restartInterval(intervalMs) {
    if (emoIntervalHandleRef.current) clearInterval(emoIntervalHandleRef.current);
    currentIntervalMsRef.current = intervalMs;
    emoIntervalHandleRef.current = setInterval(doCapturePass, intervalMs);
  }


  async function doCapturePass() {

    const caps = serverCapsRef?.current;
    if (caps?.suggestedFps != null) {
      const suggestedMs = Math.max(MIN_INTERVAL_MS, Math.round(1000 / caps.suggestedFps));
      if (suggestedMs !== currentIntervalMsRef.current) {
        _restartInterval(suggestedMs);
        if (backpressureRestoreTimerRef.current) clearTimeout(backpressureRestoreTimerRef.current);
        backpressureRestoreTimerRef.current = setTimeout(() => {
          if (caps) caps.suggestedFps = null;
          const normalMs = _resolveNormalIntervalMs();
          if (normalMs !== currentIntervalMsRef.current) _restartInterval(normalMs);
          backpressureRestoreTimerRef.current = null;
        }, BACKPRESSURE_RESTORE_DELAY_MS);
        return;
      }
    }

    const streamsMap = remoteStreamsRef.current || {};
    let entries = Object.entries(streamsMap).filter(([id]) => id !== myId);
    if (!entries.length) return;

    passCounterRef.current += 1;
    const passCount = passCounterRef.current;
    const activeSpeakerId = activeSpeakerIdRef?.current;
    const burstCount = entries.length > MANY_THRESHOLD ? BURST_COUNT_MANY : BURST_COUNT_DEFAULT;

    shuffle(entries);

    if (passCount % ACTIVE_SPEAKER_DEPRIORITISE_EVERY === 0 && activeSpeakerId) {
      const idx = entries.findIndex(([id]) => id === activeSpeakerId);
      if (idx > -1) { const [e] = entries.splice(idx, 1); entries.push(e); }
    }

    for (let i = 0; i < entries.length; i++) {
      const [streamId, stream] = entries[i];
      const participantId = resolveParticipantId(streamId);

      const mediaState = participantMediaStateRef.current.get(participantId);
      const micEnabled =
        mediaState === undefined ? true : mediaState.micEnabled;
      const camEnabled =
        mediaState === undefined ? true : mediaState.cameraEnabled;

      const socket = ensureSocket(participantId);

      if (socket) {
        if (micEnabled) {
          ensureParticipantAudio(participantId, stream, socket).catch((e) =>
            console.warn("[EmotionCapture] audio init error pid=%s", participantId, e)
          );
        } else {
          releaseParticipantAudio(participantId);
        }
      }
      if (camEnabled) {
        sendBurst({ stream, participantId, burstCount }).catch((e) =>
          console.warn("[EmotionCapture] burst error pid=%s", participantId, e)
        );
      }

      if (i < entries.length - 1) await new Promise((r) => setTimeout(r, INTER_PARTICIPANT_DELAY_MS));
    }
  }


  function startPeriodicEmotionCapture({ intervalMs } = {}) {
    if (typeof EMOTIONS_ENABLED !== "undefined" && !EMOTIONS_ENABLED) {
      stopPeriodicEmotionCapture();
      return;
    }
    stopPeriodicEmotionCapture();
    if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return;

    const resolvedMs =
      intervalMs ??
      (serverCapsRef?.current?.targetFps > 0
        ? Math.max(MIN_INTERVAL_MS, Math.round(1000 / serverCapsRef.current.targetFps))
        : EMO_CONFIG?.captureIntervalMs ?? DEFAULT_INTERVAL_MS);

    doCapturePass();
    _restartInterval(resolvedMs);
  }

  function stopPeriodicEmotionCapture({ notifyMediaState } = {}) {
    if (emoIntervalHandleRef.current) {
      clearInterval(emoIntervalHandleRef.current);
      emoIntervalHandleRef.current = null;
    }
    currentIntervalMsRef.current = null;
    if (backpressureRestoreTimerRef.current) {
      clearTimeout(backpressureRestoreTimerRef.current);
      backpressureRestoreTimerRef.current = null;
    }


    if (typeof notifyMediaState === "function") {
      for (const [pid] of participantMediaStateRef.current) {
        try {
          notifyMediaState(pid, { micEnabled: false, cameraEnabled: false });
        } catch { /* ignore */ }
      }
    }

    if (typeof notifyMediaState === "function") {
      for (const [pid] of audioStateRef.current) {
        if (!participantMediaStateRef.current.has(pid)) {
          try {
            notifyMediaState(pid, { micEnabled: false, cameraEnabled: false });
          } catch { /* ignore */ }
        }
      }
    }

    stopAudioCapture();
    recordingState.current.clear();
    canvasCache.current.clear();
    videoCache.current.forEach(({ video }) => {
      if (video.parentNode) video.parentNode.removeChild(video);
      video.srcObject = null;
    });
    videoCache.current.clear();
    passCounterRef.current = 0;
  }

  /**

   * @param {string} participantId
   * @param {{ micEnabled: boolean, cameraEnabled: boolean }} state
   */
  function updateParticipantMediaState(participantId, { micEnabled, cameraEnabled }) {
    if (!participantId) return;
    participantMediaStateRef.current.set(
      participantId,
      Object.freeze({
        micEnabled: Boolean(micEnabled),
        cameraEnabled: Boolean(cameraEnabled),
      })
    );

    if (!micEnabled) releaseParticipantAudio(participantId);
    console.log(
      `[EmotionCapture] mediaState pid=${participantId} mic=${micEnabled} cam=${cameraEnabled}`
    );
  }

  return { startPeriodicEmotionCapture, stopPeriodicEmotionCapture, updateParticipantMediaState };
}