

import React, {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useMemo,
  useCallback,
} from "react";
import { motion } from "framer-motion";
import { isRenderableVideo } from "./VideoMeet";
import styles from "../styles/videoComponent.module.css";


const MAX_RESET_ATTEMPTS = 8;
const RESET_CHECK_MS = 300;
const RESET_GAP_MS = 80;

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
  if (p?.catch) p.catch(() => { });
}


const ParticipantCard = forwardRef(({
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
  onClick,
}, ref) => {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const resetRef = useRef(null);
  const cancelRef = useRef(null);

  const [videoActive, setVideoActive] = useState(false);

  const name = useMemo(() => deriveName(meta, emotion, peerId), [meta, emotion, peerId]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);


  const attach = useCallback(() => {
    const el = videoRef.current;
    const s = streamRef.current;
    if (!el || !s) return;

    if (el.srcObject !== s) {
      el.srcObject = s;
    }
    safePlay(el);
    setVideoActive(hasLiveVideoTrack(s));
  }, []);

  const startHardResetLoop = useCallback((s) => {
    if (resetRef.current) {
      clearInterval(resetRef.current);
      resetRef.current = null;
    }

    let attempts = 0;

    resetRef.current = setInterval(() => {
      const el = videoRef.current;
      if (!el) { clearInterval(resetRef.current); return; }

      if (isRenderableVideo(el)) {
        clearInterval(resetRef.current);
        resetRef.current = null;
        return;
      }

      attempts++;
      if (attempts > MAX_RESET_ATTEMPTS) {
        clearInterval(resetRef.current);
        resetRef.current = null;
        return;
      }

      // Teardown
      try { el.pause(); } catch { }
      el.srcObject = null;

      // Re-attach after gap
      cancelRef.current = setTimeout(() => {
        const el2 = videoRef.current;
        const s2 = streamRef.current;
        if (!el2 || !s2) return;
        el2.srcObject = s2;
        safePlay(el2);
        setVideoActive(hasLiveVideoTrack(s2));
      }, RESET_GAP_MS);
    }, RESET_CHECK_MS);
  }, []);

  const stopHardResetLoop = useCallback(() => {
    if (resetRef.current) { clearInterval(resetRef.current); resetRef.current = null; }
    if (cancelRef.current) { clearTimeout(cancelRef.current); cancelRef.current = null; }
  }, []);


  useEffect(() => {
    streamRef.current = stream;
    stopHardResetLoop();

    const el = videoRef.current;

    if (!stream) {
      setVideoActive(false);
      if (el) {
        try { el.pause(); el.srcObject = null; } catch { }
      }
      return;
    }

    // Initial attach
    attach();

    startHardResetLoop(stream);

    const onTrackChange = () => {

      const s = streamRef.current;

      if (!s) return;

      const vt = s.getVideoTracks()[0];

      if (vt && vt.readyState === "live") {

        try {

          vt.enabled = false;
          vt.enabled = true;

        } catch { }

      }

      stopHardResetLoop();
      attach();
      startHardResetLoop(s);

    };

    const tracks = stream.getTracks();
    tracks.forEach((t) => {
      t.addEventListener("unmute", onTrackChange);
      t.addEventListener("ended", onTrackChange);
      t.addEventListener("mute", onTrackChange);
    });

    stream.addEventListener("addtrack", onTrackChange);
    stream.addEventListener("removetrack", onTrackChange);

    return () => {
      stopHardResetLoop();
      tracks.forEach((t) => {
        t.removeEventListener("unmute", onTrackChange);
        t.removeEventListener("ended", onTrackChange);
        t.removeEventListener("mute", onTrackChange);
      });
      stream.removeEventListener("addtrack", onTrackChange);
      stream.removeEventListener("removetrack", onTrackChange);
    };
  }, [stream, attach, startHardResetLoop, stopHardResetLoop]);


  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      stopHardResetLoop();
      attach();
      if (streamRef.current) startHardResetLoop(streamRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [attach, startHardResetLoop, stopHardResetLoop]);


  useEffect(() => {
    return () => {
      stopHardResetLoop();
      const el = videoRef.current;
      if (el) {
        try { el.pause(); el.srcObject = null; } catch { }
      }
    };
  }, [stopHardResetLoop]);

  const renderStatusBar = showStatusBar !== undefined ? showStatusBar : !compact && isActive;

  const cardClasses = [
    styles.participantCard,
    compact ? styles.participantCardCompact : "",
    isActive ? styles.participantCardSpeaking : "",
  ].filter(Boolean).join(" ");

  const cardStyle = useMemo(() => ({
    position: "relative",
    overflow: "hidden",
    boxSizing: "border-box",
    cursor: onClick ? "pointer" : undefined,
    ...(compact
      ? { width: 160, height: 90, borderRadius: 10 }
      : { width: "100%", height: "100%", borderRadius: 14 }),
    ...style,
  }), [compact, style, onClick]);

  const emotionBadge = useMemo(() => {
    if ((isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId) {
      return renderEmotionBadgeForId(peerId);
    }
    return null;
  }, [peerId, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]);

  return (
    <motion.div
      ref={ref}
      className={cardClasses}
      style={cardStyle}
      onClick={onClick}
      title={name}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2 }}
    >
      {isActive && <div className={styles.speakingRingOverlay} />}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={() => safePlay(videoRef.current)}
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