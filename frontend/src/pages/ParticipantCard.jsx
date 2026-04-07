
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
  { bg: "linear-gradient(135deg,#0ea5e9,#38bdf8)", glow: "0 0 22px rgba(14,165,233,0.38)" },
  { bg: "linear-gradient(135deg,#7c3aed,#a78bfa)", glow: "0 0 22px rgba(124,58,237,0.38)" },
  { bg: "linear-gradient(135deg,#d97706,#fbbf24)", glow: "0 0 22px rgba(217,119,6,0.38)" },
  { bg: "linear-gradient(135deg,#059669,#34d399)", glow: "0 0 22px rgba(5,150,105,0.38)" },
  { bg: "linear-gradient(135deg,#db2777,#f472b6)", glow: "0 0 22px rgba(219,39,119,0.38)" },
  { bg: "linear-gradient(135deg,#dc2626,#f87171)", glow: "0 0 22px rgba(220,38,38,0.32)" },
];

function getAvatarColor(initial) {
  const idx = ((initial?.charCodeAt(0) ?? 0) % AVATAR_PALETTES.length);
  return AVATAR_PALETTES[idx];
}

function deriveName(meta, emotion, peerId) {
  const raw =
    meta?.name ??
    emotion?.__name ??
    emotion?.name ??
    emotion?.displayName ??
    emotion?.display_name ??
    null;
  if (raw && typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof peerId === "string" && peerId.length > 0) return peerId.slice(0, 6);
  return "Unknown";
}

function isValidStream(s) {
  return !!s && typeof s.getVideoTracks === "function";
}

function getLiveVideoTrack(s) {
  if (!isValidStream(s)) return null;
  return s.getVideoTracks().find((t) => t.readyState === "live") ?? null;
}

function isTrackActive(t) {
  return !!t && t.readyState === "live" && !t.muted;
}

const WAVE_DELAYS = [0.55, 0.40, 0.70, 0.50, 0.62, 0.48, 0.75];

function WaveBars() {
  return (
    <div className={styles.waveBars} aria-hidden="true">
      {WAVE_DELAYS.map((d, i) => (
        <span key={i} className={styles.waveBar} style={{ animationDuration: `${d}s` }} />
      ))}
    </div>
  );
}

function UserIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
      stroke="rgba(255,255,255,0.65)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function ParticipantCard({
  peerId,
  stream,
  compact = false,
  style = {},
  meta,
  emotion,
  isActive = false,
  isHost = false,
  showStatusBar,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
  renderEmotionBadgeForId,
}) {
  const videoRef = useRef(null);
  const unmountedRef = useRef(false);
  const lastStreamIdRef = useRef(null);

  const [videoActive, setVideoActive] = useState(false);

  const name = useMemo(() => deriveName(meta, emotion, peerId), [meta, emotion, peerId]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  const videoTrack = getLiveVideoTrack(stream);
  const showVideo = videoActive && Boolean(videoTrack);

  const safeSetVideoActive = useCallback((val) => {
    if (!unmountedRef.current) setVideoActive(val);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!videoTrack) {
      safeSetVideoActive(false);
      return;
    }

    safeSetVideoActive(isTrackActive(videoTrack));

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
  }, [videoTrack, safeSetVideoActive]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || unmountedRef.current) return;

    const currentStreamId = stream?.id;

    if (showVideo && isValidStream(stream)) {
      if (lastStreamIdRef.current !== currentStreamId) {
        try {
          el.srcObject = stream;
          lastStreamIdRef.current = currentStreamId;
        } catch {
          return;
        }
      }

      const p = el.play();
      if (p !== undefined) {
        p.catch(() => { });
      }
    } else if (el.srcObject) {
      try {
        el.pause();
        el.srcObject = null;
        lastStreamIdRef.current = null;
      } catch { }
    }
  }, [stream, showVideo]);

  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el) {
        try {
          el.pause();
          el.srcObject = null;
        } catch { }
      }
    };
  }, []);

  const renderStatusBar =
    showStatusBar !== undefined ? showStatusBar : !compact && isActive;

  const cardClasses = [
    styles.participantCard,
    compact ? styles.participantCardCompact : "",
    isActive ? styles.participantCardSpeaking : "",
  ].filter(Boolean).join(" ");

  const cardStyle = useMemo(() => ({
    position: "relative",
    overflow: "hidden",
    boxSizing: "border-box",
    ...(compact
      ? { width: 160, height: 90, borderRadius: 10 }
      : { width: "100%", height: "100%", borderRadius: 14 }),
    ...style,
  }), [compact, style]);

  const emotionBadge = useMemo(() => {
    if ((isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId) {
      return renderEmotionBadgeForId(peerId);
    }
    return null;
  }, [peerId, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]);

  return (
    <motion.div
      layout={false}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cardClasses}
      title={name}
      style={cardStyle}
      aria-label={`${name}${isActive ? ", active speaker" : ""}`}
    >
      {isActive && <div className={styles.speakingRingOverlay} aria-hidden="true" />}

      {showVideo && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          aria-label={`${name}'s video`}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}

      {!showVideo && (
        <div className={styles.cameraOffPlaceholder}>
          <div className={styles.avatarStack}>
            <div
              className={styles.avatarCircle}
              style={{
                width: compact ? 32 : 56,
                height: compact ? 32 : 56,
                fontSize: compact ? "0.85rem" : "1.3rem",
                background: avatarColor.bg,
                boxShadow: avatarColor.glow,
              }}
            >
              {initial}
            </div>
            {!compact && (
              <span className={styles.avatarPlaceholderName}>{name}</span>
            )}
          </div>
        </div>
      )}

      <div
        className={[styles.namePill, compact ? styles.namePillCompact : ""].filter(Boolean).join(" ")}
        aria-hidden="true"
      >
        <span className={styles.namePillIcon}><UserIcon /></span>
        <span className={styles.namePillText}>{name}</span>
        {isActive && <span className={styles.namePillSpeakerDot} />}
      </div>

      {renderStatusBar && (
        <div className={styles.activeSpeakerBar} aria-label={`${name} is the active speaker`}>
          <span className={styles.activeSpeakerLiveDot} aria-hidden="true" />
          <span className={styles.activeSpeakerLabel}>Active Speaker</span>
          <WaveBars />
        </div>
      )}

      {emotionBadge}
    </motion.div>
  );
}

function arePropsEqual(prev, next) {
  return (
    prev.peerId === next.peerId &&
    prev.stream === next.stream &&
    prev.isActive === next.isActive &&
    prev.isHost === next.isHost &&
    prev.compact === next.compact &&
    prev.showStatusBar === next.showStatusBar &&
    prev.meta?.name === next.meta?.name &&
    prev.meta?.userId === next.meta?.userId &&
    prev.emotion?.label === next.emotion?.label &&
    prev.emotion?.score === next.emotion?.score &&
    prev.DEBUG_SHOW_EMOTION_FOR_EVERYONE === next.DEBUG_SHOW_EMOTION_FOR_EVERYONE
  );
}

export default React.memo(ParticipantCard, arePropsEqual);