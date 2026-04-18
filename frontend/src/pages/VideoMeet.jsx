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
import { motion, AnimatePresence } from "framer-motion";
import useWebRTC from "../hooks/useWebRTC";
import useSocket from "../hooks/useSocket";
import useRecording from "../hooks/useRecording";
import useMediaControls from "../hooks/useMediaControls";
import EmotionServicePanel from "./EmotionServicePanel";
import useAudioAnalyzer from "../hooks/useAudioAnalyzer";
import useEmotionCapture from "../hooks/useEmotionCapture";
import MeetTopBar from "./MeetTopBar";
import MeetControlBar from "./MeetControlBar";
import MeetChatPanel from "./MeetChatPanel";
import MeetLocalPreview from "./MeetLocalPreview";
import MobilePanelSheet from "./MobilePanelSheet";
import s from "../styles/videoComponent.module.css";

const HOST_ONLY_EMOTION = true;

function isValidStream(stream) {
  return (
    stream &&
    typeof stream.getTracks === "function" &&
    stream.getTracks().some((t) => t.readyState === "live")
  );
}

function useIsMobile(bp = 900) {
  const [val, setVal] = useState(() => window.innerWidth <= bp);
  useEffect(() => {
    const h = () => setVal(window.innerWidth <= bp);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [bp]);
  return val;
}

function EmptyState() {
  return (
    <div className={s.emptyState}>
      <div className={s.emptyOrb} />
      <div className={s.emptyIcon}>
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
      </div>
      <p className={s.emptyTitle}>Waiting for others to join</p>
      <p className={s.emptySub}>Share your meeting link to get started</p>
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

  const [endingMeeting, setEndingMeeting] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [connecting, setConnecting] = useState(true);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsMeta, setParticipantsMeta] = useState([]);
  const [socketReady, setSocketReady] = useState(0);
  const [spotlightPeerId, setSpotlightPeerId] = useState(null);
  const [myId, setMyId] = useState(null);
  const [shareEmotion, setShareEmotion] = useState(false);
  const [emotionsMap, setEmotionsMap] = useState({});
  const [stableSpeakerId, setStableSpeakerId] = useState(null);
  const [meetDuration, setMeetDuration] = useState(0);
  const [streamVersion, setStreamVersion] = useState(0);

  const [mobileSheet, setMobileSheet] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const isMobile = useIsMobile(900);
  const participantsMetaRef = useRef([]);
  useEffect(() => {
    participantsMetaRef.current = participantsMeta;
  }, [participantsMeta]);

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
  useEffect(() => { activeSpeakerIdRef.current = stableSpeakerId; }, [stableSpeakerId]);

  useEffect(() => {
    const id = setInterval(() => setMeetDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const unwrappedRemoteStreams = useMemo(() => {
    const out = {};
    for (const [id, entry] of Object.entries(remoteStreams))
      out[id] = entry?.stream ?? entry;
    return out;
  }, [remoteStreams, streamVersion]);

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

  const prevMsgCountRef = useRef(0);

  useEffect(() => {
    const isChatVisible = isMobile ? mobileSheet === "chat" : chatOpen;
    if (isChatVisible) {
      setUnreadCount(0);
      prevMsgCountRef.current = chatMessages.length;
      return;
    }
    const newCount = chatMessages.length - prevMsgCountRef.current;
    if (newCount > 0) setUnreadCount((n) => n + newCount);
    prevMsgCountRef.current = chatMessages.length;
  }, [chatMessages.length, isMobile, mobileSheet, chatOpen]);

  const participantsMetaMap = useMemo(() => {
    const map = {};
    (participantsMeta || []).forEach((p) => {
      map[p.id] = { muted: p?.meta?.muted === true };
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
    setRemoteStreams: (updater) => {
      setRemoteStreams(updater);
      setStreamVersion((v) => v + 1);
    },
    createAnalyzerForStream,
    removeAnalyzer,
    recordersRef,
    ICE_CONFIG,
  });

  const emotionSocketRef = useEmotionSocket({ setEmotionsMap });

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

  const {
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
    makingOfferRef,
    politeRef,
    pendingCandidatesRef,
    ignoreOfferRef,
    isSettingRemoteAnswerPending,
    SOCKET_SERVER_URL,
    onSocketReady: () => setSocketReady((n) => n + 1),
  });

  useEffect(() => { cleanupRef.current = cleanupAll; }, [cleanupAll]);

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
        try { pc.close(); } catch { }
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
      setStreamVersion((v) => v + 1);
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
    if (!activeSpeakerId) { setStableSpeakerId(null); return; }
    setStableSpeakerId(activeSpeakerId);
  }, [activeSpeakerId]);

  useEffect(
    () => () => { if (speakerTimerRef.current) clearTimeout(speakerTimerRef.current); },
    []
  );

  useEffect(() => {
    if (!isHost) return;
    if (shareEmotion) startPeriodicEmotionCapture({});
    else stopPeriodicEmotionCapture();
  }, [shareEmotion, isHost, startPeriodicEmotionCapture, stopPeriodicEmotionCapture]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      if (e.key === "m" || e.key === "M")
        toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef);
      else if (e.key === "v" || e.key === "V")
        toggleVideo(videoOffRef.current, setVideoOff);
      else if (e.key === "c" || e.key === "C") {
        if (isMobile) setMobileSheet((v) => (v === "chat" ? null : "chat"));
        else setChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMute, toggleVideo, isMobile]);

  useEffect(() => () => { Object.keys(pcsRef.current).forEach((pid) => closePeer(pid)); }, []);

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

  const remoteEntries = useMemo(
    () =>
      Object.entries(unwrappedRemoteStreams)
        .filter(([peerId, stream]) => peerId && peerId !== myId && isValidStream(stream))
        .sort(([a], [b]) => a.localeCompare(b)),
    [unwrappedRemoteStreams, myId, streamVersion]
  );

  const effectiveSpotlightId = useMemo(() => {
    if (!remoteEntries.length) return null;
    if (spotlightPeerId && remoteEntries.some(([id]) => id === spotlightPeerId))
      return spotlightPeerId;
    if (stableSpeakerId && remoteEntries.some(([id]) => id === stableSpeakerId))
      return stableSpeakerId;
    return remoteEntries[0][0];
  }, [remoteEntries, spotlightPeerId, stableSpeakerId]);

  const activeEntry = useMemo(
    () => !effectiveSpotlightId ? null : remoteEntries.find(([id]) => id === effectiveSpotlightId) || null,
    [remoteEntries, effectiveSpotlightId]
  );

  const otherEntries = useMemo(
    () => !activeEntry ? remoteEntries : remoteEntries.filter(([id]) => id !== activeEntry[0]),
    [remoteEntries, activeEntry]
  );

  const participantMap = useMemo(() => {
    const map = {};
    participantsMeta.forEach((p) => { map[p.id] = p.meta; });
    return map;
  }, [participantsMeta]);

  const socketEmotionMap = useMemo(() => {
    if (!isHost && HOST_ONLY_EMOTION) return {};
    const map = {};
    participantsMeta.forEach((p) => {
      const userId = p.meta?.userId;
      const history = (userId && emotionsMap[userId]) || emotionsMap[p.id] || [];
      if (Array.isArray(history) && history.length) map[p.id] = history;
    });
    return map;
  }, [participantsMeta, emotionsMap, isHost]);

  const handleLeaveEnd = useCallback(async () => {
    if (endingMeeting) return;
    setEndingMeeting(true);
    try {
      if (isHost) await endMeeting();
      else await leaveCall();
    } finally {
      setEndingMeeting(false);
    }
  }, [endingMeeting, isHost, endMeeting, leaveCall]);

  const handleToggleChat = useCallback(() => {
    if (isMobile) {
      setMobileSheet((v) => (v === "chat" ? null : "chat"));
      setUnreadCount(0);
    } else {
      setChatOpen((v) => !v);
    }
  }, [isMobile]);

  const handleToggleEmotion = useCallback(() => {
    if (isMobile && isHost) {
      setShareEmotion((v) => !v);
      setMobileSheet((v) => (v === "emotion" ? null : "emotion"));
    } else {
      setShareEmotion((v) => !v);
    }
  }, [isMobile, isHost]);

  const multiPartyLayout = remoteEntries.length > 0 && activeEntry;
  const showEmotionPanel = isHost && shareEmotion && !isMobile;

  const mobileParticipantCount = remoteEntries.length;

  return (
    <div className={s.shell}>
      <div className={s.bgMesh} aria-hidden="true" />

      <MeetTopBar
        roomId={roomId}
        isHost={isHost}
        duration={meetDuration}
        participantCount={participantsMeta.length + 1}
        connecting={connecting}
      />

      <div className={s.body}>
        <div className={s.videoArea}>
          {remoteEntries.length === 0 && !connecting && <EmptyState />}

          {multiPartyLayout && (
            <div
              className={`${s.stageLayout} ${isMobile ? s.stageLayoutMobile : ""}`}
              style={isMobile ? getMobileStageStyle(mobileParticipantCount) : undefined}
            >
              <div
                className={s.spotlightWrap}
                style={isMobile ? getMobileSpotlightStyle(mobileParticipantCount) : undefined}
              >
                {activeEntry && (
                  <SpotlightCard
                    key={activeEntry[0]}
                    id={activeEntry[0]}
                    stream={activeEntry[1]}
                    meta={participantMap[activeEntry[0]]}
                    emotion={isHost ? socketEmotionMap[activeEntry[0]]?.at(-1) : undefined}
                    isActive={stableSpeakerId === activeEntry[0]}
                    isHost={isHost}
                  />
                )}
              </div>

              {otherEntries.length > 0 && (
                <div
                  className={`${s.filmstrip} ${isMobile ? s.filmstripHoriz : ""}`}
                  style={isMobile ? getMobileFilmstripStyle(mobileParticipantCount) : undefined}
                >
                  {otherEntries.map(([peerId, stream]) => (
                    <ParticipantCard
                      key={peerId}
                      peerId={peerId}
                      stream={stream}
                      meta={participantMap[peerId]}
                      emotion={isHost ? socketEmotionMap[peerId]?.at(-1) : undefined}
                      isActive={stableSpeakerId === peerId}
                      isHost={isHost}
                      compact
                      style={isMobile ? getMobileCardStyle(mobileParticipantCount) : undefined}
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

        <AnimatePresence>
          {chatOpen && !isMobile && (
            <MeetChatPanel
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

        <AnimatePresence>
          {showEmotionPanel && (
            <motion.div
              key="emotion-panel"
              initial={{ opacity: 0, x: -40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              <div style={{ pointerEvents: "all" }}>
                <EmotionServicePanel
                  emotionsMap={socketEmotionMap}
                  participantsMeta={participantsMeta}
                  isHost={isHost}
                  DEBUG_SHOW_EMOTION_FOR_EVERYONE={false}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <MeetLocalPreview
        localVideoRef={localVideoRef}
        displayName={localStorage.getItem("displayName") || "You"}
        isHost={isHost}
        isSpeaking={stableSpeakerId === "local"}
        muted={muted}
        videoOff={videoOff}
        shareEmotion={shareEmotion}
        onToggleMute={() => toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef)}
        onToggleVideo={() => toggleVideo(videoOff, setVideoOff)}
        onToggleEmotion={handleToggleEmotion}
      />

      <MeetControlBar
        muted={muted}
        videoOff={videoOff}
        chatOpen={isMobile ? mobileSheet === "chat" : chatOpen}
        shareEmotion={shareEmotion}
        isHost={isHost}
        endingMeeting={endingMeeting}
        unreadCount={unreadCount}
        onToggleMute={() => toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef)}
        onToggleVideo={() => toggleVideo(videoOff, setVideoOff)}
        onScreenShare={() => startScreenShare(prevLocalStreamRef)}
        onToggleChat={handleToggleChat}
        onToggleEmotion={handleToggleEmotion}
        onLeaveEnd={handleLeaveEnd}
      />

      {isMobile && (
        <MobilePanelSheet
          activeSheet={mobileSheet}
          onClose={() => setMobileSheet(null)}
          onTabChange={(tab) => {
            setMobileSheet(tab);
            if (tab === "chat") setUnreadCount(0);
          }}
          showEmotionTab={isHost && shareEmotion}
          chatMessages={chatMessages}
          participantsMeta={participantsMeta}
          myUserId={myUserId}
          retryMessage={retryMessage}
          sendChatMessage={sendChatMessage}
          emotionsMap={socketEmotionMap}
          isHost={isHost}
        />
      )}
    </div>
  );
}

function getMobileStageStyle(count) {
  if (count === 1) {
    return {
      flexDirection: "column",
      height: "100%",
    };
  }
  return {
    flexDirection: "column",
    height: "100%",
  };
}

function getMobileSpotlightStyle(count) {
  if (count === 1) {
    return { flex: "1 1 0", minHeight: 0 };
  }
  return { flex: "1 1 0", minHeight: 0 };
}

function getMobileFilmstripStyle(count) {
  return {
    flexDirection: "row",
    height: "120px",
    minHeight: "120px",
    flexShrink: 0,
    width: "100%",
    overflowX: "auto",
    overflowY: "hidden",
    display: "flex",
    gap: "6px",
    padding: "4px",
  };
}

function getMobileCardStyle(count) {
  return {
    width: "160px",
    height: "112px",
    minWidth: "160px",
    flexShrink: 0,
    borderRadius: "10px",
  };
}