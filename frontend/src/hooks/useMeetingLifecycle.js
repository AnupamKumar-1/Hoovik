import { useEffect, useRef, useCallback } from "react";
import io from "socket.io-client";
import {
  initMediaController,
  setExternalCleaners,
} from "../utils/mediaController";
import { notifyLocalStreamReady } from "./useWebRTC";

export default function useMeetingLifecycle({
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
  onSocketReady,
}) {
  const participantsMetaRef = useRef(participantsMeta);
  const isHostRef = useRef(isHost);
  const startedRef = useRef(false);

  useEffect(() => {
    participantsMetaRef.current = participantsMeta;
  }, [participantsMeta]);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  const persistHistorySnapshot = useCallback(async () => {
    if (!isHostRef.current || typeof addToUserHistory !== "function") return;
    try {
      const participantList = (participantsMetaRef.current || []).map(
        (p) =>
          p?.meta?.name ||
          p?.meta?.displayName ||
          p?.meta?.username ||
          p?.id ||
          "Guest"
      );
      await addToUserHistory({
        meetingCode: (roomId || "").toUpperCase(),
        hostName: localStorage.getItem("displayName") || "Host",
        participants: participantList,
        createdAt: new Date().toISOString(),
        link: `${window.location.origin}/room/${(roomId || "").toUpperCase()}`,
      });
    } catch { }
  }, [roomId, addToUserHistory]);

  const cleanupAll = useCallback(async () => {
    try {
      socketRef.current?.removeAllListeners?.();
      socketRef.current?.disconnect();
    } catch { }
    if (socketRef && "current" in socketRef) {
      socketRef.current = null;
    }

    try {
      window.myId = null;
    } catch { }

    try {
      localStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch { }

    try {
      prevLocalStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch { }

    try {
      const prev = window.__previousLocalStreamForToggle;
      if (prev?.getTracks) {
        prev.getTracks().forEach((t) => t.stop());
      }
      window.__previousLocalStreamForToggle = null;
    } catch { }

    if (localVideoRef.current) {
      try {
        localVideoRef.current.pause();
        localVideoRef.current.srcObject = null;
      } catch { }
    }

    localStreamRef.current = null;
    prevLocalStreamRef.current = null;

    try {
      Object.values(pcsRef.current || {}).forEach((pc) => {
        try {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onnegotiationneeded = null;
          pc.close();
        } catch { }
      });
    } catch { }

    pcsRef.current = {};

    const resetRef = (ref) => {
      if (!ref) return;
      if (typeof ref !== "object") return;
      if (!("current" in ref)) return;
      ref.current = {};
    };

    resetRef(makingOfferRef);
    resetRef(politeRef);
    resetRef(pendingCandidatesRef);
    resetRef(ignoreOfferRef);
    resetRef(isSettingRemoteAnswerPending);
    resetRef(recordersRef);

    setRemoteStreams({});
    setParticipantsMeta([]);

    try {
      stopPeriodicEmotionCapture();
    } catch { }

    startedRef.current = false;
  }, [
    socketRef,
    localStreamRef,
    prevLocalStreamRef,
    localVideoRef,
    pcsRef,
    setRemoteStreams,
    setParticipantsMeta,
    stopPeriodicEmotionCapture,
  ]);

  async function start() {
    try {
      setConnecting(true);
      pcsRef.current = {};

      const resetRef = (ref) => {
        if (!ref) return;
        if (typeof ref !== "object") return;
        if (!("current" in ref)) return;
        ref.current = {};
      };

      resetRef(makingOfferRef);
      resetRef(politeRef);
      resetRef(pendingCandidatesRef);
      resetRef(ignoreOfferRef);
      resetRef(isSettingRemoteAnswerPending);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        try {
          await localVideoRef.current.play();
        } catch { }
      }

      createAnalyzerForStream("local", stream);
      startRecordingForStream("local", stream);

      notifyLocalStreamReady(stream);

      if (socketRef.current) {
        try {
          socketRef.current.removeAllListeners();
          socketRef.current.disconnect();
        } catch { }
      }

      const socket = io(SOCKET_SERVER_URL, { autoConnect: false });
      socketRef.current = socket;

      await new Promise((resolve, reject) => {
        const TO = setTimeout(() => reject(new Error()), 8000);

        const cleanup = () => {
          clearTimeout(TO);
          socket.off("connect", onConnect);
          socket.off("connect_error", onError);
        };

        const onConnect = () => {
          cleanup();
          resolve();
        };

        const onError = () => {
          cleanup();
          reject();
        };

        socket.on("connect", onConnect);
        socket.on("connect_error", onError);
        socket.connect();
      });

      onSocketReady?.();

      initMediaController(
        localStreamRef.current,
        socketRef.current,
        pcsRef.current,
        localVideoRef.current
      );

      try {
        setExternalCleaners({
          recordersRef,
          removeAnalyzerFn: removeAnalyzer,
          prevLocalStreamRef,
        });
      } catch { }

      const token =
        localStorage.getItem("token") || localStorage.getItem("accessToken");

      let uid = null;

      if (token) {
        try {
          const payload = JSON.parse(atob(token.split(".")[1]));
          uid = payload._id || payload.sub;
        } catch { }
      }

      if (!uid) {
        uid = localStorage.getItem("userId");
        if (!uid) {
          uid = crypto.randomUUID();
          localStorage.setItem("userId", uid);
        }
      }

      const displayName = localStorage.getItem("displayName") || "Guest";
      const code = (roomId || "").toUpperCase();

      socketRef.current.emit("join-call", roomId, {
        name: displayName,
        userId: uid,
      });

      if (isHostRef.current) {
        setTimeout(() => {
          if (socketRef.current?.connected) {
            socketRef.current.emit("declare-host", code);
          }
        }, 200);
      }
    } catch (err) {
      console.error(err);
      alert("Unable to access camera/mic or connect.");
    } finally {
      setConnecting(false);
    }
  }

  async function leaveCall() {
    try {
      if (socketRef.current?.connected) {
        socketRef.current.emit("leave-call", roomId);
        await new Promise((r) => setTimeout(r, 80));
      }
    } catch { }
    await cleanupAll();
    navigate("/home");
  }

  async function endMeeting() {
    try {
      if (isHostRef.current) {
        const code = (roomId || "").toUpperCase();
        const hostDataRaw = localStorage.getItem(`host:${code}`);
        const hostData = hostDataRaw ? JSON.parse(hostDataRaw) : null;

        if (TRANSCRIPTS_ENABLED && hostData?.hostSecret) {
          try {
            await uploadRecordingsAndStoreTranscript({
              hostSecret: hostData.hostSecret,
              meetingCode: code,
            });
          } catch { }
        } else {
          try {
            stopAllRecorders();
          } catch { }
          try {
            recordersRef.current = {};
          } catch { }
        }

        await persistHistorySnapshot();

        if (socketRef.current?.connected) {
          socketRef.current.emit("end-meeting", roomId);
        }
      } else {
        await leaveCall();
        return;
      }
    } catch { }

    await cleanupAll();

    navigate("/home");
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const name =
      localStorage.getItem("displayName") ||
      prompt("Enter your display name", "Guest") ||
      "Guest";

    localStorage.setItem("displayName", name);

    start();

    const onBeforeUnload = () => {
      try {
        if (isHostRef.current) persistHistorySnapshot();
        socketRef.current?.emit("leave-call", roomId);
      } catch { }
    };

    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      cleanupAll();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [roomId]);

  return {
    start,
    leaveCall,
    endMeeting,
    cleanupAll,
    persistHistorySnapshot
  };
}