import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    FaMicrophone, FaMicrophoneSlash,
    FaVideo, FaVideoSlash,
} from "react-icons/fa";
import s from "../styles/videoComponent.module.css";

export default function MeetLocalPreview({
    localVideoRef, displayName, isHost, isSpeaking,
    muted, videoOff, shareEmotion, emotionLive, chatOpen,
    onToggleMute, onToggleVideo, onToggleEmotion,
}) {
    const [showControls, setShowControls] = useState(false);

    const handleTap = useCallback(() => {
        setShowControls(v => !v);
    }, []);

    return (
        <motion.div
            className={`${s.localPreview} ${isSpeaking ? s.localPreviewSpeaking : ""}`}
            initial={{ opacity: 0, scale: 0.9, y: 10, x: 0 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: chatOpen ? -335 : 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            drag
            dragMomentum={false}
            dragElastic={0.05}
            whileDrag={{ scale: 1.03, cursor: "grabbing" }}
            onClick={handleTap}
            aria-label="Your local video"
            title="Tap to show controls"
        >
            <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={s.localVideo}
                aria-label="Your local video"
            />
            {emotionLive && (
                <div className={s.emotionLiveBadge} aria-label="AI emotion analysis is active">
                    <span className={s.emotionLiveDot} />
                    AI Analysis
                </div>
            )}

            <AnimatePresence>
                {showControls && (
                    <motion.div
                        className={s.localOverlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ opacity: 1 }}
                    >
                        <div className={s.localBadge}>
                            <span className={s.localBadgeName}>{displayName}</span>
                            {isHost && <span className={s.localBadgeHost}>Host</span>}
                        </div>
                        <div className={s.localControls}>
                            <button
                                className={`${s.localBtn} ${muted ? s.localBtnActive : ""}`}
                                onClick={(e) => { e.stopPropagation(); onToggleMute(); }}
                                aria-label={muted ? "Unmute" : "Mute"}
                            >
                                {muted ? <FaMicrophoneSlash size={10} /> : <FaMicrophone size={10} />}
                            </button>
                            <button
                                className={`${s.localBtn} ${videoOff ? s.localBtnActive : ""}`}
                                onClick={(e) => { e.stopPropagation(); onToggleVideo(); }}
                                aria-label={videoOff ? "Turn camera on" : "Turn camera off"}
                            >
                                {videoOff ? <FaVideoSlash size={10} /> : <FaVideo size={10} />}
                            </button>
                            {isHost && (
                                <button
                                    className={`${s.localBtn} ${shareEmotion ? s.localBtnEmotionActive : ""}`}
                                    onClick={(e) => { e.stopPropagation(); onToggleEmotion(); }}
                                    aria-label="Toggle emotion AI"
                                    style={{ fontSize: "10px" }}
                                >
                                    ✦
                                </button>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {isSpeaking && <div className={s.speakRing} />}

            {!showControls && (
                <div className={s.localStatusDots}>
                    {muted && (
                        <span className={s.localStatusBadge} aria-label="Muted">
                            <FaMicrophoneSlash size={8} />
                        </span>
                    )}
                    {videoOff && (
                        <span className={s.localStatusBadge} aria-label="Camera off">
                            <FaVideoSlash size={8} />
                        </span>
                    )}
                </div>
            )}
        </motion.div>
    );
}