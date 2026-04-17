import React, { useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaRegComments } from "react-icons/fa";
import ChatInput from "./ChatInput";
import EmotionParticipantCard from "./EmotionParticipantCard";
import EmotionGroupSummary from "./EmotionGroupSummary";
import EmotionAIInsight from "./EmotionAIInsight";
import s from "../styles/videoComponent.module.css";

const SHEET_VARIANTS = {
    hidden: { y: "100%", opacity: 0 },
    visible: {
        y: 0,
        opacity: 1,
        transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
    },
    exit: {
        y: "100%",
        opacity: 0,
        transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
    },
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
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
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
        <div style={{
            display: "flex",
            flexDirection: "column",
            flex: "1 1 0",
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
        }}>
            {/* Scrollable messages area */}
            <div
                ref={containerRef}
                role="log"
                aria-live="polite"
                aria-label="Chat messages"
                style={{
                    flex: "1 1 0",
                    minHeight: 0,
                    overflowY: "auto",
                    overflowX: "hidden",
                    padding: "10px 14px 6px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "3px",
                    overscrollBehavior: "contain",
                    WebkitOverflowScrolling: "touch",
                }}
            >
                {chatMessages.length === 0 && (
                    <div className={s.chatEmpty}>
                        <FaRegComments size={20} className={s.chatEmptyIcon} />
                        <p className={s.chatEmptyText}>
                            No messages yet.<br />Say hello! 👋
                        </p>
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
                                <span>
                                    {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                                {isOwn && (
                                    <>
                                        {m.status === "pending" && (
                                            <span className={s.msgStatusPending} aria-label="Sending">●</span>
                                        )}
                                        {m.status === "sent" && (
                                            <span className={s.msgStatusSent} aria-label="Sent">✓</span>
                                        )}
                                        {m.status === "failed" && (
                                            <span
                                                className={s.msgStatusFailed}
                                                onClick={() => retryMessage(m)}
                                                role="button"
                                                tabIndex={0}
                                                title="Retry sending"
                                                onKeyDown={(e) => e.key === "Enter" && retryMessage(m)}
                                            >!</span>
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
                flexShrink: 0,
                width: "100%",
                borderTop: "1px solid rgba(255,255,255,0.065)",
                padding: "10px 14px",
                paddingBottom: "max(12px, env(safe-area-inset-bottom))",
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
                        if (safeHistory.length === 0) return null;
                        const meta = participantsMeta.find((p) => p.id === pid);
                        const displayName =
                            meta?.meta?.name ||
                            meta?.meta?.displayName ||
                            meta?.meta?.userName ||
                            meta?.meta?.username ||
                            (pid ? `User-${pid.slice(0, 4)}` : "Unknown");
                        const isParticipantHost = !!meta?.meta?.isHost;
                        return (
                            <EmotionParticipantCard
                                key={pid}
                                pid={pid}
                                history={safeHistory}
                                displayName={displayName}
                                isHost={isParticipantHost}
                            />
                        );
                    })}
                    {rows.length > 1 && <EmotionGroupSummary emotionsMap={emotionsMap} />}
                </>
            )}
        </div>
    );
}

export default function MobilePanelSheet({
    activeSheet,
    onClose,
    onTabChange,
    showEmotionTab,
    chatMessages,
    participantsMeta,
    myUserId,
    retryMessage,
    sendChatMessage,
    emotionsMap,
    isHost,
}) {
    const isOpen = activeSheet !== null;
    const showBothTabs = showEmotionTab;
    const touchStartY = useRef(null);

    const handleTouchStart = useCallback((e) => {
        touchStartY.current = e.touches[0].clientY;
    }, []);

    const handleTouchEnd = useCallback((e) => {
        if (touchStartY.current === null) return;
        const delta = e.changedTouches[0].clientY - touchStartY.current;
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
                            position: "fixed",
                            inset: 0,
                            background: "rgba(0,0,0,0.55)",
                            zIndex: 1050,
                            backdropFilter: "blur(2px)",
                        }}
                    />


                    <motion.div
                        key="mobile-sheet"
                        variants={SHEET_VARIANTS}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeSheet === "chat" ? "Chat panel" : "Emotion panel"}
                        onTouchStart={handleTouchStart}
                        onTouchEnd={handleTouchEnd}
                        style={{
                            position: "fixed",
                            left: 0,
                            right: 0,
                            bottom: "64px",
                            zIndex: 1200,
                            height: "82vh",
                            maxHeight: "82vh",
                            display: "flex",
                            flexDirection: "column",
                            overflow: "hidden",
                            background: "rgba(10,12,17,0.97)",
                            borderTop: "1px solid rgba(255,255,255,0.12)",
                            borderRadius: "20px 20px 0 0",
                            backdropFilter: "blur(32px) saturate(1.5)",
                            boxShadow: "0 -8px 48px rgba(0,0,0,0.7)",
                        }}
                    >

                        <div
                            aria-hidden="true"
                            style={{
                                width: 36,
                                height: 4,
                                borderRadius: 2,
                                background: "rgba(255,255,255,0.15)",
                                margin: "10px auto 0",
                                flexShrink: 0,
                            }}
                        />


                        {showBothTabs ? (
                            <div
                                role="tablist"
                                style={{ display: "flex", gap: 4, padding: "10px 14px 0", flexShrink: 0 }}
                            >
                                <button
                                    className={`${s.sheetTab} ${activeSheet === "chat" ? s.sheetTabActive : ""}`}
                                    onClick={() => onTabChange("chat")}
                                    role="tab"
                                    aria-selected={activeSheet === "chat"}
                                    aria-controls="sheet-chat-panel"
                                >
                                    <FaRegComments size={12} />
                                    Chat
                                </button>
                                <button
                                    className={`${s.sheetTab} ${activeSheet === "emotion" ? s.sheetTabActive : ""}`}
                                    onClick={() => onTabChange("emotion")}
                                    role="tab"
                                    aria-selected={activeSheet === "emotion"}
                                    aria-controls="sheet-emotion-panel"
                                >
                                    <EmotionIcon size={12} />
                                    Emotions
                                    <span className={s.emotionSidebarBadge} style={{ fontSize: 8, padding: "1px 5px" }}>
                                        LIVE
                                    </span>
                                </button>
                            </div>
                        ) : (
                            <div className={s.chatHeader} style={{ padding: "10px 14px", flexShrink: 0 }}>
                                {activeSheet === "chat" ? (
                                    <>
                                        <FaRegComments size={13} className={s.chatHeaderIcon} />
                                        <strong className={s.chatHeaderTitle}>Chat</strong>
                                        <div className={s.chatHeaderMeta}>
                                            <span className={s.chatOnlineDot} />
                                            <span>{participantsMeta.length + 1} in call</span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <EmotionIcon size={13} />
                                        <strong className={s.chatHeaderTitle} style={{ marginLeft: 8 }}>
                                            Emotion Timeline
                                        </strong>
                                        <span className={s.emotionSidebarBadge} style={{ marginLeft: "auto" }}>
                                            LIVE
                                        </span>
                                    </>
                                )}
                                <button
                                    onClick={onClose}
                                    aria-label="Close panel"
                                    className={s.chatCloseBtn}
                                    style={{ marginLeft: 8 }}
                                >
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        )}

                        {/* Close button for dual-tab mode */}
                        {showBothTabs && (
                            <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 14px 0", flexShrink: 0 }}>
                                <button onClick={onClose} aria-label="Close panel" className={s.chatCloseBtn}>
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        )}


                        <div
                            id={activeSheet === "chat" ? "sheet-chat-panel" : "sheet-emotion-panel"}
                            role="tabpanel"
                            style={{
                                flex: "1 1 0",
                                minHeight: 0,
                                display: "flex",
                                flexDirection: "column",
                                overflow: "hidden",
                            }}
                        >
                            {activeSheet === "chat" ? (
                                <ChatTab
                                    chatMessages={chatMessages}
                                    participantsMeta={participantsMeta}
                                    myUserId={myUserId}
                                    retryMessage={retryMessage}
                                    sendChatMessage={sendChatMessage}
                                />
                            ) : (
                                <EmotionTab
                                    emotionsMap={emotionsMap}
                                    participantsMeta={participantsMeta}
                                    isHost={isHost}
                                />
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}