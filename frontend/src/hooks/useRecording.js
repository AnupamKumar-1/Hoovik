import { useRef } from "react";

const NOISE_GATE_RMS_THRESHOLD = parseFloat(process.env.REACT_APP_NOISE_GATE_RMS || "0.008");
const NOISE_GATE_HOLD_MS = parseInt(process.env.REACT_APP_NOISE_GATE_HOLD_MS || "1500", 10);
const NOISE_GATE_SMOOTHING = parseFloat(process.env.REACT_APP_NOISE_GATE_SMOOTHING || "0.8");
const NOISE_GATE_FFT_SIZE = 2048;
const SPEECH_MIN_ACTIVE_MS = parseInt(process.env.REACT_APP_SPEECH_MIN_ACTIVE_MS || "800", 10);

export default function useRecording({
  isHost,
  roomId,
  participantsMetaRef,
  TRANSCRIPTS_ENABLED,
  TRANSCRIPT_ENDPOINT,
  API_BASE,
}) {
  const recordersRef = useRef({});

  function _stopRecorderOnly(id) {
    const existing = recordersRef.current[id];
    if (!existing) return;

    try {
      if (existing.recorder?.state !== "inactive") existing.recorder.stop();
    } catch { }

    try {
      if (existing.audioCtx?.state !== "closed") existing.audioCtx?.close();
    } catch { }

    existing.recorder = null;
    existing.audioCtx = null;
    existing.analyser = null;
    existing.audioStream = null;
  }

  function _stopRecorderForId(id) {
    _stopRecorderOnly(id);
    delete recordersRef.current[id];
  }

  function startRecordingForStream(id, stream, { force = false } = {}) {
    if (!isHost || !stream) return;

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks?.length) return;

    const existing = recordersRef.current[id];

    if (existing && !force) {
      const recorderTrack = existing.audioStream?.getAudioTracks?.()?.[0];
      const newTrack = audioTracks[0];
      if (recorderTrack && recorderTrack.id === newTrack.id) {
        if (existing.recorder?.state === "recording") return;
      }
    }

    const survivingChunks = existing?.chunks ?? [];
    const survivingGateState = existing?.gateState ?? null;

    if (existing) _stopRecorderOnly(id);

    try {
      const track = audioTracks[0];
      const audioStream = new MediaStream([track]);

      let audioCtx = null;
      let analyser = null;
      let pcmBuffer = null;

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = NOISE_GATE_FFT_SIZE;
        analyser.smoothingTimeConstant = NOISE_GATE_SMOOTHING;
        const sourceNode = audioCtx.createMediaStreamSource(audioStream);
        sourceNode.connect(analyser);
        pcmBuffer = new Float32Array(analyser.fftSize);
      } catch {
        audioCtx = null;
        analyser = null;
      }

      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      }

      const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);

      const gateState = survivingGateState
        ? {
          ...survivingGateState,
          smoothedRms: 0,
          isOpen: false,
          lastChunkTime: Date.now(),
        }
        : {
          smoothedRms: 0,
          isOpen: false,
          lastActiveMs: 0,
          totalSpeechMs: 0,
          lastChunkTime: Date.now(),
        };

      recorder.ondataavailable = (ev) => {
        if (!ev.data?.size) return;

        const now = Date.now();
        const elapsed = now - gateState.lastChunkTime;
        gateState.lastChunkTime = now;

        if (analyser && pcmBuffer) {
          analyser.getFloatTimeDomainData(pcmBuffer);
          let sum = 0;
          for (let i = 0; i < pcmBuffer.length; i++) {
            sum += pcmBuffer[i] * pcmBuffer[i];
          }
          const rms = Math.sqrt(sum / pcmBuffer.length);

          gateState.smoothedRms =
            NOISE_GATE_SMOOTHING * gateState.smoothedRms +
            (1 - NOISE_GATE_SMOOTHING) * rms;

          const aboveThreshold = gateState.smoothedRms > NOISE_GATE_RMS_THRESHOLD;

          if (aboveThreshold) {
            if (!gateState.isOpen) gateState.isOpen = true;
            gateState.lastActiveMs = now;
            gateState.totalSpeechMs += elapsed;
          } else if (gateState.isOpen) {
            if (now - gateState.lastActiveMs > NOISE_GATE_HOLD_MS) {
              gateState.isOpen = false;
            } else {
              gateState.totalSpeechMs += elapsed;
            }
          }
        }

        survivingChunks.push(ev.data);
      };

      recorder.start(1000);

      recordersRef.current[id] = {
        recorder,
        chunks: survivingChunks,
        audioStream,
        audioCtx,
        analyser,
        gateState,
      };
    } catch { }
  }

  function stopAllRecorders() {
    const promises = Object.values(recordersRef.current).map((rec) => {
      return new Promise((resolve) => {
        try {
          if (!rec?.recorder || rec.recorder.state === "inactive") {
            try { if (rec?.audioCtx?.state !== "closed") rec.audioCtx?.close(); } catch { }
            resolve();
            return;
          }
          rec.recorder.addEventListener("stop", () => {
            try { if (rec?.audioCtx?.state !== "closed") rec.audioCtx?.close(); } catch { }
            resolve();
          }, { once: true });
          rec.recorder.stop();
        } catch {
          resolve();
        }
      });
    });
    return Promise.all(promises);
  }

  function hasSufficientSpeech(rec) {
    if (!rec?.gateState) return true;
    return rec.gateState.totalSpeechMs >= SPEECH_MIN_ACTIVE_MS;
  }

  function getSpeechActiveRecordings() {
    const result = {};
    for (const [id, rec] of Object.entries(recordersRef.current)) {
      if (rec?.chunks?.length && hasSufficientSpeech(rec)) {
        result[id] = rec;
      }
    }
    return result;
  }

  function uploadRecordingsAndStoreTranscript() {
    return Promise.resolve(null);
  }

  return {
    recordersRef,
    startRecordingForStream,
    stopAllRecorders,
    uploadRecordingsAndStoreTranscript,
    getSpeechActiveRecordings,
    hasSufficientSpeech,
  };
}