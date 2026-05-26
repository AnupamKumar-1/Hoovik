import React from "react";
import {
    FaMicrophone, FaMicrophoneSlash,
    FaVideo, FaVideoSlash,
    FaDesktop, FaPhoneSlash, FaComments,
} from "react-icons/fa";
import s from "../styles/videoComponent.module.css";

function CtrlBtn({ onClick, active, label, title, children, disabled, badge }) {
    return (
        <button
            className={[s.ctrlBtn, active ? s.ctrlBtnActive : ""].filter(Boolean).join(" ")}
            onClick={onClick}
            title={title}
            aria-label={title}
            aria-pressed={active}
            disabled={disabled}
            style={{ position: "relative" }}
        >
            <span className={s.ctrlBtnIcon}>{children}</span>
            {label && <span className={s.ctrlBtnLabel}>{label}</span>}
            {badge > 0 && (
                <span
                    style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        minWidth: 14,
                        height: 14,
                        borderRadius: 7,
                        background: "var(--m-cyan)",
                        color: "#000",
                        fontSize: 8,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "0 3px",
                        lineHeight: 1,
                        pointerEvents: "none",
                    }}
                    aria-label={`${badge} unread messages`}
                >
                    {badge > 9 ? "9+" : badge}
                </span>
            )}
        </button>
    );
}

export default function MeetControlBar({
    muted,
    videoOff,
    chatOpen,
    shareEmotion,
    isHost,
    emotionLive,
    endingMeeting,
    unreadCount = 0,
    onToggleMute,
    onToggleVideo,
    onScreenShare,
    onToggleChat,
    onToggleEmotion,
    onLeaveEnd,
}) {
    return (
        <div className={s.controlBar} role="toolbar" aria-label="Meeting controls">
            <div className={s.controlGroup}>
                <CtrlBtn
                    onClick={onToggleMute}
                    active={muted}
                    title={muted ? "Unmute (M)" : "Mute (M)"}
                    label={muted ? "Unmute" : "Mute"}
                >
                    {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
                </CtrlBtn>
                <CtrlBtn
                    onClick={onToggleVideo}
                    active={videoOff}
                    title={videoOff ? "Camera on (V)" : "Camera off (V)"}
                    label={videoOff ? "Start Video" : "Stop Video"}
                >
                    {videoOff ? <FaVideoSlash /> : <FaVideo />}
                </CtrlBtn>
                <CtrlBtn onClick={onScreenShare} title="Share screen" label="Share">
                    <FaDesktop />
                </CtrlBtn>
            </div>

            <div className={s.controlDivider} />

            <div className={s.controlGroup}>
                <CtrlBtn
                    onClick={onToggleChat}
                    active={chatOpen}
                    title="Toggle chat (C)"
                    label="Chat"
                    badge={chatOpen ? 0 : unreadCount}
                >
                    <FaComments />
                </CtrlBtn>
                {isHost && (
                    <CtrlBtn
                        onClick={onToggleEmotion}
                        active={shareEmotion}
                        title={shareEmotion ? "Stop emotion AI" : "Start emotion AI"}
                        label="Emotions"
                    >
                        <span style={{ fontSize: "1rem" }}>✦</span>
                    </CtrlBtn>
                )}
            </div>

            <div className={s.controlDivider} />

            <button
                className={s.leaveBtn}
                onClick={onLeaveEnd}
                disabled={endingMeeting}
                aria-label={isHost ? "End meeting" : "Leave call"}
            >
                <FaPhoneSlash />
                <span>{isHost ? "End" : "Leave"}</span>
            </button>
        </div>
    );
}