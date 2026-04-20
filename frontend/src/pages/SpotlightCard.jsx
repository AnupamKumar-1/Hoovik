

import React, {
  useEffect,
  useRef,
  useState,
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

function hasLiveVideoTrack(stream) {
  return !!stream?.getVideoTracks?.().find((t) => t.readyState === "live");
}

function safePlay(el) {
  if (!el) return;
  const p = el.play();
  if (p?.catch) p.catch(() => { });
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
  const resetRef = useRef(null);
  const cancelRef = useRef(null);

  const [videoActive, setVideoActive] = useState(false);
  const [debouncedIsActive, setDebouncedIsActive] = useState(isActive);

  const name = useMemo(() => deriveName(meta, emotion, id), [meta, emotion, id]);
  const initial = useMemo(() => (name[0] ?? "?").toUpperCase(), [name]);
  const avatarColor = useMemo(() => getAvatarColor(initial), [initial]);


  useEffect(() => {
    const t = setTimeout(() => setDebouncedIsActive(isActive), 400);
    return () => clearTimeout(t);
  }, [isActive]);


  const attach = useCallback(() => {
    const el = videoRef.current;
    const s = streamRef.current;
    if (!el || !s) return;
    if (el.srcObject !== s) el.srcObject = s;
    safePlay(el);
    setVideoActive(hasLiveVideoTrack(s));
  }, []);


  const startHardResetLoop = useCallback(() => {
    if (resetRef.current) { clearInterval(resetRef.current); resetRef.current = null; }

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

      try { el.pause(); } catch { }
      el.srcObject = null;

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
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
      return;
    }

    attach();
    startHardResetLoop();

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
      if (streamRef.current) startHardResetLoop();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [attach, startHardResetLoop, stopHardResetLoop]);


  useEffect(() => {
    return () => {
      stopHardResetLoop();
      const el = videoRef.current;
      if (el) { try { el.pause(); el.srcObject = null; } catch { } }
    };
  }, [stopHardResetLoop]);


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