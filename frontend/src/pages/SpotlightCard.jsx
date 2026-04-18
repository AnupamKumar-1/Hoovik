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
    meta?.name ?? emotion?.__name ?? emotion?.name ??
    emotion?.displayName ?? emotion?.display_name ?? null;
  if (raw && typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof id === "string" && id.length > 0) return id.slice(0, 6);
  return "Unknown";
}

function getLiveVideoTrack(stream) {
  return stream?.getVideoTracks?.().find((t) => t.readyState === "live") ?? null;
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
  id, stream, meta, emotion,
  isActive = false, isHost = false,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
  renderEmotionBadgeForId, style,
}) {
  const videoRef = useRef(null);
  const unmountedRef = useRef(false);
  const pollRef = useRef(null);
  const cleanupRef = useRef([]);

  const name = useMemo(() => deriveName(meta, emotion, id), [meta, emotion, id]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);

  const [videoActive, setVideoActive] = useState(false);
  const [debouncedIsActive, setDebouncedIsActive] = useState(isActive);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!unmountedRef.current) setDebouncedIsActive(isActive);
    }, 120);
    return () => clearTimeout(t);
  }, [isActive]);

  const safeSetActive = useCallback((v) => {
    if (!unmountedRef.current) setVideoActive(v);
  }, []);


  const sync = useCallback(() => {
    const el = videoRef.current;
    if (!el || !stream) return;

    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => { });
    }
    const hasVideo = !!getLiveVideoTrack(stream);
    safeSetActive(hasVideo);
  }, [stream, safeSetActive]);

  useEffect(() => {

    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];

    const el = videoRef.current;

    if (!stream) {
      safeSetActive(false);
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
      return;
    }


    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => { });
    }

    const hasVideo = !!getLiveVideoTrack(stream);
    safeSetActive(hasVideo);

    const onTrackEvent = () => sync();
    stream.addEventListener("addtrack", onTrackEvent);
    stream.addEventListener("removetrack", onTrackEvent);
    cleanupRef.current.push(() => {
      stream.removeEventListener("addtrack", onTrackEvent);
      stream.removeEventListener("removetrack", onTrackEvent);
    });


    const vt = getLiveVideoTrack(stream);
    if (vt) {
      const onMute = () => safeSetActive(!!getLiveVideoTrack(stream));
      const onUnmute = () => { sync(); safeSetActive(true); };
      const onEnded = () => safeSetActive(!!getLiveVideoTrack(stream));
      vt.addEventListener("mute", onMute);
      vt.addEventListener("unmute", onUnmute);
      vt.addEventListener("ended", onEnded);
      cleanupRef.current.push(() => {
        vt.removeEventListener("mute", onMute);
        vt.removeEventListener("unmute", onUnmute);
        vt.removeEventListener("ended", onEnded);
      });
    }

    // Poll as fallback — covers late-arriving tracks and renegotiation
    // 160 × 250ms = 40s
    let attempts = 0;
    pollRef.current = setInterval(() => {
      if (unmountedRef.current) { clearInterval(pollRef.current); return; }
      attempts++;
      sync();
      if (getLiveVideoTrack(stream) || attempts >= 160) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 250);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
  }, [stream, sync, safeSetActive]);

  // Cleanup video element on unmount
  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
    };
  }, []);

  const rootClassName = useMemo(
    () => [styles.spotlight, debouncedIsActive ? styles.speaking : ""].filter(Boolean).join(" "),
    [debouncedIsActive]
  );

  const rootStyle = useMemo(() => ({
    position: "relative", overflow: "hidden",
    width: "100%", height: "100%",
    borderRadius: 14, boxSizing: "border-box", ...style,
  }), [style]);

  const emotionBadge = useMemo(() =>
    (isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId
      ? renderEmotionBadgeForId(id) : null,
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
          width: "100%", height: "100%",
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
                width: 72, height: 72, fontSize: "1.7rem",
                background: avatarColor.bg, boxShadow: avatarColor.glow,
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