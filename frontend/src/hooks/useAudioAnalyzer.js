import { useRef, useState, useEffect } from "react";

export default function useAudioAnalyzer({
  remoteStreams,
  localStreamRef,
  mutedRef,
  pcsRef,
}) {
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);
  const activeSpeakerIdRef = useRef(activeSpeakerId);

  const audioContextRef = useRef(null);
  const analyzersRef = useRef({});
  const rafRef = useRef(null);
  const statsIntervalRef = useRef(null);

  const lastRunRef = useRef(0);
  const lastSpokeRef = useRef({});
  const lastLevelsRef = useRef({});

  useEffect(() => {
    activeSpeakerIdRef.current = activeSpeakerId;
  }, [activeSpeakerId]);

  const supportsAudioLevel = () => {
    return typeof RTCPeerConnection !== "undefined";
  };

 useEffect(() => {
  if (!pcsRef || !supportsAudioLevel()) return;

  const INTERVAL = 300;
   const THRESHOLD = 0.025;
  const HOLD = 1500;

  let running = true;

  statsIntervalRef.current = setInterval(async () => {
    if (!running) return;
    running = false;

    const now = Date.now();

    let maxLevel = 0;
    let activeId = null;

    const entries = Object.entries(pcsRef.current || {});

    for (const [peerId, pc] of entries) {
      if (!pc) continue;

      try {
        const stats = await pc.getStats();

        for (const report of stats.values()) {
          if (
            report.type === "inbound-rtp" &&
            report.kind === "audio"
          ) {
            const level = report.audioLevel;
            if (level == null) continue;

            const prev = lastLevelsRef.current[peerId] || 0;
            const smooth = prev * 0.7 + level * 0.3;
            lastLevelsRef.current[peerId] = smooth;

            if (smooth > THRESHOLD) {
              lastSpokeRef.current[peerId] = now;
            }

            if (smooth > maxLevel) {
              maxLevel = smooth;
              activeId = peerId;
            }
          }
        }
      } catch (err) {
        console.warn("getStats failed", err);
      }
    }


    if (activeId === "local" && mutedRef?.current) {
      activeId = null;
    }

    const current = activeSpeakerIdRef.current;


    if (
      activeId &&
      now - (lastSpokeRef.current[activeId] || 0) <= HOLD
    ) {
      if (activeId !== current) {
        setActiveSpeakerId(activeId);
      }
    } else {
      if (
        current &&
        now - (lastSpokeRef.current[current] || 0) > HOLD
      ) {
        setActiveSpeakerId(null);
      }
    }

    running = true;
  }, INTERVAL);

  return () => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    running = false;
  };
}, [pcsRef, mutedRef]);


  function ensureAudioContext() {
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (window.AudioContext ||
          window.webkitAudioContext)();
      } catch {}
    }
    return audioContextRef.current;
  }

  function streamHasAudio(stream) {
    try {
      return stream?.getAudioTracks?.().length > 0;
    } catch {
      return false;
    }
  }

  function computeRMS(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i] * arr[i];
    }
    return Math.sqrt(sum / arr.length);
  }

  function createAnalyzerForStream(id, stream) {
    if (!stream || !streamHasAudio(stream)) {
      removeAnalyzer(id);
      return;
    }

    const ctx = ensureAudioContext();
    if (!ctx) return;

    const existing = analyzersRef.current[id];
    if (existing && existing.stream === stream) return;

    if (existing) {
      try { existing.source.disconnect(); } catch {}
      try { existing.analyser.disconnect(); } catch {}
    }

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();

      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;

      source.connect(analyser);

      const data = new Float32Array(analyser.fftSize);

      analyzersRef.current[id] = {
        stream,
        source,
        analyser,
        data,
        lastSpokeAt: 0,
      };

      if (!rafRef.current) startRMSLoop();
    } catch {}
  }

  function removeAnalyzer(id) {
    const entry = analyzersRef.current[id];
    if (!entry) return;

    try { entry.source.disconnect(); } catch {}
    try { entry.analyser.disconnect(); } catch {}

    delete analyzersRef.current[id];
  }

  function startRMSLoop() {
    const THRESHOLD = 0.02;
    const CHECK_INTERVAL = 250;

    const step = () => {
      const now = Date.now();

      if (now - lastRunRef.current < CHECK_INTERVAL) {
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      lastRunRef.current = now;

      let max = 0;
      let activeId = null;

      for (const [id, entry] of Object.entries(analyzersRef.current)) {
        try {
          entry.analyser.getFloatTimeDomainData(entry.data);
          const rms = computeRMS(entry.data);

          if (rms > THRESHOLD && rms > max) {
            max = rms;
            activeId = id;
          }
        } catch {}
      }

      if (activeId === "local" && mutedRef?.current) {
        activeId = null;
      }

      if (activeId !== activeSpeakerIdRef.current) {
        setActiveSpeakerId(activeId);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
  }

  useEffect(() => {
    if (supportsAudioLevel()) return;

    Object.entries(remoteStreams || {}).forEach(([id, stream]) => {
      createAnalyzerForStream(id, stream);
    });

    if (localStreamRef?.current) {
      createAnalyzerForStream("local", localStreamRef.current);
    }
  }, [remoteStreams]);

  return {
    activeSpeakerId,
    createAnalyzerForStream,
    removeAnalyzer,
  };
}