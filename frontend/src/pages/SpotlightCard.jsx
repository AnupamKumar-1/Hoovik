import React, {
  useRef,
  useState,
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
  const [videoActive, setVideoActive] = useState(false);
  const [debouncedIsActive, setDebouncedIsActive] = useState(isActive);

  const name = useMemo(() => deriveName(meta, emotion, id), [meta, emotion, id]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedIsActive(isActive), 400);
    return () => clearTimeout(t);
  }, [isActive]);

  useVideoStream({ videoRef, stream, setVideoActive });

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

  const emotionBadge = useMemo(() => {
    if ((isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId) {
      return renderEmotionBadgeForId(id);
    }
    return null;
  }, [id, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]);

  return (
    <motion.div className={rootClassName} style={rootStyle}>
      {debouncedIsActive && <div className={styles.speakingRingOverlay} />}

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