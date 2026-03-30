import React, { useEffect, useRef, useState, useContext, useCallback } from "react";
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


export default function VideoMeet() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const DEBUG_SHOW_EMOTION_FOR_EVERYONE = false;

  const localVideoRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const prevLocalStreamRef = useRef(null);
  const pcsRef = useRef({});

  const [remoteStreams, setRemoteStreams] = useState({});
  const remoteStreamsRef = useRef(remoteStreams);

  const [connecting, setConnecting] = useState(true);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const [participantsMeta, setParticipantsMeta] = useState([]);
  const [myId, setMyId] = useState(null);

  const {addToUserHistory } = useContext(AuthContext);

  const isHost = !!localStorage.getItem(`host:${(roomId || "").toUpperCase()}`);

  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const videoOffRef = useRef(videoOff);
  useEffect(() => { videoOffRef.current = videoOff; }, [videoOff]);

  const chatEndRef = useRef(null);
  const chatContainerRef = useRef(null);

const {
  chatMessages,
  setChatMessages,
  sendChatMessage,
  retryMessage,
  seenMsgIdsRef,
} = useChat({ socketRef, roomId });
  const {
  activeSpeakerId,
  createAnalyzerForStream,
  removeAnalyzer,
} = useAudioAnalyzer({
  remoteStreams,
  localStreamRef,
  mutedRef,
  pcsRef,
});


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

const [stableSpeakerId, setStableSpeakerId] = useState(null);
const lastSwitchRef = useRef(0);

useEffect(() => {
  if (!activeSpeakerId) return;

  const now = Date.now();


  if (now - lastSwitchRef.current < 700) return;

  lastSwitchRef.current = now;
  setStableSpeakerId(activeSpeakerId);
}, [activeSpeakerId]);

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

  const [shareEmotion, setShareEmotion] = useState(false);
  const [emotionsMap, setEmotionsMap] = useState({});

  const {
    startPeriodicEmotionCapture,
    stopPeriodicEmotionCapture,
  } = useEmotionCapture({
    socketRef,
    remoteStreamsRef,
    myId,
    roomId,
    isHost,
    DEBUG_SHOW_EMOTION_FOR_EVERYONE,
  });

  const {
    toggleMute,
    toggleVideo,
    startScreenShare,
  } = useMediaControls({
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

  const {
  start,
  leaveCall,
  endMeeting,
  cleanupAll,
  persistHistorySnapshot,
} = useMeetingLifecycle({
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

const cleanupRef = useRef(cleanupAll);

useEffect(() => {
  cleanupRef.current = cleanupAll;
}, [cleanupAll]);

useEffect(() => {
    remoteStreamsRef.current = remoteStreams;
  }, [remoteStreams]);

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



  useEffect(() => {
  if (shareEmotion && isHost) {
    startPeriodicEmotionCapture({});
  } else {
    stopPeriodicEmotionCapture();
  }
}, [shareEmotion, myId, isHost]);


const closePeer = useCallback((peerId) => {
  const pc = pcsRef.current[peerId];

  if (pc) {
    try {
      pc.close();
    } catch {}
    delete pcsRef.current[peerId];
  }

  setRemoteStreams((prev) => {
    if (!prev[peerId]) return prev;
    const copy = { ...prev };
    delete copy[peerId];
    return copy;
  });
}, []);

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
});


 const remoteEntries = Object.entries(remoteStreams)
  .filter(
    ([peerId, stream]) =>
      peerId && peerId !== myId && stream && stream.getTracks().length
  )
  .sort(([a], [b]) => a.localeCompare(b));


const socketEmotionMap = React.useMemo(() => {
  const map = {};
  participantsMeta.forEach((p) => {
    const userId = p.meta?.userId;
    if (userId && emotionsMap[userId]) {
      map[p.id] = emotionsMap[userId];
    }
  });
  return map;
}, [participantsMeta, emotionsMap]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, chatOpen]);

  useEffect(() => {
  const onKeyDown = (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (["INPUT", "TEXTAREA"].includes(tag)) return;

    if (e.key === "m" || e.key === "M")
      toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef);

    if (e.key === "v" || e.key === "V")
      toggleVideo(videoOff, setVideoOff);

    if (e.key === "c" || e.key === "C")
      setChatOpen((v) => !v);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [muted, videoOff, chatOpen, toggleMute, toggleVideo]);


  return (
    <div className={`${styles.meetVideoContainer} ${chatOpen ? styles.chatOpen : ""}`}>
      <div className={styles.bgSparkles} aria-hidden />

      {connecting && <div className={styles.connecting}>Connecting...</div>}

      <div className={styles.conferenceWrap}>
        <div className={styles.conferenceView} aria-live="polite">

  {/* 🧍 Empty state */}
  {remoteEntries.length === 0 && !connecting && (
    <div className={styles.emptyState}>
      You're the only one here
    </div>
  )}

  <div
  style={{
    display: "grid",
    gap: 12,
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    width: "100%",
  }}
>
  {remoteEntries.map(([peerId, stream]) => (
  <ParticipantCard
    key={peerId}
    peerId={peerId}
    stream={stream}
    meta={participantsMeta.find(p => p.id === peerId)?.meta}
    emotion={socketEmotionMap[peerId]}   // 🔥 use this
    isActive={stableSpeakerId === peerId}
    isHost={isHost}
    DEBUG_SHOW_EMOTION_FOR_EVERYONE={DEBUG_SHOW_EMOTION_FOR_EVERYONE}
  />
))}
</div>

</div>
      </div>

      <motion.div
        className={styles.localPreview}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        drag
        dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
        dragMomentum={false}
        whileHover={{ scale: 1.02 }}
        aria-label="Local preview"
        title="Local preview (drag to reposition)"
        style={{
          width: 200,
          height: 112,
          borderRadius: 8,
          overflow: "hidden",
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 80,
        }}
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <div className={styles.youBadge} style={stableSpeakerId === "local" ? { boxShadow: "0 0 14px rgba(0,150,255,0.9)" } : {}}>
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
            style={{ minWidth: 40, minHeight: 40 }}
          >
            {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
          </button>

          <button
            className={`${styles.iconButton} ${videoOff ? styles.active : ""}`}
            onClick={() =>
  toggleVideo(videoOff, setVideoOff)
}
            aria-label={videoOff ? "Turn camera on" : "Turn camera off"}
            title={videoOff ? "Turn camera on" : "Turn camera off"}
            style={{ minWidth: 40, minHeight: 40 }}
          >
            {videoOff ? <FaVideoSlash /> : <FaVideo />}
          </button>

{(isHost || DEBUG_SHOW_EMOTION_FOR_EVERYONE) && (
  <button
    className={`${styles.iconButton} ${shareEmotion ? styles.active : ""}`}
    onClick={() => {
      const next = !shareEmotion;
      setShareEmotion(next);
    }}
    aria-pressed={shareEmotion}
    aria-label={shareEmotion ? "Stop sending remote emotion clips" : "Send remote emotion clips to host"}
    title={shareEmotion ? "Stop sending remote emotion clips" : "Send remote emotion clips to host"}
    style={{ minWidth: 40, minHeight: 40, fontSize: 16 }}
  >
    😊
  </button>
)}

        </div>
      </motion.div>

      <AnimatePresence>
  {chatOpen && (
    <motion.aside
      className={styles.chatRoom}
      initial={{ opacity: 0, x: 60 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 60 }}
      transition={{ duration: 0.2 }}
    >
      {/* HEADER */}
      <div className={styles.chatHeader}>
        <FaRegComments />
        <strong>Chat</strong>

        <div
          style={{
            marginLeft: "auto",
            fontSize: 13,
            opacity: 0.7,
          }}
        >
          {participantsMeta.length} in call
        </div>
      </div>

      {/* MESSAGES */}
      <div
        ref={chatContainerRef}
        className={styles.chatMessages}
        role="log"
        aria-live="polite"
      >
        {chatMessages.map((m) => {
          const socketId = socketRef.current?.id;
          const myUserId = localStorage.getItem("userId") || socketId;

          const isOwn =
            m.from === myUserId || m.userId === myUserId;

          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              style={{
                display: "flex",
                justifyContent: isOwn ? "flex-end" : "flex-start",
                padding: "2px 6px",
              }}
            >
              <div
                style={{
                  background: isOwn ? "#DCF8C6" : "#fff",
                  color: "#111",
                  padding: "8px 12px",
                  borderRadius: 14,
                  maxWidth: "72%",
                  wordBreak: "break-word",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
                }}
              >
                {/* MESSAGE TEXT */}
                <div style={{ fontSize: 14 }}>{m.text}</div>

                {/* META (name + time + status) */}
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    opacity: 0.7,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  {/* NAME */}
                  <span style={{ fontWeight: 600 }}>
                    {isOwn ? "You" : m.meta?.name || "User"}
                  </span>

                  {/* TIME + STATUS */}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span>
                      {new Date(m.ts).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>

                    {/* ✅ STATUS */}
                    {isOwn && (
                      <>
                        {m.status === "pending" && (
                          <span style={{ opacity: 0.5 }}>●</span>
                        )}
                        {m.status === "sent" && (
                          <span style={{ color: "#4caf50" }}>✓</span>
                        )}
                        {m.status === "failed" && (
                          <span
                            onClick={() => retryMessage(m)}
                            style={{
                              color: "red",
                              cursor: "pointer",
                              fontWeight: 700,
                            }}
                            title="Retry"
                          >
                            !
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}

        <div ref={chatEndRef} />
      </div>

      {/* INPUT */}
      <div className={styles.chattingArea}>
        <ChatInput onSend={(t) => sendChatMessage(t)} />
      </div>
    </motion.aside>
  )}
</AnimatePresence>


<div className={styles.buttonContainers} role="toolbar">

  <button
    onClick={() =>
      toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef)
    }
    className={`${styles.iconButton} ${muted ? styles.active : ""}`}
  >
    {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
  </button>

  <button
    onClick={() =>
      toggleVideo(videoOff, setVideoOff)
    }
    className={`${styles.iconButton} ${videoOff ? styles.active : ""}`}
  >
    {videoOff ? <FaVideoSlash /> : <FaVideo />}
  </button>

  <button
    onClick={() =>
      startScreenShare(prevLocalStreamRef)
    }
    className={styles.iconButton}
  >
    <FaDesktop />
  </button>

  <button
    onClick={() => setChatOpen((v) => !v)}
    className={styles.iconButton}
  >
    <FaComments />
  </button>

  {isHost ? (
    <button onClick={endMeeting} className={`${styles.iconButton} ${styles.leaveButton}`}>
      <FaPhoneSlash />
    </button>
  ) : (
    <button onClick={leaveCall} className={`${styles.iconButton} ${styles.leaveButton}`}>
      <FaPhoneSlash />
    </button>
  )}

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
