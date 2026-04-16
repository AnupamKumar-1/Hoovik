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
import SpotlightCard from "./SpotlightCard";
import useChat from "../hooks/useChat";
import useEmotionSocket from "../hooks/useEmotionSocket";
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

const HOST_ONLY_EMOTION = true;

function isValidStream(s) {
  return (
    s &&
    typeof s.getTracks === "function" &&
    s.getTracks().some((t) => t.readyState === "live")
  );
}

function useIsScrolledToBottom(ref, threshold = 60) {
  return useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, [ref, threshold]);
}

function useIsMobile(breakpoint = 600) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

function ChatPanel({
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
          {participantsMeta.length + 1} in call
        </div>
        <button
          onClick={onClose}
          aria-label="Close chat"
          title="Close chat"
          style={{
            marginLeft: "8px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "26px",
            height: "26px",
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.08)",
            background: "transparent",
            color: "var(--vm-muted-bright)",
            cursor: "pointer",
            flexShrink: 0,
            transition: "background 130ms ease, color 130ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.07)";
            e.currentTarget.style.color = "var(--vm-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--vm-muted-bright)";
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
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
            <FaRegComments
              size={20}
              style={{ opacity: 0.3, color: "var(--vm-muted-bright)" }}
            />
            <p className={styles.chatEmptyStateText}>
              No messages yet.
              <br />
              Say hello! 👋
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
                  <span className={styles.msgMetaName}>
                    {m.meta?.name || "User"}
                  </span>
                </div>
              )}
              <div
                className={`${styles.msgBubble} ${isOwn ? styles.msgBubbleOwn : styles.msgBubbleOther
                  }`}
              >
                {m.text}
              </div>
              <div className={styles.msgMeta}>
                {isOwn && (
                  <span
                    className={`${styles.msgMetaName} ${styles.msgMetaNameOwn}`}
                  >
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
  const activeSpeakerIdRef = useRef(null);
  const spotlightPeerRef = useRef(null);
  const ignoreOfferRef = useRef({});
  const isSettingRemoteAnswerPending = useRef({});

  const [remoteStreams, setRemoteStreams] = useState({});
  const [connecting, setConnecting] = useState(true);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsMeta, setParticipantsMeta] = useState([]);
  const [socketReady, setSocketReady] = useState(0);
  const [spotlightPeerId, setSpotlightPeerId] = useState(null);

  const isMobile = useIsMobile(600);

  const participantsMetaRef = useRef([]);
  useEffect(() => {
    participantsMetaRef.current = participantsMeta;
  }, [participantsMeta]);

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
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    videoOffRef.current = videoOff;
  }, [videoOff]);

  useEffect(() => {
    activeSpeakerIdRef.current = stableSpeakerId;
  }, [stableSpeakerId]);

  const unwrappedRemoteStreams = useMemo(() => {
    const out = {};
    for (const [id, entry] of Object.entries(remoteStreams)) {
      out[id] = entry?.stream ?? entry;
    }
    return out;
  }, [remoteStreams]);

  useEffect(() => {
    remoteStreamsRef.current = unwrappedRemoteStreams;
  }, [unwrappedRemoteStreams]);

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

  const participantsMetaMap = useMemo(() => {
    const map = {};
    (participantsMeta || []).forEach((p) => {
      map[p.id] = {
        muted: p?.meta?.muted === true,
      };
    });
    return map;
  }, [participantsMeta]);

  const {
    activeSpeakerId,
    createAnalyzerForStream,
    removeAnalyzer,
    notifyPcsChanged,
  } = useAudioAnalyzer({
    remoteStreams: unwrappedRemoteStreams,
    localStreamRef,
    mutedRef,
    pcsRef,
    participantsMetaMap,
  });

  const {
    recordersRef,
    startRecordingForStream,
    stopAllRecorders,
    uploadRecordingsAndStoreTranscript,
  } = useRecording({
    isHost,
    roomId,
    participantsMetaRef,
    TRANSCRIPTS_ENABLED,
    TRANSCRIPT_ENDPOINT,
    API_BASE,
  });

  const {
    createPeerConnection,
    handleSignal,
    politeRef,
    pendingCandidatesRef,
    makingOfferRef,
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

  const emotionSocketRef = useEmotionSocket({
    setEmotionsMap,
  });

  const { startPeriodicEmotionCapture, stopPeriodicEmotionCapture } =
    useEmotionCapture({
      socketRef: emotionSocketRef,
      remoteStreamsRef,
      participantsMetaRef,
      myId,
      roomId,
      isHost,
      DEBUG_SHOW_EMOTION_FOR_EVERYONE: false,
      activeSpeakerIdRef,
    });

  const { toggleMute, toggleVideo, startScreenShare } = useMediaControls({
    localStreamRef,
    localVideoRef,
    pcsRef,
    socketRef,
    myUserId,
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
      makingOfferRef,
      politeRef,
      pendingCandidatesRef,
      ignoreOfferRef,
      isSettingRemoteAnswerPending,
      SOCKET_SERVER_URL,
      onSocketReady: () => setSocketReady((n) => n + 1),
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

  const closePeer = useCallback(
    (peerId) => {
      const pc = pcsRef.current[peerId];
      if (pc) {
        try {
          pc.close();
        } catch { }
        delete pcsRef.current[peerId];
      }
      try {
        const rec = recordersRef.current?.[peerId];
        if (rec?.state === "recording") rec.stop();
        delete recordersRef.current[peerId];
      } catch { }

      removeAnalyzer(peerId);
      notifyPcsChanged();

      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });

      setStableSpeakerId((prev) => (prev === peerId ? null : prev));

      setSpotlightPeerId((prev) => {
        if (prev !== peerId) return prev;
        spotlightPeerRef.current = null;
        return null;
      });
    },
    [pcsRef, recordersRef, removeAnalyzer, notifyPcsChanged]
  );

  useEffect(() => {
    if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
    if (!activeSpeakerId) {
      setStableSpeakerId(null);
      return;
    }
    setStableSpeakerId(activeSpeakerId);
  }, [activeSpeakerId]);

  useEffect(() => {
    return () => {
      if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isHost) return;
    if (shareEmotion) {
      startPeriodicEmotionCapture({});
    } else {
      stopPeriodicEmotionCapture();
    }
  }, [shareEmotion, isHost, startPeriodicEmotionCapture, stopPeriodicEmotionCapture]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || "").toUpperCase();
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;
      if (isEditable) return;
      if (e.key === "m" || e.key === "M") {
        toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef);
      } else if (e.key === "v" || e.key === "V") {
        toggleVideo(videoOffRef.current, setVideoOff);
      } else if (e.key === "c" || e.key === "C") {
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMute, toggleVideo]);

  useEffect(() => {
    return () => {
      Object.keys(pcsRef.current).forEach((peerId) => closePeer(peerId));
    };
  }, []);

  useSocket({
    socketRef,
    roomId,
    setMyId,
    setParticipantsMeta,
    setChatMessages,
    seenMsgIdsRef,
    createPeerConnection,
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
    notifyPcsChanged,
    makingOfferRef,
    socketReady,
  });

  const remoteEntries = useMemo(() => {
    return Object.entries(unwrappedRemoteStreams)
      .filter(
        ([peerId, stream]) =>
          peerId && peerId !== myId && isValidStream(stream)
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }, [unwrappedRemoteStreams, myId]);

  const effectiveSpotlightId = useMemo(() => {
    if (remoteEntries.length === 0) return null;

    if (spotlightPeerId && remoteEntries.some(([id]) => id === spotlightPeerId)) {
      return spotlightPeerId;
    }

    if (stableSpeakerId && remoteEntries.some(([id]) => id === stableSpeakerId)) {
      return stableSpeakerId;
    }

    return remoteEntries[0][0];
  }, [remoteEntries, spotlightPeerId, stableSpeakerId]);

  const activeEntry = useMemo(() => {
    if (!effectiveSpotlightId) return null;
    return remoteEntries.find(([id]) => id === effectiveSpotlightId) || null;
  }, [remoteEntries, effectiveSpotlightId]);

  const otherEntries = useMemo(() => {
    if (!activeEntry) return remoteEntries;
    return remoteEntries.filter(([id]) => id !== activeEntry[0]);
  }, [remoteEntries, activeEntry]);

  const participantMap = useMemo(() => {
    const map = {};
    participantsMeta.forEach((p) => {
      map[p.id] = p.meta;
    });
    return map;
  }, [participantsMeta]);

  const socketEmotionMap = useMemo(() => {
    if (!isHost && HOST_ONLY_EMOTION) return {};
    const map = {};
    participantsMeta.forEach((p) => {
      const userId = p.meta?.userId;
      const history =
        (userId && emotionsMap[userId]) || emotionsMap[p.id] || [];
      if (Array.isArray(history) && history.length) map[p.id] = history;
    });
    return map;
  }, [participantsMeta, emotionsMap, isHost]);

  const multiPartyLayout = remoteEntries.length > 0 && activeEntry;

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

          {multiPartyLayout && (
            <div
              style={{
                display: "flex",
                flexDirection: isMobile ? "column" : "row",
                width: "100%",
                height: "100%",
                gap: 10,
                minWidth: 0,
                minHeight: 0,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                {activeEntry && (
                  <SpotlightCard
                    key={activeEntry[0]}
                    id={activeEntry[0]}
                    stream={activeEntry[1]}
                    meta={participantMap[activeEntry[0]]}
                    emotion={
                      isHost
                        ? socketEmotionMap[activeEntry[0]]?.at(-1)
                        : undefined
                    }
                    isActive={stableSpeakerId === activeEntry[0]}
                    isHost={isHost}
                  />
                )}
              </div>

              {otherEntries.length > 0 && (
                <div
                  className={styles.rightColumn}
                  style={isMobile ? {
                    width: "100%",
                    flexDirection: "row",
                    height: 90,
                    overflowX: "auto",
                    overflowY: "hidden",
                    flexShrink: 0,
                  } : undefined}
                >
                  {otherEntries.map(([peerId, stream]) => (
                    <ParticipantCard
                      key={peerId}
                      peerId={peerId}
                      stream={stream}
                      meta={participantMap[peerId]}
                      emotion={
                        isHost
                          ? socketEmotionMap[peerId]?.at(-1)
                          : undefined
                      }
                      isActive={stableSpeakerId === peerId}
                      isHost={isHost}
                      compact
                      onClick={() => {
                        spotlightPeerRef.current = peerId;
                        setSpotlightPeerId(peerId);
                      }}
                    />
                  ))}
                </div>
              )}
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
          {localStorage.getItem("displayName") || "You"}
          {isHost && (
            <span
              style={{
                marginLeft: 4,
                fontSize: "0.7em",
                opacity: 0.75,
                fontWeight: 600,
              }}
            >
              (Host)
            </span>
          )}
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
          {isHost && (
            <button
              className={`${styles.iconButton} ${shareEmotion ? styles.active : ""}`}
              onClick={() => setShareEmotion((v) => !v)}
              aria-pressed={shareEmotion}
              aria-label={shareEmotion ? "Stop emotion detection" : "Start emotion detection"}
              title={shareEmotion ? "Stop emotion detection" : "Start emotion detection (host only)"}
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
            onClose={() => setChatOpen(false)}
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

        {isHost && (
          <button
            className={`${styles.iconButton} ${shareEmotion ? styles.active : ""}`}
            onClick={() => setShareEmotion((v) => !v)}
            aria-pressed={shareEmotion}
            aria-label={shareEmotion ? "Stop emotion detection" : "Start emotion detection"}
            title={shareEmotion ? "Stop emotion detection" : "Start emotion detection (host only)"}
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

      {isHost && (
        <EmotionServicePanel
          emotionsMap={socketEmotionMap}
          participantsMeta={participantsMeta}
          isHost={isHost}
          DEBUG_SHOW_EMOTION_FOR_EVERYONE={false}
        />
      )}
    </div>
  );
}