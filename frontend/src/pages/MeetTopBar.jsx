import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import s from "../styles/videoComponent.module.css";

function formatDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sc = secs % 60;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}`;
}

export default function MeetTopBar({ roomId, isHost, duration, participantCount, connecting }) {
    const code = useMemo(() => (roomId || "").toUpperCase(), [roomId]);

    return (
        <header className={s.topBar}>
            <div className={s.topBarLeft}>
                <div className={s.logo}>
                    <span className={s.logoDot} />
                    <span className={s.logoText}>Hoovik</span>
                </div>
                <div className={s.roomCode}>
                    <span className={s.roomCodeLabel}>Room</span>
                    <span className={s.roomCodeValue}>{code}</span>
                </div>
            </div>

            <div className={s.topBarCenter}>
                <AnimatePresence>
                    {connecting && (
                        <motion.div
                            className={s.connectingPill}
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.2 }}
                        >
                            <span className={s.connectingDot} />
                            Connecting
                        </motion.div>
                    )}
                </AnimatePresence>
                {!connecting && (
                    <div className={s.livePill}>
                        <span className={s.liveDot} />
                        LIVE
                    </div>
                )}
            </div>

            <div className={s.topBarRight}>
                <div className={s.timerDisplay}>{formatDuration(duration)}</div>
                <div className={s.participantCount}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="9" cy="7" r="4" />
                        <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85" />
                    </svg>
                    <span>{participantCount}</span>
                </div>
                {isHost && <span className={s.hostBadge}>Host</span>}
            </div>
        </header>
    );
}