import React from "react";
import { motion } from "framer-motion";
import {
    FaMicrophone, FaMicrophoneSlash,
    FaVideo, FaVideoSlash,
} from "react-icons/fa";
import s from "../styles/videoComponent.module.css";

export default function MeetLocalPreview({
    localVideoRef, displayName, isHost, isSpeaking,
    muted, videoOff, shareEmotion,
    onToggleMute, onToggleVideo, onToggleEmotion,
}) {
    return (
        <motion.div
            className={`${s.localPreview} ${isSpeaking ? s.localPreviewSpeaking : ""}`}
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            drag
            dragMomentum={false}
            dragElastic={0.05}
            whileHover={{ scale: 1.02 }}
            whileDrag={{ scale: 1.03, cursor: "grabbing" }}
            aria-label="Your local video — drag to reposition"
            title="Your camera (drag to reposition)"
        >
            <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={s.localVideo}
                aria-label="Your local video"
            />
            <div className={s.localOverlay}>
                <div className={s.localBadge}>
                    <span className={s.localBadgeName}>{displayName}</span>
                    {isHost && <span className={s.localBadgeHost}>Host</span>}
                </div>
                <div className={s.localControls}>
                    <button
                        className={`${s.localBtn} ${muted ? s.localBtnActive : ""}`}
                        onClick={onToggleMute}
                        aria-label={muted ? "Unmute" : "Mute"}
                        title={muted ? "Unmute" : "Mute"}
                    >
                        {muted ? <FaMicrophoneSlash size={10} /> : <FaMicrophone size={10} />}
                    </button>
                    <button
                        className={`${s.localBtn} ${videoOff ? s.localBtnActive : ""}`}
                        onClick={onToggleVideo}
                        aria-label={videoOff ? "Turn camera on" : "Turn camera off"}
                        title={videoOff ? "Turn camera on" : "Turn camera off"}
                    >
                        {videoOff ? <FaVideoSlash size={10} /> : <FaVideo size={10} />}
                    </button>
                    {isHost && (
                        <button
                            className={`${s.localBtn} ${shareEmotion ? s.localBtnEmotionActive : ""}`}
                            onClick={onToggleEmotion}
                            aria-label="Toggle emotion AI"
                            title="Toggle emotion AI"
                            style={{ fontSize: "10px" }}
                        >
                            ✦
                        </button>
                    )}
                </div>
            </div>
            {isSpeaking && <div className={s.speakRing} />}
        </motion.div>
    );
}