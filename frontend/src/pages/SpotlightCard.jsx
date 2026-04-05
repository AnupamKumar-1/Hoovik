import React, { useEffect, useRef, useState } from "react";
import styles from "../styles/videoComponent.module.css";
import { FaUserAlt } from "react-icons/fa";
import { motion } from "framer-motion";

function SpotlightCard({
  id,
  stream,
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
    (emotion &&
      (emotion.__name ||
        emotion.name ||
        emotion.displayName ||
        emotion.display_name)) ||
    meta?.name ||
    (id ? id.slice(0, 6) : "Unknown");

  const isSpeaking = isActive;

  const videoTrack =
    stream?.getVideoTracks?.().find((t) => t.readyState === "live");

  const hasVideoTrack = !!videoTrack;

  const showVideo = hasVideoTrack && videoActive;

  // Attach stream to video element
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (hasVideoTrack && videoActive) {
      if (el.srcObject !== stream) {
        try {
          el.srcObject = stream;
        } catch (err) {
          console.warn("failed to assign srcObject on spotlight video", err);
        }
      }
    } else {
      if (el.srcObject) {
        try {
          el.srcObject = null;
        } catch (err) {
          console.warn("failed to clear srcObject on spotlight video", err);
        }
      }
    }
  }, [stream, hasVideoTrack, videoActive]);

  // Track-based detection (robust)
  useEffect(() => {
    if (!videoTrack) {
      setVideoActive(false);
      return;
    }

    // assume active initially
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
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className={`${styles.spotlight} ${
        isSpeaking ? styles.speaking : ""
      }`}
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 12,
        position: "relative",
        display: "flex",
        outline: isSpeaking ? "3px solid #2ecc71" : "none",
        boxSizing: "border-box",
        transition: "outline 160ms ease",
      }}
    >
      {showVideo ? (
        <video
          autoPlay
          playsInline
          ref={videoRef}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div className={styles.cameraOffPlaceholder}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 56 }}>
              {name && name[0]
                ? name[0].toUpperCase()
                : <FaUserAlt />}
            </div>
            <div style={{ marginTop: 8 }}>{name}</div>
            <div style={{ fontSize: 13 }}>Camera off</div>
          </div>
        </div>
      )}

      <div style={{ position: "absolute", left: 12, bottom: 12 }}>
        <div
          style={{
            background: "rgba(0,0,0,0.45)",
            color: "white",
            padding: "6px 10px",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 700,
          }}
        >
          <FaUserAlt />
          <span>{name}</span>
        </div>
      </div>

      {isSpeaking && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            background: "rgba(46,204,113,0.12)",
            color: "rgba(46,204,113,0.95)",
            padding: "6px 10px",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          Speaking
        </div>
      )}

      {(isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) &&
        renderEmotionBadgeForId?.(id)}
    </motion.div>
  );
}

function areEqual(prev, next) {
  return (
    prev.stream === next.stream &&
    prev.meta === next.meta &&
    prev.emotion === next.emotion &&
    prev.isActive === next.isActive
  );
}

export default React.memo(SpotlightCard, areEqual);