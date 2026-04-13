import { useRef, useState, useEffect, useCallback } from "react";

const SSRC_INTERVAL = 200;
const RMS_INTERVAL = 120;
const FFT_SIZE = 256;

const SPEAK_DECAY = 0.92;
const SPEAK_BOOST = 2.4;        // more sensitive to small voice
const SWITCH_THRESHOLD = 1.1;
const MIN_ACTIVITY = 0.006;
const NOISE_FLOOR_ALPHA = 0.97; // better noise tracking
const SWITCH_COOLDOWN = 500;
const MAX_ACTIVE_SPEAKERS = 3;


function computeRMS(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

const HAS_SSRC =
  typeof RTCRtpReceiver !== "undefined" &&
  typeof RTCRtpReceiver.prototype.getSynchronizationSources === "function";

export default function useAudioAnalyzer({
  remoteStreams,
  localStreamRef,
  mutedRef,
  pcsRef,
  localStream,
  participantsMetaMap,
}) {
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);
  const [pcsVersion, setPcsVersion] = useState(0);

  const participantsMapRef = useRef({});

  const activeSpeakerIdRef = useRef(null);
  const lastSpokeRef = useRef({});
  const lastLevelsRef = useRef({});

  const receiversRef = useRef({});
  const audioContextRef = useRef(null);
  const analyzersRef = useRef({});

  const speakerScoresRef = useRef({});
  const noiseFloorRef = useRef({});
  const lastSwitchTimeRef = useRef(0);

  const rafRef = useRef(null);
  const rafRunningRef = useRef(false);
  const timerRef = useRef(null);
  const timerRunningRef = useRef(false);
  const visibilityCleanupRef = useRef(null);
  const isRunningRef = useRef(false);
  const mountedRef = useRef(true);
  const activeSystemRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    participantsMapRef.current = participantsMetaMap || {};
  }, [participantsMetaMap]);

  const notifyPcsChanged = useCallback(() => {
    setPcsVersion((v) => v + 1);
  }, []);

  function commitSpeaker(nextId) {
    if (!mountedRef.current) return;
    if (nextId === activeSpeakerIdRef.current) return;
    activeSpeakerIdRef.current = nextId;
    setActiveSpeakerId(nextId);
  }

  function pruneRefs(activePeerIds) {
    for (const k of Object.keys(lastSpokeRef.current)) {
      if (!activePeerIds.has(k)) delete lastSpokeRef.current[k];
    }
    for (const k of Object.keys(lastLevelsRef.current)) {
      if (!activePeerIds.has(k)) delete lastLevelsRef.current[k];
    }
    for (const k of Object.keys(speakerScoresRef.current)) {
      if (!activePeerIds.has(k)) delete speakerScoresRef.current[k];
    }
    for (const k of Object.keys(noiseFloorRef.current)) {
      if (!activePeerIds.has(k)) delete noiseFloorRef.current[k];
    }
  }

  function updateSpeakerScores(levelMap, now) {
    let bestId = null;
    let bestScore = 0;
    const activeCandidates = [];

    for (const [id, levelRaw] of Object.entries(levelMap)) {
      const meta = participantsMapRef.current[id];

      if (meta?.muted === true) {
        speakerScoresRef.current[id] = 0;
        lastLevelsRef.current[id] = 0;
        continue;
      }

      if (id === "local" && mutedRef?.current) {
        speakerScoresRef.current[id] = 0;
        lastLevelsRef.current[id] = 0;
        continue;
      }

      const prevScore = speakerScoresRef.current[id] || 0;
      const prevNoiseFloor = noiseFloorRef.current[id] ?? levelRaw;
      const level = Math.max(0, levelRaw - prevNoiseFloor * 0.9);
      const boostedLevel = Math.pow(level, 0.7);

      noiseFloorRef.current[id] =
        prevNoiseFloor * NOISE_FLOOR_ALPHA +
        levelRaw * (1 - NOISE_FLOOR_ALPHA);

      if (level < MIN_ACTIVITY) {
        speakerScoresRef.current[id] *= 0.6;
        continue;
      }

      let score = prevScore * SPEAK_DECAY + boostedLevel * SPEAK_BOOST;

      lastSpokeRef.current[id] = now;
      speakerScoresRef.current[id] = score;

      if (score > 0.1) activeCandidates.push({ id, score });

      if (!meta?.muted && score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    activeCandidates.sort((a, b) => b.score - a.score);

    const topSpeakers = activeCandidates
      .slice(0, MAX_ACTIVE_SPEAKERS)
      .map((s) => s.id);

    const current = activeSpeakerIdRef.current;

    if (current && participantsMapRef.current[current]?.muted) {
      commitSpeaker(null);
      return { topSpeakers };
    }

    if (current === "local" && mutedRef?.current) {
      speakerScoresRef.current["local"] = 0;
      bestId = bestId === "local" ? null : bestId;
    }

    if (!bestId) {
      commitSpeaker(null);
      return { topSpeakers };
    }

    const thresholdMet =
      !current ||
      bestId === current ||
      speakerScoresRef.current[bestId] >=
      (speakerScoresRef.current[current] ?? 0) * SWITCH_THRESHOLD;

    const cooldownElapsed =
      now - lastSwitchTimeRef.current >= SWITCH_COOLDOWN;

    if (bestId !== current && (!thresholdMet || !cooldownElapsed)) {
      return { topSpeakers };
    }

    if (bestId !== current) {
      lastSwitchTimeRef.current = now;
      commitSpeaker(bestId);
    }

    return { topSpeakers };
  }

  function registerReceiver(peerId, pc) {
    for (const receiver of pc.getReceivers?.() ?? []) {
      if (
        receiver?.track?.kind === "audio" &&
        receiver.track.readyState !== "ended"
      ) {
        receiversRef.current[peerId] = receiver;
        return;
      }
    }
  }

  function unregisterReceiver(peerId) {
    delete receiversRef.current[peerId];
    delete lastSpokeRef.current[peerId];
    delete lastLevelsRef.current[peerId];
    delete speakerScoresRef.current[peerId];
    delete noiseFloorRef.current[peerId];
  }

  function startSSRCLoop() {
    if (timerRunningRef.current) return;
    if (activeSystemRef.current === "rms") return;

    activeSystemRef.current = "ssrc";
    timerRunningRef.current = true;

    const tick = () => {
      if (!timerRunningRef.current) return;
      if (document.hidden) return;
      if (isRunningRef.current) return;

      isRunningRef.current = true;

      try {
        const receivers = receiversRef.current;
        const peerIds = Object.keys(receivers);

        if (!peerIds.length) {
          stopSSRCLoop();
          return;
        }

        const now = performance.now();
        const levelMap = {};
        const activePeerIds = new Set(peerIds);

        for (const peerId of peerIds) {
          const receiver = receivers[peerId];
          const track = receiver?.track;

          const isMutedFromSignal =
            participantsMapRef.current[peerId]?.muted === true;

          if (
            !receiver ||
            !track ||
            track.readyState === "ended" ||
            track.muted === true ||
            track.enabled === false ||
            isMutedFromSignal
          ) {
            speakerScoresRef.current[peerId] = 0;
            lastLevelsRef.current[peerId] = 0;
            levelMap[peerId] = 0;
            continue;
          }

          const sources =
            receiver.getSynchronizationSources?.() ?? [];

          let peerLevel = 0;
          for (const src of sources) {
            if ((src.audioLevel ?? 0) > peerLevel)
              peerLevel = src.audioLevel;
          }

          const prev = lastLevelsRef.current[peerId] ?? 0;
          const smooth = prev * 0.6 + peerLevel * 0.4;

          lastLevelsRef.current[peerId] = smooth;
          levelMap[peerId] = smooth;
        }

        pruneRefs(activePeerIds);
        updateSpeakerScores(levelMap, now);
      } finally {
        isRunningRef.current = false;
      }
    };

    const onVisibility = () => {
      if (!document.hidden && timerRunningRef.current) tick();
    };

    document.addEventListener("visibilitychange", onVisibility);

    visibilityCleanupRef.current = () =>
      document.removeEventListener("visibilitychange", onVisibility);

    timerRef.current = setInterval(tick, SSRC_INTERVAL);
  }

  function stopSSRCLoop() {
    if (!timerRunningRef.current) return;

    timerRunningRef.current = false;
    clearInterval(timerRef.current);
    timerRef.current = null;

    visibilityCleanupRef.current?.();
    visibilityCleanupRef.current = null;

    if (activeSystemRef.current === "ssrc")
      activeSystemRef.current = null;
  }

  useEffect(() => {
    if (!HAS_SSRC || !pcsRef) return;

    const pcs = pcsRef.current ?? {};
    const trackListeners = new Map();

    for (const [peerId, pc] of Object.entries(pcs)) {
      if (!pc) continue;

      registerReceiver(peerId, pc);

      const onTrack = () => registerReceiver(peerId, pc);

      pc.addEventListener("track", onTrack);
      trackListeners.set(pc, { onTrack });
    }

    if (Object.keys(receiversRef.current).length)
      startSSRCLoop();

    return () => {
      for (const [pc, { onTrack }] of trackListeners) {
        pc.removeEventListener("track", onTrack);
      }
      stopSSRCLoop();
    };
  }, [pcsVersion]);

  function ensureAudioContext() {
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (
          window.AudioContext ||
          window.webkitAudioContext
        )();
      } catch { }
    }
    return audioContextRef.current;
  }

  function removeAnalyzerById(id) {
    const entry = analyzersRef.current[id];
    if (!entry) return;

    try {
      entry.source.disconnect();
    } catch { }

    try {
      entry.analyser.disconnect();
    } catch { }

    delete analyzersRef.current[id];
    delete lastSpokeRef.current[id];
    delete lastLevelsRef.current[id];
    delete speakerScoresRef.current[id];
    delete noiseFloorRef.current[id];
  }

  function startRMSLoop() {
    if (rafRunningRef.current) return;
    if (activeSystemRef.current === "ssrc") return;

    activeSystemRef.current = "rms";
    rafRunningRef.current = true;

    let lastRun = 0;

    const step = (ts) => {
      if (!rafRunningRef.current) return;

      const entries = Object.entries(analyzersRef.current);

      if (!entries.length) {
        stopRMSLoop();
        return;
      }

      if (ts - lastRun >= RMS_INTERVAL && !document.hidden) {
        lastRun = ts;

        const now = performance.now();
        const levelMap = {};
        const activePeerIds = new Set(
          entries.map(([id]) => id)
        );

        for (const [id, entry] of entries) {
          const track = entry.track;

          const isMutedFromSignal =
            participantsMapRef.current[id]?.muted === true;

          if (
            !track ||
            track.readyState === "ended" ||
            track.muted === true ||
            track.enabled === false ||
            isMutedFromSignal
          ) {
            speakerScoresRef.current[id] = 0;
            lastLevelsRef.current[id] = 0;
            levelMap[id] = 0;
            continue;
          }

          try {
            entry.analyser.getFloatTimeDomainData(entry.data);
            const rms = computeRMS(entry.data);
            levelMap[id] = rms;
          } catch { }
        }

        pruneRefs(activePeerIds);
        updateSpeakerScores(levelMap, now);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
  }

  function stopRMSLoop() {
    if (!rafRunningRef.current) return;

    rafRunningRef.current = false;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (activeSystemRef.current === "rms")
      activeSystemRef.current = null;
  }

  const createAnalyzerForStream = useCallback((id, stream) => {
    if (HAS_SSRC) return;

    if (!stream || !stream.getAudioTracks?.().length) {
      removeAnalyzerById(id);
      return;
    }

    const existing = analyzersRef.current[id];

    if (existing?.stream === stream) return;
    if (existing) removeAnalyzerById(id);

    const ctx = ensureAudioContext();
    if (!ctx) return;

    try {
      const track = stream.getAudioTracks()[0];

      if (!track || track.readyState === "ended") return;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();

      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.8;

      source.connect(analyser);

      analyzersRef.current[id] = {
        stream,
        track,
        source,
        analyser,
        data: new Float32Array(analyser.fftSize),
      };

      startRMSLoop();
    } catch { }
  }, []);

  const removeAnalyzer = useCallback((id) => {
    removeAnalyzerById(id);
    if (!Object.keys(analyzersRef.current).length)
      stopRMSLoop();
  }, []);

  useEffect(() => {
    if (HAS_SSRC) return;

    for (const [id, stream] of Object.entries(
      remoteStreams || {}
    )) {
      createAnalyzerForStream(id, stream);
    }
  }, [remoteStreams, createAnalyzerForStream]);

  useEffect(() => {
    if (HAS_SSRC) return;

    if (localStream)
      createAnalyzerForStream("local", localStream);
    else if (localStreamRef?.current)
      createAnalyzerForStream(
        "local",
        localStreamRef.current
      );
  }, [localStream, createAnalyzerForStream]);

  useEffect(() => {
    return () => {
      stopRMSLoop();
      stopSSRCLoop();

      for (const id of Object.keys(analyzersRef.current)) {
        removeAnalyzerById(id);
      }

      const ctx = audioContextRef.current;

      if (ctx && ctx.state !== "closed") {
        ctx.close().catch(() => { });
        audioContextRef.current = null;
      }
    };
  }, []);

  return {
    activeSpeakerId,
    createAnalyzerForStream,
    removeAnalyzer,
    notifyPcsChanged,
  };
}