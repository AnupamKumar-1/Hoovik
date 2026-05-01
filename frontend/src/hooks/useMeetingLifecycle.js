import { useEffect, useRef, useCallback } from "react";
import io from "socket.io-client";
import {
  initMediaController,
  setExternalCleaners,
  resetMediaController,
} from "../utils/mediaController";
import { notifyLocalStreamReady } from "./useWebRTC";

const _activeRooms = new Set();

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
  const instanceKey = useRef(`${roomId}:${Date.now()}:${Math.random()}`);

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
    _activeRooms.delete(instanceKey.current);

    try {
      socketRef.current?.removeAllListeners?.();
      socketRef.current?.disconnect();
    } catch { }
    if (socketRef && "current" in socketRef) socketRef.current = null;

    try { window.myId = null; } catch { }

    try { localStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { }
    try { prevLocalStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { }
    try {
      const prev = window.__previousLocalStreamForToggle;
      if (prev?.getTracks) prev.getTracks().forEach((t) => t.stop());
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
      if (!ref || typeof ref !== "object" || !("current" in ref)) return;
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

    try { stopPeriodicEmotionCapture(); } catch { }

    resetMediaController();
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

  async function start(key) {
    if (_activeRooms.has(key)) return;
    _activeRooms.add(key);

    try {
      setConnecting(true);
      pcsRef.current = {};

      const resetRef = (ref) => {
        if (!ref || typeof ref !== "object" || !("current" in ref)) return;
        ref.current = {};
      };

      resetRef(makingOfferRef);
      resetRef(politeRef);
      resetRef(pendingCandidatesRef);
      resetRef(ignoreOfferRef);
      resetRef(isSettingRemoteAnswerPending);

      if (!_activeRooms.has(key)) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: 640,
          height: 360,
          frameRate: 15,
        }
      });

      if (!_activeRooms.has(key)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.autoplay = true;
        localVideoRef.current.playsInline = true;
        localVideoRef.current.muted = true;
        localVideoRef.current.srcObject = stream;
        try { await localVideoRef.current.play(); } catch { }
      }

      if (socketRef.current) {
        try {
          socketRef.current.removeAllListeners();
          socketRef.current.disconnect();
        } catch { }
        socketRef.current = null;
      }

      const socket = io(SOCKET_SERVER_URL, { autoConnect: false });
      socketRef.current = socket;

      await new Promise((resolve, reject) => {
        const TO = setTimeout(() => reject(new Error("socket timeout")), 8000);
        const cleanup = () => {
          clearTimeout(TO);
          socket.off("connect", onConnect);
          socket.off("connect_error", onError);
        };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("socket connect_error")); };
        socket.on("connect", onConnect);
        socket.on("connect_error", onError);
        socket.connect();
      });

      if (!_activeRooms.has(key)) {
        socket.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      initMediaController(stream, socketRef.current, pcsRef.current, localVideoRef.current);

      setExternalCleaners({
        recordersRef,
        removeAnalyzerFn: removeAnalyzer,
        prevLocalStreamRef,
      });

      createAnalyzerForStream("local", stream);
      startRecordingForStream("local", stream);

      notifyLocalStreamReady(stream);

      onSocketReady?.();

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

      socketRef.current.emit("join-call", roomId, { name: displayName, userId: uid });

      if (isHostRef.current) {
        setTimeout(() => {
          if (socketRef.current?.connected) {
            socketRef.current.emit("declare-host", code);
          }
        }, 200);
      }
    } catch (err) {
      console.error(err);
      _activeRooms.delete(key);
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

  function runBackgroundTranscript(code, hostSecret, recordersSnapshot) {
    const speakerMap = {};
    const currentMeta = participantsMetaRef?.current || [];

    currentMeta.forEach((p) => {
      const name =
        p?.meta?.name ||
        p?.meta?.displayName ||
        p?.name ||
        `Guest-${(p.id || "").slice(0, 6)}`;
      if (p.id) speakerMap[p.id] = name;
    });

    speakerMap["local"] = localStorage.getItem("displayName") || "Host";

    const fd = new FormData();
    fd.append("meeting_code", code);
    fd.append("speaker_map", JSON.stringify(speakerMap));

    let fileCount = 0;

    for (const [id, rec] of Object.entries(recordersSnapshot)) {
      const chunks = rec?.chunks;
      if (!chunks?.length) continue;

      const blob = new Blob(chunks, { type: "audio/webm" });
      fd.append("audio_files", blob, `${id}.webm`);
      fileCount++;
    }

    if (fileCount === 0) return;

    const token = localStorage.getItem("token");

    fetch(TRANSCRIPT_ENDPOINT, {
      method: "POST",
      headers: {
        "x-host-secret": hostSecret,
        ...(token ? { "x-user-token": token } : {}),
      },
      body: fd,
    })
      .then((resp) => {
        if (!resp?.ok) return;
        return resp.json();
      })
      .then((data) => {
        if (!data?.success) return;

        const text =
          data?.transcriptText ||
          data?.transcript ||
          data?.metadata?.transcriptText ||
          "";

        if (!text.trim()) return;

        try {
          const existingRaw = localStorage.getItem(`host:${code}`);
          const existing = existingRaw ? JSON.parse(existingRaw) : {};

          localStorage.setItem(
            `host:${code}`,
            JSON.stringify({
              ...existing,
              meetingCode: code,
              lastTranscriptAt: new Date().toISOString(),
            })
          );
        } catch { }
      })
      .catch(() => { });
  }

  async function endMeeting() {
    if (!isHostRef.current) {
      await leaveCall();
      return;
    }

    const code = (roomId || "").toUpperCase();
    const hostDataRaw = localStorage.getItem(`host:${code}`);
    const hostData = hostDataRaw ? JSON.parse(hostDataRaw) : null;

    try { await stopAllRecorders(); } catch { }

    const recordersSnapshot = {};
    for (const [id, rec] of Object.entries(recordersRef.current || {})) {
      recordersSnapshot[id] = {
        chunks: Array.isArray(rec?.chunks) ? [...rec.chunks] : [],
        gateState: rec?.gateState ? { ...rec.gateState } : null,
      };
    }

    try {
      if (socketRef.current?.connected) socketRef.current.emit("end-meeting", roomId);
    } catch { }

    persistHistorySnapshot().catch(() => { });

    await cleanupAll();
    navigate("/home", { state: { meetingEnded: true, meetingCode: code } });

    if (TRANSCRIPTS_ENABLED && hostData?.hostSecret && TRANSCRIPT_ENDPOINT) {
      setTimeout(() => {
        runBackgroundTranscript(code, hostData.hostSecret, recordersSnapshot);
      }, 0);
    }
  }

  useEffect(() => {
    const name =
      localStorage.getItem("displayName") ||
      prompt("Enter your display name", "Guest") ||
      "Guest";
    localStorage.setItem("displayName", name);

    const key = instanceKey.current;
    start(key);

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
    persistHistorySnapshot,
  };
}