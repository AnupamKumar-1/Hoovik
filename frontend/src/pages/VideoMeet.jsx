import React, {
  useEffect,
  useRef,
  useState,
  useContext,
  useCallback,
  useMemo,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AuthContext } from "../contexts/AuthContext";
import useMediaBridge from "../hooks/useMediaBridge";
import useMeetingLifecycle from "../hooks/useMeetingLifecycle";
import styles from "../styles/videoComponent.module.css";
import { TRANSCRIPTS_ENABLED } from "../environment";
import ParticipantCard from "./ParticipantCard";
import useChat from "../hooks/useChat";
import {
  SOCKET_SERVER_URL,
  TRANSCRIPT_ENDPOINT,
  API_BASE,
  ICE_CONFIG,
} from "./meetConfig";
import {
  FaMicrophone,
  FaMicrophoneSlash,
  FaVideo,
  FaVideoSlash,
  FaDesktop,
  FaPhoneSlash,
  FaComments,
  FaRegComments,
} from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";
import ChatInput from "./ChatInput";
import useWebRTC from "../hooks/useWebRTC";
import useSocket from "../hooks/useSocket";
import useRecording from "../hooks/useRecording";
import useMediaControls from "../hooks/useMediaControls";
import EmotionServicePanel from "./EmotionServicePanel";
import useAudioAnalyzer from "../hooks/useAudioAnalyzer";
import useEmotionCapture from "../hooks/useEmotionCapture";

const DEBUG_SHOW_EMOTION_FOR_EVERYONE = false;
const SPEAKER_DEBOUNCE_MS = 700;
const LARGE_ROOM_THRESHOLD = 6;

function isValidStream(s) {
  return !!s && typeof s.getTracks === "function";
}

function getGridStyle(count) {
  if (count === 0) return {};
  if (count === 1) return { gridTemplateColumns: "1fr", gridTemplateRows: "1fr" };
  if (count === 2) return { gridTemplateColumns: "repeat(2, 1fr)", gridTemplateRows: "1fr" };
  if (count === 3) return { gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "1fr" };
  if (count === 4) return { gridTemplateColumns: "repeat(2, 1fr)", gridTemplateRows: "repeat(2, 1fr)" };
  return { gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" };
}

function getCardMinHeight(count) {
  if (count === 1) return "60vh";
  if (count <= 2) return 280;
  if (count <= 4) return 240;
  return 200;
}

function useIsScrolledToBottom(ref, threshold = 60) {
  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, [ref, threshold]);
  return check;
}

function ChatPanel({
  chatMessages,
  participantsMeta,
  myUserId,
  retryMessage,
  sendChatMessage,
  chatContainerRef,
  chatEndRef,
}) {
  const isAtBottom = useIsScrolledToBottom(chatContainerRef);

  useEffect(() => {
    if (isAtBottom()) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chatMessages, isAtBottom, chatEndRef]);

  return (
    <motion.aside
      className={styles.chatRoom}
      initial={{ opacity: 0, x: 60 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 60 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      aria-label="Chat panel"
    >
      <div className={styles.chatHeader}>
        <FaRegComments size={13} className={styles.chatHeaderIcon} />
        <strong>Chat</strong>
        <div className={styles.chatHeaderCount}>
          <span className={styles.chatHeaderCountDot} />
          {participantsMeta.length} in call
        </div>
      </div>

      <div
        ref={chatContainerRef}
        className={styles.chatMessages}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {chatMessages.length === 0 && (
          <div className={styles.chatEmptyState}>
            <FaRegComments size={20} style={{ opacity: 0.3, color: "var(--vm-muted-bright)" }} />
            <p className={styles.chatEmptyStateText}>
              No messages yet.<br />Say hello! 👋
            </p>
          </div>
        )}

        {chatMessages.map((m) => {
          const isOwn = m.from === myUserId || m.userId === myUserId;
          return (
            <motion.div
              key={m.id}
              className={`${styles.msgWrapper} ${isOwn ? styles.own : styles.other}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14 }}
            >
              {!isOwn && (
                <div className={styles.msgMeta}>
                  <span className={styles.msgMetaName}>{m.meta?.name || "User"}</span>
                </div>
              )}
              <div
                className={`${styles.msgBubble} ${isOwn ? styles.msgBubbleOwn : styles.msgBubbleOther}`}
              >
                {m.text}
              </div>
              <div className={styles.msgMeta}>
                {isOwn && (
                  <span className={`${styles.msgMetaName} ${styles.msgMetaNameOwn}`}>You</span>
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
                        className={`${styles.msgStatusIcon} ${styles.msgStatusPending}`}
                        aria-label="Sending"
                      >
                        ●
                      </span>
                    )}
                    {m.status === "sent" && (
                      <span
                        className={`${styles.msgStatusIcon} ${styles.msgStatusSent}`}
                        aria-label="Sent"
                      >
                        ✓
                      </span>
                    )}
                    {m.status === "failed" && (
                      <span
                        className={`${styles.msgStatusIcon} ${styles.msgStatusFailed}`}
                        onClick={() => retryMessage(m)}
                        role="button"
                        tabIndex={0}
                        title="Retry sending"
                        aria-label="Send failed — click to retry"
                        onKeyDown={(e) => e.key === "Enter" && retryMessage(m)}
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

      <div className={styles.chattingArea}>
        <ChatInput onSend={sendChatMessage} />
      </div>
    </motion.aside>
  );
}

function EmptyStateIcon() {
  return (
    <div className={styles.emptyStateIcon}>
      <svg
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    </div>
  );
}

export default function VideoMeet() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const localVideoRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const prevLocalStreamRef = useRef(null);
  const pcsRef = useRef({});
  const remoteStreamsRef = useRef({});
  const chatContainerRef = useRef(null);
  const chatEndRef = useRef(null);
  const cleanupRef = useRef(null);
  const speakerTimerRef = useRef(null);

  const [remoteStreams, setRemoteStreams] = useState({});
  const [connecting, setConnecting] = useState(true);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsMeta, setParticipantsMeta] = useState([]);
  const [myId, setMyId] = useState(null);
  const [shareEmotion, setShareEmotion] = useState(false);
  const [emotionsMap, setEmotionsMap] = useState({});
  const [stableSpeakerId, setStableSpeakerId] = useState(null);

  const { addToUserHistory } = useContext(AuthContext);

  const isHost = useMemo(
    () => !!localStorage.getItem(`host:${(roomId || "").toUpperCase()}`),
    [roomId]
  );

  const myUserId = useMemo(
    () => localStorage.getItem("userId") || myId || "",
    [myId]
  );

  const mutedRef = useRef(muted);
  const videoOffRef = useRef(videoOff);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { videoOffRef.current = videoOff; }, [videoOff]);
  useEffect(() => { remoteStreamsRef.current = remoteStreams; }, [remoteStreams]);

  const {
    chatMessages,
    setChatMessages,
    sendChatMessage,
    handleIncomingMessage,
    handleAck,
    retryMessage,
    seenMsgIdsRef,
  } = useChat({
    socketRef,
    roomId,
    userId: myUserId,
    displayName: localStorage.getItem("displayName") ?? undefined,
  });

  const { activeSpeakerId, createAnalyzerForStream, removeAnalyzer } =
    useAudioAnalyzer({ remoteStreams, localStreamRef, mutedRef, pcsRef });

  const {
    recordersRef,
    startRecordingForStream,
    stopAllRecorders,
    uploadRecordingsAndStoreTranscript,
  } = useRecording({
    isHost,
    roomId,
    participantsMeta,
    TRANSCRIPTS_ENABLED,
    TRANSCRIPT_ENDPOINT,
    API_BASE,
  });

  const {
    createPeerConnection,
    safeNegotiateOffer,
    handleSignal,
    politeRef,
    pendingCandidatesRef,
  } = useWebRTC({
    socketRef,
    localStreamRef,
    pcsRef,
    setRemoteStreams,
    createAnalyzerForStream,
    removeAnalyzer,
    recordersRef,
    ICE_CONFIG,
  });

  const { startPeriodicEmotionCapture, stopPeriodicEmotionCapture } =
    useEmotionCapture({
      socketRef,
      remoteStreamsRef,
      myId,
      roomId,
      isHost,
      DEBUG_SHOW_EMOTION_FOR_EVERYONE,
    });

  const { toggleMute, toggleVideo, startScreenShare } = useMediaControls({
    localStreamRef,
    localVideoRef,
    pcsRef,
    socketRef,
    createAnalyzerForStream,
    removeAnalyzer,
    startRecordingForStream,
    stopPeriodicEmotionCapture,
    startPeriodicEmotionCapture,
  });

  const { leaveCall, endMeeting, cleanupAll, persistHistorySnapshot } =
    useMeetingLifecycle({
      roomId,
      navigate,
      socketRef,
      localStreamRef,
      localVideoRef,
      prevLocalStreamRef,
      pcsRef,
      participantsMeta,
      isHost,
      addToUserHistory,
      TRANSCRIPTS_ENABLED,
      TRANSCRIPT_ENDPOINT,
      API_BASE,
      createAnalyzerForStream,
      removeAnalyzer,
      startRecordingForStream,
      stopAllRecorders,
      uploadRecordingsAndStoreTranscript,
      stopPeriodicEmotionCapture,
      setConnecting,
      setParticipantsMeta,
      setRemoteStreams,
      recordersRef,
      SOCKET_SERVER_URL,
    });

  useEffect(() => {
    cleanupRef.current = cleanupAll;
  }, [cleanupAll]);

  useMediaBridge({
    localStreamRef,
    createAnalyzerForStream,
    removeAnalyzer,
    startRecordingForStream,
    stopAllRecorders,
    recordersRef,
    startPeriodicEmotionCapture,
    stopPeriodicEmotionCapture,
  });

  const isInitiatorFor = useCallback((peerId) => {
    try {
      const me = socketRef.current?.id;
      if (!me || !peerId) return false;
      return String(me) < String(peerId);
    } catch {
      return false;
    }
  }, []);

  const closePeer = useCallback((peerId) => {
    const pc = pcsRef.current[peerId];
    if (pc) {
      try { pc.close(); } catch { }
      delete pcsRef.current[peerId];
    }
    setRemoteStreams((prev) => {
      if (!prev[peerId]) return prev;
      const copy = { ...prev };
      delete copy[peerId];
      return copy;
    });
    setStableSpeakerId((prev) => (prev === peerId ? null : prev));
  }, []);

  useEffect(() => {
    if (!activeSpeakerId) return;

    if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);

    speakerTimerRef.current = setTimeout(() => {
      const normalizedId =
        activeSpeakerId === myId ? "local" : activeSpeakerId;
      setStableSpeakerId(normalizedId);
    }, SPEAKER_DEBOUNCE_MS);
  }, [activeSpeakerId, myId]);

  useEffect(() => {
    return () => {
      if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (shareEmotion && isHost) startPeriodicEmotionCapture({});
    else stopPeriodicEmotionCapture();
  }, [shareEmotion, isHost, startPeriodicEmotionCapture, stopPeriodicEmotionCapture]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || "").toUpperCase();
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        e.target?.isContentEditable;
      if (isEditable) return;

      if (e.key === "m" || e.key === "M") {
        toggleMute(mutedRef.current, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef);
      } else if (e.key === "v" || e.key === "V") {
        toggleVideo(videoOffRef.current, setVideoOff);
      } else if (e.key === "c" || e.key === "C") {
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMute, toggleVideo]);

  useSocket({
    socketRef,
    roomId,
    setMyId,
    setParticipantsMeta,
    setChatMessages,
    seenMsgIdsRef,
    createPeerConnection,
    safeNegotiateOffer,
    isInitiatorFor,
    politeRef,
    pendingCandidatesRef,
    pcsRef,
    closePeer,
    removeAnalyzer,
    recordersRef,
    setEmotionsMap,
    handleSignal,
    navigate,
    cleanupAll: () => cleanupRef.current?.(),
    persistHistorySnapshot,
    handleIncomingMessage,
    handleAck,
  });

  const remoteEntries = useMemo(() => {
    const mySocketId = myId;
    return Object.entries(remoteStreams)
      .filter(
        ([peerId, stream]) =>
          peerId &&
          peerId !== mySocketId &&
          isValidStream(stream) &&
          stream.getTracks().length > 0
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }, [remoteStreams, myId]);

  const participantMap = useMemo(() => {
    const map = {};
    participantsMeta.forEach((p) => {
      map[p.id] = p.meta;
    });
    return map;
  }, [participantsMeta]);

  const socketEmotionMap = useMemo(() => {
    const map = {};
    participantsMeta.forEach((p) => {
      const userId = p.meta?.userId;
      if (userId && emotionsMap[userId]) map[p.id] = emotionsMap[userId];
      if (!map[p.id] && emotionsMap[p.id]) map[p.id] = emotionsMap[p.id];
    });
    return map;
  }, [participantsMeta, emotionsMap]);

  const gridStyle = useMemo(
    () => getGridStyle(remoteEntries.length),
    [remoteEntries.length]
  );

  const cardMinHeight = useMemo(
    () => getCardMinHeight(remoteEntries.length),
    [remoteEntries.length]
  );

  const isLargeRoom = remoteEntries.length >= LARGE_ROOM_THRESHOLD;

  return (
    <div className={styles.meetVideoContainer}>
      <div className={styles.bgSparkles} aria-hidden="true" />

      <AnimatePresence>
        {connecting && (
          <motion.div
            className={styles.connecting}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            role="status"
            aria-live="polite"
          >
            Connecting…
          </motion.div>
        )}
      </AnimatePresence>

      <div className={styles.conferenceWrap}>
        <div
          className={styles.conferenceView}
          aria-live="polite"
          aria-label="Participants"
        >
          {remoteEntries.length === 0 && !connecting && (
            <div className={styles.emptyState} role="status">
              <EmptyStateIcon />
              <span>You're the only one here</span>
            </div>
          )}

          {remoteEntries.length > 0 && (
            <div
              style={{
                display: "grid",
                gap: 10,
                width: "100%",
                height: "100%",
                alignItems: "stretch",
                justifyItems: "stretch",
                ...gridStyle,
              }}
            >
              <AnimatePresence mode={isLargeRoom ? "sync" : "popLayout"}>
                {remoteEntries.map(([peerId, stream]) => (
                  <ParticipantCard
                    key={peerId}
                    peerId={peerId}
                    stream={stream}
                    meta={participantMap[peerId]}
                    emotion={socketEmotionMap[peerId]}
                    isActive={stableSpeakerId === peerId}
                    isHost={isHost}
                    DEBUG_SHOW_EMOTION_FOR_EVERYONE={DEBUG_SHOW_EMOTION_FOR_EVERYONE}
                    style={{ minHeight: cardMinHeight }}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      <motion.div
        className={styles.localPreview}
        initial={{ opacity: 0, scale: 0.92, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
        drag
        dragMomentum={false}
        dragElastic={0.06}
        whileHover={{ scale: 1.03 }}
        whileDrag={{ scale: 1.04, cursor: "grabbing" }}
        aria-label="Your local video preview — drag to reposition"
        title="Your camera preview (drag to move)"
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          aria-label="Your local video"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
        <div
          className={styles.youBadge}
          style={
            stableSpeakerId === "local"
              ? { boxShadow: "0 0 12px rgba(14,165,233,0.7)" }
              : undefined
          }
        >
          You
        </div>
        <div className={styles.previewControls}>
          <button
            className={`${styles.iconButton} ${muted ? styles.active : ""}`}
            onClick={() =>
              toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef)
            }
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
            style={{ minWidth: 30, minHeight: 30, fontSize: "0.82rem", padding: 6 }}
          >
            {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
          </button>
          <button
            className={`${styles.iconButton} ${videoOff ? styles.active : ""}`}
            onClick={() => toggleVideo(videoOff, setVideoOff)}
            aria-label={videoOff ? "Turn camera on" : "Turn camera off"}
            title={videoOff ? "Turn camera on" : "Turn camera off"}
            style={{ minWidth: 30, minHeight: 30, fontSize: "0.82rem", padding: 6 }}
          >
            {videoOff ? <FaVideoSlash /> : <FaVideo />}
          </button>
          {(isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && (
            <button
              className={`${styles.iconButton} ${shareEmotion ? styles.active : ""}`}
              onClick={() => setShareEmotion((v) => !v)}
              aria-pressed={shareEmotion}
              aria-label={shareEmotion ? "Stop sharing emotions" : "Share emotions"}
              title={shareEmotion ? "Stop sharing emotions" : "Share emotions"}
              style={{ minWidth: 30, minHeight: 30, fontSize: 13, padding: 6 }}
            >
              😊
            </button>
          )}
        </div>
      </motion.div>

      <AnimatePresence>
        {chatOpen && (
          <ChatPanel
            chatMessages={chatMessages}
            participantsMeta={participantsMeta}
            myUserId={myUserId}
            retryMessage={retryMessage}
            sendChatMessage={sendChatMessage}
            chatContainerRef={chatContainerRef}
            chatEndRef={chatEndRef}
          />
        )}
      </AnimatePresence>

      <div
        className={styles.buttonContainers}
        role="toolbar"
        aria-label="Meeting controls"
      >
        <button
          className={`${styles.iconButton} ${muted ? styles.active : ""}`}
          onClick={() =>
            toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef)
          }
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          title={muted ? "Unmute (M)" : "Mute (M)"}
          aria-pressed={muted}
        >
          {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
        </button>

        <button
          className={`${styles.iconButton} ${videoOff ? styles.active : ""}`}
          onClick={() => toggleVideo(videoOff, setVideoOff)}
          aria-label={videoOff ? "Turn camera on" : "Turn camera off"}
          title={videoOff ? "Camera on (V)" : "Camera off (V)"}
          aria-pressed={videoOff}
        >
          {videoOff ? <FaVideoSlash /> : <FaVideo />}
        </button>

        <button
          className={styles.iconButton}
          onClick={() => startScreenShare(prevLocalStreamRef)}
          aria-label="Share your screen"
          title="Share screen"
        >
          <FaDesktop />
        </button>

        <div className={styles.controlDivider} aria-hidden="true" />

        <button
          className={`${styles.iconButton} ${chatOpen ? styles.iconButtonChatActive : ""}`}
          onClick={() => setChatOpen((v) => !v)}
          aria-label={chatOpen ? "Close chat" : "Open chat"}
          title="Toggle chat (C)"
          aria-pressed={chatOpen}
          aria-expanded={chatOpen}
        >
          <FaComments />
        </button>

        {(isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && (
          <button
            className={`${styles.iconButton} ${shareEmotion ? styles.active : ""}`}
            onClick={() => setShareEmotion((v) => !v)}
            aria-pressed={shareEmotion}
            aria-label={shareEmotion ? "Stop sharing emotions" : "Share emotions"}
            title={shareEmotion ? "Stop sharing emotions" : "Share emotions"}
          >
            😊
          </button>
        )}

        <div className={styles.controlDivider} aria-hidden="true" />

        <button
          className={`${styles.iconButton} ${styles.leaveButton}`}
          onClick={isHost ? endMeeting : leaveCall}
          aria-label={isHost ? "End meeting for everyone" : "Leave call"}
          title={isHost ? "End meeting" : "Leave call"}
        >
          <FaPhoneSlash />
        </button>
      </div>

      <EmotionServicePanel
        emotionsMap={emotionsMap}
        participantsMeta={participantsMeta}
        isHost={isHost}
        DEBUG_SHOW_EMOTION_FOR_EVERYONE={DEBUG_SHOW_EMOTION_FOR_EVERYONE}
      />
    </div>
  );
}