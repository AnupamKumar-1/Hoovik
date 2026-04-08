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
  return !!t && t.readyState === "live" && !t.muted;
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
  const unmountedRef = useRef(false);

  const name = useMemo(() => deriveName(meta, emotion, id), [meta, emotion, id]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  const [videoActive, setVideoActive] = useState(() =>
    isTrackActive(getLiveVideoTrack(stream))
  );
  const [debouncedIsActive, setDebouncedIsActive] = useState(isActive);

  const showVideo = videoActive;

  const safeSetVideoActive = useCallback((val) => {
    if (!unmountedRef.current) setVideoActive(val);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!unmountedRef.current) setDebouncedIsActive(isActive);
    }, 120);
    return () => clearTimeout(timer);
  }, [isActive]);

  useEffect(() => {
    if (!stream) {
      safeSetVideoActive(false);
      return;
    }

    const sync = () => safeSetVideoActive(isTrackActive(getLiveVideoTrack(stream)));
    stream.addEventListener("addtrack", sync);
    stream.addEventListener("removetrack", sync);
    sync();

    return () => {
      stream.removeEventListener("addtrack", sync);
      stream.removeEventListener("removetrack", sync);
    };
  }, [stream, safeSetVideoActive]);

  useEffect(() => {
    const videoTrack = getLiveVideoTrack(stream);
    if (!videoTrack) return;

    const onMute = () => safeSetVideoActive(false);
    const onUnmute = () => safeSetVideoActive(true);
    const onEnded = () => safeSetVideoActive(false);

    videoTrack.addEventListener("mute", onMute);
    videoTrack.addEventListener("unmute", onUnmute);
    videoTrack.addEventListener("ended", onEnded);

    return () => {
      videoTrack.removeEventListener("mute", onMute);
      videoTrack.removeEventListener("unmute", onUnmute);
      videoTrack.removeEventListener("ended", onEnded);
    };
  }, [stream, safeSetVideoActive]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      if (el.srcObject !== stream) el.srcObject = stream;
      const p = el.play();
      if (p) p.catch(() => { });
    } else {
      el.srcObject = null;
    }
  }, [stream]);

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
          display: showVideo ? "block" : "none",
        }}
      />

      {!showVideo && (
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
          <span>Active Speaker</span>
          <SpotlightWaveBars />
        </div>
      )}

      {emotionBadge}
    </motion.div>
  );
}

export default React.memo(SpotlightCard);