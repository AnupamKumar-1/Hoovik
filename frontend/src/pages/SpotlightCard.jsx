import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import { motion } from "framer-motion";
import styles from "../styles/videoComponent.module.css";

const AVATAR_PALETTES = [
  { bg: "linear-gradient(135deg,#0ea5e9,#38bdf8)", glow: "0 0 28px rgba(14,165,233,0.38)" },
  { bg: "linear-gradient(135deg,#7c3aed,#a78bfa)", glow: "0 0 28px rgba(124,58,237,0.38)" },
  { bg: "linear-gradient(135deg,#d97706,#fbbf24)", glow: "0 0 28px rgba(217,119,6,0.38)" },
  { bg: "linear-gradient(135deg,#059669,#34d399)", glow: "0 0 28px rgba(5,150,105,0.38)" },
  { bg: "linear-gradient(135deg,#db2777,#f472b6)", glow: "0 0 28px rgba(219,39,119,0.38)" },
  { bg: "linear-gradient(135deg,#dc2626,#f87171)", glow: "0 0 28px rgba(220,38,38,0.32)" },
];

function getAvatarColor(initial) {
  const idx = (initial?.charCodeAt(0) ?? 0) % AVATAR_PALETTES.length;
  return AVATAR_PALETTES[idx];
}

function deriveName(meta, emotion, id) {
  const raw =
    meta?.name ??
    emotion?.__name ??
    emotion?.name ??
    emotion?.displayName ??
    emotion?.display_name ??
    null;
  if (raw && typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof id === "string" && id.length > 0) return id.slice(0, 6);
  return "Unknown";
}

function getLiveVideoTrack(stream) {
  return stream?.getVideoTracks?.().find((t) => t.readyState === "live") ?? null;
}

function isTrackActive(t) {
  return !!t && t.readyState === "live";
}

const WAVE_DELAYS = [0.55, 0.4, 0.7, 0.5, 0.62, 0.48, 0.75];

function SpotlightWaveBars() {
  return (
    <div className={styles.waveBars}>
      {WAVE_DELAYS.map((d, i) => (
        <span key={i} className={styles.waveBar} style={{ animationDuration: `${d}s` }} />
      ))}
    </div>
  );
}

function SpotlightCard({
  id,
  stream,
  meta,
  emotion,
  isActive = false,
  isHost = false,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
  renderEmotionBadgeForId,
  style,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const unmountedRef = useRef(false);
  const pollTimerRef = useRef(null);
  const trackCleanupRef = useRef([]);

  const name = useMemo(() => deriveName(meta, emotion, id), [meta, emotion, id]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  const [videoActive, setVideoActive] = useState(false);
  const [debouncedIsActive, setDebouncedIsActive] = useState(isActive);

  const safeSetVideoActive = useCallback((val) => {
    if (!unmountedRef.current) setVideoActive(val);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      trackCleanupRef.current.forEach((fn) => fn());
      trackCleanupRef.current = [];
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!unmountedRef.current) setDebouncedIsActive(isActive);
    }, 120);
    return () => clearTimeout(timer);
  }, [isActive]);

  const attachStream = useCallback((s) => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== s) {
      el.srcObject = s || null;
    }
    if (s) {
      const p = el.play();
      if (p) p.catch(() => { });
    } else {
      try { el.pause(); } catch { }
    }
  }, []);

  const attachVideoTrackListeners = useCallback((track, currentStream) => {
    const onMute = () => {
      if (streamRef.current !== currentStream) return;
      const stillLive = getLiveVideoTrack(currentStream);
      safeSetVideoActive(isTrackActive(stillLive));
    };
    const onUnmute = () => {
      if (streamRef.current !== currentStream) return;
      safeSetVideoActive(true);
      attachStream(currentStream);
    };
    const onEnded = () => {
      if (streamRef.current !== currentStream) return;
      const stillLive = getLiveVideoTrack(currentStream);
      safeSetVideoActive(isTrackActive(stillLive));
    };

    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);

    return () => {
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
    };
  }, [safeSetVideoActive, attachStream]);

  useEffect(() => {
    streamRef.current = stream;

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    trackCleanupRef.current.forEach((fn) => fn());
    trackCleanupRef.current = [];

    if (!stream) {
      safeSetVideoActive(false);
      attachStream(null);
      return;
    }

    attachStream(stream);

    const evalVideoActive = () => {
      const track = getLiveVideoTrack(stream);
      return isTrackActive(track);
    };

    const active = evalVideoActive();
    safeSetVideoActive(active);

    const videoTrack = getLiveVideoTrack(stream);
    if (videoTrack) {
      const cleanup = attachVideoTrackListeners(videoTrack, stream);
      trackCleanupRef.current.push(cleanup);
    }

    const onAddTrack = (evt) => {
      if (streamRef.current !== stream) return;

      if (evt.track && evt.track.kind === "video") {
        const newActive = isTrackActive(evt.track);
        safeSetVideoActive(newActive);
        if (newActive) attachStream(stream);

        const cleanup = attachVideoTrackListeners(evt.track, stream);
        trackCleanupRef.current.push(cleanup);
      }

      const currentActive = evalVideoActive();
      safeSetVideoActive(currentActive);
      if (currentActive) attachStream(stream);
    };

    const onRemoveTrack = () => {
      if (streamRef.current !== stream) return;
      safeSetVideoActive(evalVideoActive());
    };

    stream.addEventListener("addtrack", onAddTrack);
    stream.addEventListener("removetrack", onRemoveTrack);

    if (!active) {
      let attempts = 0;
      pollTimerRef.current = setInterval(() => {
        attempts++;
        if (streamRef.current !== stream || unmountedRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          return;
        }
        const nowActive = evalVideoActive();
        if (nowActive) {
          safeSetVideoActive(true);
          attachStream(stream);
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          return;
        }
        if (attempts >= 40) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }, 250);
    }

    return () => {
      stream.removeEventListener("addtrack", onAddTrack);
      stream.removeEventListener("removetrack", onRemoveTrack);
      trackCleanupRef.current.forEach((fn) => fn());
      trackCleanupRef.current = [];
    };
  }, [stream, safeSetVideoActive, attachStream, attachVideoTrackListeners]);

  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el) {
        try { el.pause(); el.srcObject = null; } catch { }
      }
    };
  }, []);

  const rootClassName = useMemo(
    () => [styles.spotlight, debouncedIsActive ? styles.speaking : ""].filter(Boolean).join(" "),
    [debouncedIsActive]
  );

  const rootStyle = useMemo(() => ({
    position: "relative",
    overflow: "hidden",
    width: "100%",
    height: "100%",
    borderRadius: 14,
    boxSizing: "border-box",
    ...style,
  }), [style]);

  const emotionBadge = useMemo(
    () =>
      (isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId
        ? renderEmotionBadgeForId(id)
        : null,
    [id, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]
  );

  return (
    <motion.div className={rootClassName} style={rootStyle}>
      {debouncedIsActive && <div className={styles.speakingRingOverlay} />}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: videoActive ? "block" : "none",
        }}
      />

      {!videoActive && (
        <div className={styles.cameraOffPlaceholder}>
          <div className={styles.avatarStack}>
            <div
              className={styles.avatarCircle}
              style={{
                width: 72,
                height: 72,
                fontSize: "1.7rem",
                background: avatarColor.bg,
                boxShadow: avatarColor.glow,
              }}
            >
              {initial}
            </div>
            <span>{name}</span>
          </div>
        </div>
      )}

      {debouncedIsActive && (
        <div className={styles.activeSpeakerBar}>
          <span className={styles.activeSpeakerLiveDot} />
          <span>Active Speaker</span>
          <SpotlightWaveBars />
        </div>
      )}

      {emotionBadge}
    </motion.div>
  );
}

export default React.memo(SpotlightCard);