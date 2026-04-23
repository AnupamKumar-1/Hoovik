import { useRef, useState, useCallback, useEffect } from "react";
import { isRenderableVideo } from "./VideoMeet";

export const MAX_RESET_ATTEMPTS = 8;
export const RESET_CHECK_MS = 300;
export const RESET_GAP_MS = 80;

export const WAVE_DELAYS = [0.55, 0.4, 0.7, 0.5, 0.62, 0.48, 0.75];

export const AVATAR_PALETTES = [
    { bg: "linear-gradient(135deg,#0ea5e9,#38bdf8)", glow: "0 0 28px rgba(14,165,233,0.38)" },
    { bg: "linear-gradient(135deg,#7c3aed,#a78bfa)", glow: "0 0 28px rgba(124,58,237,0.38)" },
    { bg: "linear-gradient(135deg,#d97706,#fbbf24)", glow: "0 0 28px rgba(217,119,6,0.38)" },
    { bg: "linear-gradient(135deg,#059669,#34d399)", glow: "0 0 28px rgba(5,150,105,0.38)" },
    { bg: "linear-gradient(135deg,#db2777,#f472b6)", glow: "0 0 28px rgba(219,39,119,0.38)" },
    { bg: "linear-gradient(135deg,#dc2626,#f87171)", glow: "0 0 28px rgba(220,38,38,0.32)" },
];

export function getAvatarColor(initial) {
    const idx = (initial?.charCodeAt(0) ?? 0) % AVATAR_PALETTES.length;
    return AVATAR_PALETTES[idx];
}

export function deriveName(meta, emotion, id) {
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

export function hasLiveVideoTrack(stream) {
    return !!stream?.getVideoTracks?.().find((t) => t.readyState === "live");
}

export function safePlay(el) {
    if (!el) return;
    const p = el.play();
    if (p?.catch) p.catch(() => { });
}

export function useVideoStream({ videoRef, stream, setVideoActive }) {
    const streamRef = useRef(null);
    const resetRef = useRef(null);
    const cancelRef = useRef(null);

    const stopHardResetLoop = useCallback(() => {
        if (resetRef.current) { clearInterval(resetRef.current); resetRef.current = null; }
        if (cancelRef.current) { clearTimeout(cancelRef.current); cancelRef.current = null; }
    }, []);

    const attach = useCallback(() => {
        const el = videoRef.current;
        const s = streamRef.current;
        if (!el || !s) return;
        if (el.srcObject !== s) el.srcObject = s;
        safePlay(el);
        setVideoActive(hasLiveVideoTrack(s));
    }, [videoRef, setVideoActive]);

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
    }, [videoRef, setVideoActive]);

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
                try { vt.enabled = false; vt.enabled = true; } catch { }
            }
            stopHardResetLoop();
            attach();
            startHardResetLoop();
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
    }, [stream, attach, startHardResetLoop, stopHardResetLoop, videoRef, setVideoActive]);

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
    }, [stopHardResetLoop, videoRef]);
}