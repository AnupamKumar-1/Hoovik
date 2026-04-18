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

function hasLiveVideoTrack(stream) {
  return !!stream?.getVideoTracks?.().find((t) => t.readyState === "live");
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

function SpotlightCard({
  id, stream, meta, emotion,
  isActive = false, isHost = false,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
  renderEmotionBadgeForId, style,
}) {
  const videoRef = useRef(null);
  const unmountedRef = useRef(false);
  const pollRef = useRef(null);
  const streamRef = useRef(null);
  const cleanupFnsRef = useRef([]);

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
    // Clear previous state
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

    // Watch existing video track for mute/end events
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

    // Poll as fallback — critical for mobile where events are unreliable.
    // 160 × 250ms = 40 seconds total.
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
      if (el.srcObject !== s) { el.srcObject = s; }
      safePlay(el);
      safeSetActive(hasLiveVideoTrack(s));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [safeSetActive]);

  // Cleanup on unmount
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

  const emotionBadge = useMemo(
    () => (isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && renderEmotionBadgeForId
      ? renderEmotionBadgeForId(id) : null,
    [id, isHost, DEBUG_SHOW_EMOTION_FOR_EVERYONE, renderEmotionBadgeForId]
  );

  return (
    <motion.div className={rootClassName} style={rootStyle}>
      {debouncedIsActive && <div className={styles.speakingRingOverlay} />}

      {/* 
        MOBILE CRITICAL ATTRIBUTES:
        - autoPlay: needed for all browsers
        - playsInline: REQUIRED for iOS — without this, Safari forces fullscreen
        - muted: NOT set here (remote stream needs audio)
          iOS Safari allows autoplay of unmuted media only if user interacted first.
          Since joining the call is a user gesture, this works correctly.
      */}
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