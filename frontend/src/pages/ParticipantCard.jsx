import React, { useEffect, useRef, useState } from "react";
import styles from "../styles/videoComponent.module.css";
import { FaUserAlt } from "react-icons/fa";
import { motion } from "framer-motion";

function ParticipantCard({
  peerId,
  stream,
  compact = false,
  style = {},
  meta,
  emotion,
  isActive,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
  renderEmotionBadgeForId,
}) {
  const videoRef = useRef(null);
  const [videoActive, setVideoActive] = useState(true);

  const name =
    meta?.name ||
    emotion?.name ||
    emotion?.displayName ||
    emotion?.display_name ||
    peerId?.slice(0, 6) ||
    "Unknown";

  const videoTrack = stream?.getVideoTracks?.().find(
    (t) => t.readyState === "live"
  );
  const hasVideoTrack = !!videoTrack;
  const showVideo = hasVideoTrack && videoActive;

  // clear srcObject when stream or video state changes
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (hasVideoTrack && videoActive) {
      if (el.srcObject !== stream) {
        try {
          el.srcObject = stream;
        } catch (err) {
          console.warn("Failed to assign srcObject on participant video", err);
        }
      }
    } else {
      if (el.srcObject) {
        try {
          el.srcObject = null;
        } catch (err) {
          console.warn("Failed to clear srcObject on participant video", err);
        }
      }
    }
  }, [stream, hasVideoTrack, videoActive]);

  // Track mute - unmute - ended events to toggle videoActive
  useEffect(() => {
    if (!videoTrack) {
      setVideoActive(false);
      return;
    }

    setVideoActive(true);

    const handleMute = () => setVideoActive(false);
    const handleUnmute = () => setVideoActive(true);
    const handleEnded = () => setVideoActive(false);

    videoTrack.onmute = handleMute;
    videoTrack.onunmute = handleUnmute;
    videoTrack.onended = handleEnded;

    return () => {
      videoTrack.onmute = null;
      videoTrack.onunmute = null;
      videoTrack.onended = null;
    };
  }, [videoTrack]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className={`${styles.participantCard} ${compact ? styles.participantCardCompact : ""
        } ${isActive ? styles.participantCardSpeaking : ""}`}
      title={name}
      style={{
        width: compact ? 160 : "100%",
        height: compact ? 90 : "100%",
        aspectRatio: compact ? "16/9" : undefined,
        outline: isActive ? "3px solid #2ecc71" : "none",
        boxSizing: "border-box",
        transition: "outline 160ms ease",
        ...style,
      }}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          style={{ width: "100%", height: "100%", objectFit: "cover"  }}
        />
      ) : (
        <div className={styles.cameraOffPlaceholder}>
          <div style={{ textAlign: "center" }}>
            {name?.[0] ? (
              <span style={{ fontSize: compact ? 18 : 36 }}>
                {name[0].toUpperCase()}
              </span>
            ) : (
              <FaUserAlt size={compact ? 14 : 28} />
            )}
            {!compact && (
              <div style={{ marginTop: 6, fontSize: 13 }}>
                {name} · Camera off
              </div>
            )}
          </div>
        </div>
      )}

      <div className={styles.participantOverlay}>
        <div className={styles.namePill}>
          <FaUserAlt />
          <span>{name}</span>
        </div>
      </div>

      {(isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) &&
        renderEmotionBadgeForId?.(peerId)}
    </motion.div>
  );
}

function areEqual(prev, next) {
  return (
    prev.peerId === next.peerId &&
    prev.stream === next.stream &&
    prev.meta === next.meta &&
    prev.emotion === next.emotion &&
    prev.isActive === next.isActive &&
    prev.isHost === next.isHost &&
    prev.compact === next.compact
  );
}

export default React.memo(ParticipantCard, areEqual);
