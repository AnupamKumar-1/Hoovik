import React, { useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { FaRegComments } from "react-icons/fa";
import ChatInput from "./ChatInput";
import s from "../styles/videoComponent.module.css";

function useIsScrolledToBottom(ref, threshold = 60) {
    return useCallback(() => {
        const el = ref.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    }, [ref, threshold]);
}

export default function MeetChatPanel({
    chatMessages,
    participantsMeta,
    myUserId,
    retryMessage,
    sendChatMessage,
    chatContainerRef,
    chatEndRef,
    onClose,
}) {
    const isAtBottom = useIsScrolledToBottom(chatContainerRef);

    useEffect(() => {
        if (isAtBottom()) {
            chatEndRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "end",
            });
        }
    }, [chatMessages, isAtBottom, chatEndRef]);

    return (
        <motion.aside
            className={s.chatPanel}
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 60 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            aria-label="Chat panel"
        >

            <div className={s.chatHeader}>
                <FaRegComments size={13} className={s.chatHeaderIcon} />
                <strong className={s.chatHeaderTitle}>Chat</strong>

                <div className={s.chatHeaderMeta}>
                    <span className={s.chatOnlineDot} />
                    <span>{participantsMeta.length + 1} in call</span>
                </div>

                <button
                    onClick={onClose}
                    aria-label="Close chat"
                    className={s.chatCloseBtn}
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                    >
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </button>
            </div>


            <div
                ref={chatContainerRef}
                className={s.chatMessages}
                role="log"
                aria-live="polite"
                aria-label="Chat messages"
            >
                {chatMessages.length === 0 && (
                    <div className={s.chatEmpty}>
                        <FaRegComments size={20} className={s.chatEmptyIcon} />
                        <p className={s.chatEmptyText}>
                            No messages yet. <br />
                            Say hello! 👋
                        </p>
                    </div>
                )}

                {chatMessages.map((m) => {
                    const isOwn =
                        m.from === myUserId || m.userId === myUserId;

                    return (
                        <motion.div
                            key={m.id}
                            className={`${s.msgWrapper} ${isOwn ? s.own : s.other
                                }`}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.12 }}
                        >
                            {!isOwn && (
                                <div className={s.msgMeta}>
                                    <span className={s.msgMetaName}>
                                        {m.meta?.name || "User"}
                                    </span>
                                </div>
                            )}

                            <div
                                className={`${s.msgBubble} ${isOwn
                                        ? s.msgBubbleOwn
                                        : s.msgBubbleOther
                                    }`}
                            >
                                {m.text}
                            </div>

                            <div className={s.msgMeta}>
                                {isOwn && (
                                    <span className={s.msgMetaNameOwn}>
                                        You
                                    </span>
                                )}

                                <span>
                                    {new Date(m.ts).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}
                                </span>

                                {isOwn && (
                                    <>
                                        {m.status === "pending" && (
                                            <span
                                                className={s.msgStatusPending}
                                                aria-label="Sending"
                                            >
                                                ●
                                            </span>
                                        )}

                                        {m.status === "sent" && (
                                            <span
                                                className={s.msgStatusSent}
                                                aria-label="Sent"
                                            >
                                                ✓
                                            </span>
                                        )}

                                        {m.status === "failed" && (
                                            <span
                                                className={s.msgStatusFailed}
                                                onClick={() => retryMessage(m)}
                                                role="button"
                                                tabIndex={0}
                                                title="Retry sending"
                                                onKeyDown={(e) =>
                                                    e.key === "Enter" &&
                                                    retryMessage(m)
                                                }
                                            >
                                                !
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                        </motion.div>
                    );
                })}

                <div ref={chatEndRef} />
            </div>

            <div className={s.chatInputArea}>
                <ChatInput onSend={sendChatMessage} />
            </div>
        </motion.aside>
    );
}