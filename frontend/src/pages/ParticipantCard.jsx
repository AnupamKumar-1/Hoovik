import React, {
  useEffect,
  useRef,
  useState,
  forwardRef,
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
  const idx = (initial?.charCodeAt(0) ?? 0) % AVATAR_PALETTES.length;
  return AVATAR_PALETTES[idx];
}

function deriveName(meta, emotion, peerId) {
  const raw =
    meta?.name ?? emotion?.__name ?? emotion?.name ??
    emotion?.displayName ?? emotion?.display_name ?? null;
  if (raw && typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof peerId === "string" && peerId.length > 0) return peerId.slice(0, 6);
  return "Unknown";
}

function hasLiveVideoTrack(stream) {
  return !!stream?.getVideoTracks?.().find((t) => t.readyState === "live");
}

const WAVE_DELAYS = [0.55, 0.4, 0.7, 0.5, 0.62, 0.48, 0.75];

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
      stroke="rgba(255,255,255,0.65)" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function safePlay(el) {
  if (!el) return;
  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      setTimeout(() => {
        const p2 = el.play();
        if (p2 && typeof p2.catch === "function") p2.catch(() => { });
      }, 300);
    });
  }
}

const ParticipantCard = forwardRef(({
  peerId, stream, compact = false, style = {},
  meta, emotion, isActive = false, isHost = false,
  showStatusBar, DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
  renderEmotionBadgeForId, onClick,
}, ref) => {
  const videoRef = useRef(null);
  const unmountedRef = useRef(false);
  const pollRef = useRef(null);
  const streamRef = useRef(null);
  const cleanupFnsRef = useRef([]);

  const name = useMemo(() => deriveName(meta, emotion, peerId), [meta, emotion, peerId]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  const [videoActive, setVideoActive] = useState(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  const safeSetActive = useCallback((v) => {
    if (!unmountedRef.current) setVideoActive(v);
  }, []);

  const syncVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      safePlay(el);
    }
    const hasVideo = hasLiveVideoTrack(stream);
    safeSetActive(hasVideo);
    if (!hasVideo) {
      setTimeout(() => {
        if (unmountedRef.current || streamRef.current !== stream) return;
        safeSetActive(hasLiveVideoTrack(stream));
      }, 500);
    }
  }, [stream, safeSetActive]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    cleanupFnsRef.current.forEach((fn) => fn());
    cleanupFnsRef.current = [];

    streamRef.current = stream;
    const el = videoRef.current;

    if (!stream) {
      safeSetActive(false);
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
      return;
    }

    syncVideo();

    const onAddTrack = () => {
      if (streamRef.current !== stream) return;
      syncVideo();
    };
    const onRemoveTrack = () => {
      if (streamRef.current !== stream) return;
      safeSetActive(hasLiveVideoTrack(stream));
    };
    stream.addEventListener("addtrack", onAddTrack);
    stream.addEventListener("removetrack", onRemoveTrack);
    cleanupFnsRef.current.push(() => {
      stream.removeEventListener("addtrack", onAddTrack);
      stream.removeEventListener("removetrack", onRemoveTrack);
    });

    const vt = stream.getVideoTracks().find((t) => t.readyState === "live");
    if (vt) {
      const onMute = () => {
        if (streamRef.current !== stream) return;
        safeSetActive(hasLiveVideoTrack(stream));
      };
      const onUnmute = () => {
        if (streamRef.current !== stream) return;
        syncVideo();
      };
      const onEnded = () => {
        if (streamRef.current !== stream) return;
        safeSetActive(hasLiveVideoTrack(stream));
      };
      vt.addEventListener("mute", onMute);
      vt.addEventListener("unmute", onUnmute);
      vt.addEventListener("ended", onEnded);
      cleanupFnsRef.current.push(() => {
        vt.removeEventListener("mute", onMute);
        vt.removeEventListener("unmute", onUnmute);
        vt.removeEventListener("ended", onEnded);
      });
    }

    let attempts = 0;
    pollRef.current = setInterval(() => {
      if (unmountedRef.current || streamRef.current !== stream) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      attempts++;
      const el2 = videoRef.current;
      
      if (el2 && el2.srcObject !== stream) {
        el2.srcObject = stream;
        safePlay(el2);
      }
      const hasVideo = hasLiveVideoTrack(stream);
      safeSetActive(hasVideo);
      if (hasVideo || attempts >= 160) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 250);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      cleanupFnsRef.current.forEach((fn) => fn());
      cleanupFnsRef.current = [];
    };
  }, [stream, syncVideo, safeSetActive]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const el = videoRef.current;
      const s = streamRef.current;
      if (!el || !s) return;
      if (el.srcObject !== s) el.srcObject = s;
      safePlay(el);
      safeSetActive(hasLiveVideoTrack(s));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [safeSetActive]);

  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
    };
  }, []);

  const renderStatusBar = showStatusBar !== undefined ? showStatusBar : !compact && isActive;

  const cardClasses = [
    styles.participantCard,
    compact ? styles.participantCardCompact : "",
    isActive ? styles.participantCardSpeaking : "",
  ].filter(Boolean).join(" ");

  const cardStyle = useMemo(() => ({
    position: "relative", overflow: "hidden", boxSizing: "border-box",
    cursor: onClick ? "pointer" : undefined,
    ...(compact
      ? { width: 160, height: 90, borderRadius: 10 }
      : { width: "100%", height: "100%", borderRadius: 14 }),
    ...style,
  }), [compact, style, onClick]);

  const emotionBadge = useMemo(() => {
    if ((isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId)
      return renderEmotionBadgeForId(peerId);
    return null;
  }, [peerId, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]);

  return (
    <motion.div
      ref={ref}
      layout={false}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className={cardClasses}
      title={name}
      style={cardStyle}
      onClick={onClick}
    >
      {isActive && <div className={styles.speakingRingOverlay} />}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "100%", height: "100%",
          objectFit: "cover",
          display: videoActive ? "block" : "none",
          minWidth: 0, minHeight: 0,
        }}
      />

      {!videoActive && (
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
          </div>
        </div>
      )}

      <div className={[styles.namePill, compact ? styles.namePillCompact : ""].join(" ")}>
        <span className={styles.namePillIcon}><UserIcon /></span>
        <span className={styles.namePillText}>{name}</span>
        {isActive && <span className={styles.namePillSpeakerDot} />}
      </div>

      {renderStatusBar && (
        <div className={styles.activeSpeakerBar}>
          <span className={styles.activeSpeakerLiveDot} />
          <span className={styles.activeSpeakerLabel}>Active Speaker</span>
          <WaveBars />
        </div>
      )}

      {emotionBadge}
    </motion.div>
  );
});

ParticipantCard.displayName = "ParticipantCard";
export default React.memo(ParticipantCard);