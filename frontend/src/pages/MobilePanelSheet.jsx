import React, { useRef, useEffect, useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaRegComments } from "react-icons/fa";
import ChatInput from "./ChatInput";
import EmotionParticipantCard from "./EmotionParticipantCard";
import EmotionGroupSummary from "./EmotionGroupSummary";
import EmotionAIInsight from "./EmotionAIInsight";
import s from "../styles/videoComponent.module.css";

const SHEET_VARIANTS = {
    hidden: { y: "100%", opacity: 0 },
    visible: { y: 0, opacity: 1, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
    exit: { y: "100%", opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
};

function useIsScrolledToBottom(ref, threshold = 60) {
    return useCallback(() => {
        const el = ref.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    }, [ref, threshold]);
}

function EmotionIcon({ size = 13 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
    );
}

function ChatTab({ chatMessages, participantsMeta, myUserId, retryMessage, sendChatMessage }) {
    const containerRef = useRef(null);
    const endRef = useRef(null);
    const isAtBottom = useIsScrolledToBottom(containerRef);

    useEffect(() => {
        if (isAtBottom()) {
            endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        }
    }, [chatMessages, isAtBottom]);

    return (
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
            <div
                ref={containerRef}
                role="log"
                aria-live="polite"
                aria-label="Chat messages"
                style={{
                    flex: "1 1 0", minHeight: 0, overflowY: "auto", overflowX: "hidden",
                    padding: "12px 16px 6px", display: "flex", flexDirection: "column",
                    gap: "4px", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch",
                }}
            >
                {chatMessages.length === 0 && (
                    <div className={s.chatEmpty}>
                        <FaRegComments size={24} className={s.chatEmptyIcon} />
                        <p className={s.chatEmptyText}>No messages yet.<br />Say hello! 👋</p>
                    </div>
                )}
                {chatMessages.map((m) => {
                    const isOwn = m.from === myUserId || m.userId === myUserId;
                    return (
                        <motion.div
                            key={m.id}
                            className={`${s.msgWrapper} ${isOwn ? s.own : s.other}`}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.12 }}
                        >
                            {!isOwn && (
                                <div className={s.msgMeta}>
                                    <span className={s.msgMetaName}>{m.meta?.name || "User"}</span>
                                </div>
                            )}
                            <div className={`${s.msgBubble} ${isOwn ? s.msgBubbleOwn : s.msgBubbleOther}`}>
                                {m.text}
                            </div>
                            <div className={s.msgMeta}>
                                {isOwn && <span className={s.msgMetaNameOwn}>You</span>}
                                <span>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                                {isOwn && (
                                    <>
                                        {m.status === "pending" && <span className={s.msgStatusPending} aria-label="Sending">●</span>}
                                        {m.status === "sent" && <span className={s.msgStatusSent} aria-label="Sent">✓</span>}
                                        {m.status === "failed" && (
                                            <span className={s.msgStatusFailed} onClick={() => retryMessage(m)}
                                                role="button" tabIndex={0} title="Retry"
                                                onKeyDown={(e) => e.key === "Enter" && retryMessage(m)}>!</span>
                                        )}
                                    </>
                                )}
                            </div>
                        </motion.div>
                    );
                })}
                <div ref={endRef} />
            </div>
            <div style={{
                flexShrink: 0, borderTop: "1px solid rgba(255,255,255,0.065)",
                padding: "10px 16px", paddingBottom: "max(12px, env(safe-area-inset-bottom))",
                backgroundColor: "rgba(10,12,17,0.97)",
            }}>
                <ChatInput onSend={sendChatMessage} />
            </div>
        </div>
    );
}

function EmotionTab({ emotionsMap, participantsMeta, isHost }) {
    const rows = Object.entries(emotionsMap || {});
    return (
        <div className={s.sheetEmotionBody}>
            {rows.length === 0 ? (
                <div className={s.emotionEmpty}>
                    <EmotionIcon size={20} />
                    <p>Waiting for emotion data…</p>
                </div>
            ) : (
                <>
                    <EmotionAIInsight emotionsMap={emotionsMap} participantsMeta={participantsMeta} />
                    <div className={s.emotionSectionHeader}>
                        <span className={s.emotionSectionTitle}>Participants</span>
                    </div>
                    {rows.map(([pid, history]) => {
                        const safeHistory = Array.isArray(history) ? history : [];
                        if (!safeHistory.length) return null;
                        const meta = participantsMeta.find((p) => p.id === pid);
                        const displayName =
                            meta?.meta?.name || meta?.meta?.displayName ||
                            meta?.meta?.userName || meta?.meta?.username ||
                            (pid ? `User-${pid.slice(0, 4)}` : "Unknown");
                        return (
                            <EmotionParticipantCard key={pid} pid={pid} history={safeHistory}
                                displayName={displayName} isHost={!!meta?.meta?.isHost} />
                        );
                    })}
                    {rows.length > 1 && <EmotionGroupSummary emotionsMap={emotionsMap} />}
                </>
            )}
        </div>
    );
}

export default function MobilePanelSheet({
    activeSheet, onClose, onTabChange, showEmotionTab,
    chatMessages, participantsMeta, myUserId, retryMessage, sendChatMessage,
    emotionsMap, isHost,
}) {
    const isOpen = activeSheet !== null;
    const touchStartY = useRef(null);
    const sheetRef = useRef(null);

    const handleTouchStart = useCallback((e) => {
        touchStartY.current = e.touches[0].clientY;
    }, []);

    const handleTouchMove = useCallback((e) => {
        if (touchStartY.current === null) return;
        const delta = e.touches[0].clientY - touchStartY.current;
        if (delta > 0 && sheetRef.current) {
            sheetRef.current.style.transform = `translateY(${Math.min(delta, 200)}px)`;
        }
    }, []);

    const handleTouchEnd = useCallback((e) => {
        if (touchStartY.current === null) return;
        const delta = e.changedTouches[0].clientY - touchStartY.current;
        if (sheetRef.current) sheetRef.current.style.transform = "";
        if (delta > 72) onClose();
        touchStartY.current = null;
    }, [onClose]);

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        key="sheet-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        onClick={onClose}
                        aria-hidden="true"
                        style={{
                            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
                            zIndex: 1050, backdropFilter: "blur(3px)",
                        }}
                    />

                    <motion.div
                        ref={sheetRef}
                        key="mobile-sheet"
                        variants={SHEET_VARIANTS}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeSheet === "chat" ? "Chat panel" : "Emotion panel"}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        style={{
                            position: "fixed", left: 0, right: 0,
                            bottom: "64px",
                            zIndex: 1200,
                            height: "78vh", maxHeight: "78vh",
                            display: "flex", flexDirection: "column",
                            overflow: "hidden",
                            background: "rgba(10,12,17,0.98)",
                            borderTop: "1px solid rgba(255,255,255,0.1)",
                            borderRadius: "24px 24px 0 0",
                            backdropFilter: "blur(32px) saturate(1.5)",
                            boxShadow: "0 -12px 60px rgba(0,0,0,0.8)",
                            willChange: "transform",
                        }}
                    >
                        <div
                            aria-hidden="true"
                            onTouchStart={handleTouchStart}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}
                            style={{
                                width: 40, height: 4, borderRadius: 2,
                                background: "rgba(255,255,255,0.18)",
                                margin: "12px auto 0", flexShrink: 0, cursor: "grab",
                            }}
                        />

                        {showEmotionTab ? (
                            <div style={{ display: "flex", gap: 8, padding: "12px 16px 0", flexShrink: 0, alignItems: "center" }}>
                                <div role="tablist" style={{ display: "flex", flex: 1, gap: 8 }}>
                                    <button
                                        className={`${s.sheetTab} ${activeSheet === "chat" ? s.sheetTabActive : ""}`}
                                        onClick={() => onTabChange("chat")}
                                        role="tab" aria-selected={activeSheet === "chat"}
                                        style={{ height: 40, fontSize: 13 }}
                                    >
                                        <FaRegComments size={14} /> Chat
                                    </button>
                                    <button
                                        className={`${s.sheetTab} ${activeSheet === "emotion" ? s.sheetTabActive : ""}`}
                                        onClick={() => onTabChange("emotion")}
                                        role="tab" aria-selected={activeSheet === "emotion"}
                                        style={{ height: 40, fontSize: 13 }}
                                    >
                                        <EmotionIcon size={14} /> Emotions
                                        <span className={s.emotionSidebarBadge} style={{ fontSize: 8, padding: "1px 5px" }}>LIVE</span>
                                    </button>
                                </div>
                                <button onClick={onClose} aria-label="Close panel"
                                    style={{
                                        width: 32, height: 32, borderRadius: "50%",
                                        border: "1px solid rgba(255,255,255,0.12)",
                                        background: "rgba(255,255,255,0.06)",
                                        color: "rgba(255,255,255,0.5)",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        cursor: "pointer", flexShrink: 0,
                                    }}>
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        ) : (
                            <div style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "12px 16px 0", flexShrink: 0,
                            }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                                    {activeSheet === "chat"
                                        ? <FaRegComments size={15} style={{ color: "var(--m-cyan)" }} />
                                        : <EmotionIcon size={15} />}
                                    <strong style={{ fontFamily: "var(--m-font-head)", fontSize: 15, fontWeight: 700, color: "var(--m-text)" }}>
                                        {activeSheet === "chat" ? "Chat" : "Emotions"}
                                    </strong>
                                    {activeSheet === "chat" && (
                                        <span style={{ fontSize: 12, color: "var(--m-text3)", marginLeft: 4 }}>
                                            {participantsMeta.length + 1} in call
                                        </span>
                                    )}
                                    {activeSheet === "emotion" && (
                                        <span className={s.emotionSidebarBadge} style={{ marginLeft: 4 }}>LIVE</span>
                                    )}
                                </div>
                                <button onClick={onClose} aria-label="Close panel"
                                    style={{
                                        width: 32, height: 32, borderRadius: "50%",
                                        border: "1px solid rgba(255,255,255,0.12)",
                                        background: "rgba(255,255,255,0.06)",
                                        color: "rgba(255,255,255,0.5)",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        cursor: "pointer",
                                    }}>
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        )}

                        <div
                            role="tabpanel"
                            style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", marginTop: 8 }}
                        >
                            {activeSheet === "chat" ? (
                                <ChatTab chatMessages={chatMessages} participantsMeta={participantsMeta}
                                    myUserId={myUserId} retryMessage={retryMessage} sendChatMessage={sendChatMessage} />
                            ) : (
                                <EmotionTab emotionsMap={emotionsMap} participantsMeta={participantsMeta} isHost={isHost} />
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}