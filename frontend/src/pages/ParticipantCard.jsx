import React, {
  useRef,
  useState,
  forwardRef,
  useMemo,
} from "react";
import { motion } from "framer-motion";
import styles from "../styles/videoComponent.module.css";
import {
  WAVE_DELAYS,
  getAvatarColor,
  deriveName,
  safePlay,
  useVideoStream,
} from "./videoShared";

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
  const [videoActive, setVideoActive] = useState(false);

  const name = useMemo(() => deriveName(meta, emotion, peerId), [meta, emotion, peerId]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  useVideoStream({ videoRef, stream, setVideoActive });

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