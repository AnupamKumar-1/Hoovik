import { useEffect, useCallback } from "react";
import io from "socket.io-client";
import {
  initMediaController,
  setLocalStream,
  setPeerConnections,
  setVideoElement,
  setSocketRef,
  setExternalCleaners,
} from "../utils/mediaController";

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
  SOCKET_SERVER_URL,
}) {

  const persistHistorySnapshot = useCallback(async () => {
    if (!isHost || typeof addToUserHistory !== "function") return;

    try {
      const participantList = (participantsMeta || []).map(p =>
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
        link: `${window.location.origin}/room/${(roomId || "").toUpperCase()}`
      });

      console.log("[history] persisted meeting snapshot");
    } catch (err) {
      console.warn("[history] persist failed", err);
    }
  }, [participantsMeta, roomId, addToUserHistory, isHost]);

  const cleanupAll = useCallback(async () => {
    try {
      socketRef.current?.removeAllListeners?.();
      socketRef.current?.disconnect();
    } catch {}

    try { window.myId = null; } catch {}

    try {
      localStreamRef.current?.getTracks()?.forEach(t => t.stop());
    } catch {}

    try {
      prevLocalStreamRef.current?.getTracks()?.forEach(t => t.stop());
    } catch {}

    try {
      const prev = window.__previousLocalStreamForToggle;
      if (prev && prev.getTracks) {
        prev.getTracks().forEach(t => t.stop());
      }
      window.__previousLocalStreamForToggle = null;
    } catch {}

    if (localVideoRef.current) localVideoRef.current.srcObject = null;

    localStreamRef.current = null;
    prevLocalStreamRef.current = null;

    try {
      Object.keys(pcsRef.current).forEach(pid => {
        try { pcsRef.current[pid].close(); } catch {}
      });
    } catch {}

    pcsRef.current = {};
    setRemoteStreams({});
    setParticipantsMeta([]);

    stopPeriodicEmotionCapture();

    try {
      const tmpStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      tmpStream.getTracks().forEach(track => track.stop());
    } catch (e) {
      console.warn("Force release failed:", e);
    }
  }, [stopPeriodicEmotionCapture]);

  async function start() {
    try {
      setConnecting(true);

      const constraints = {
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      createAnalyzerForStream("local", stream);
      startRecordingForStream("local", stream);

      const socket = io(SOCKET_SERVER_URL, { autoConnect: false });
      socketRef.current = socket;

      await new Promise((resolve, reject) => {
        const CLEANUP = () => {
          socket.off("connect", onConnect);
          socket.off("connect_error", onError);
        };

        const onConnect = () => {
          CLEANUP();
          resolve();
        };

        const onError = (err) => {
          CLEANUP();
          reject(err || new Error("socket connect error"));
        };

        socket.on("connect", onConnect);
        socket.on("connect_error", onError);

        const TO = setTimeout(() => {
          CLEANUP();
          reject(new Error("socket connect timeout"));
        }, 5000);

        const origResolve = resolve;
        resolve = (...args) => { clearTimeout(TO); origResolve(...args); };
        const origReject = reject;
        reject = (...args) => { clearTimeout(TO); origReject(...args); };

        socket.connect();
      });

      initMediaController(
        localStreamRef.current,
        socketRef.current,
        pcsRef.current,
        localVideoRef.current
      );

      try {
        if (typeof setExternalCleaners === "function") {
          setExternalCleaners({
            recordersRef,
            removeAnalyzerFn: removeAnalyzer,
            prevLocalStreamRef,
          });
        }
      } catch (e) {
        console.warn("registering external cleaners failed:", e);
      }

      setLocalStream(localStreamRef.current);
      setPeerConnections(pcsRef.current);
      setVideoElement(localVideoRef.current);
      setSocketRef(socketRef.current);

      let uid = localStorage.getItem("userId");
      if (!uid) {
        uid = crypto.randomUUID();
        localStorage.setItem("userId", uid);
      }

      socketRef.current.emit("join-call", roomId, {
        name: localStorage.getItem("displayName") || "Guest",
        userId: uid,
      });

    } catch (err) {
      console.error("start error:", err);
      alert("Unable to access camera/mic or connect to signaling server.");
    } finally {
      setConnecting(false);
    }
  }

  async function leaveCall() {
    try {
      if (socketRef.current?.connected) {
        socketRef.current.emit("leave-call", roomId);
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (e) {
      console.warn("leaveCall emit failed", e);
    }

    await cleanupAll();
    navigate("/home");
  }

  async function endMeeting() {
    try {
      if (isHost) {

        if (TRANSCRIPTS_ENABLED) {
          const code = roomId.toUpperCase();
          const hostDataRaw = localStorage.getItem(`host:${code}`);
          const hostData = hostDataRaw ? JSON.parse(hostDataRaw) : null;

          console.log("🔥 HOST DATA (END MEETING):", hostData);

          if (!hostData?.hostSecret) {
            console.error("HOST SECRET MISSING — cannot upload transcript");
          } else {
            try {
              await uploadRecordingsAndStoreTranscript({
                hostSecret: hostData.hostSecret,
                meetingCode: code,
              });
            } catch (e) {
              console.warn("uploadRecordingsAndStoreTranscript failed", e);
            }
          }
        } else {
          try { stopAllRecorders(); } catch { }
          try { recordersRef.current = {}; } catch { }
        }

        if (socketRef.current?.connected) {
          socketRef.current.emit("end-meeting", roomId);
          await new Promise((r) => setTimeout(r, 50));
        }

      } else {
        await leaveCall();
      }

    } catch (err) {
      console.error("endMeeting error:", err);
    } finally {
      await cleanupAll();
      navigate("/home");
    }
  }

  useEffect(() => {
    const name =
      localStorage.getItem("displayName") ||
      prompt("Enter display name", "Guest") ||
      "Guest";

    localStorage.setItem("displayName", name);

    start();

    const onBeforeUnload = () => {
      try {
        if (isHost) {
          persistHistorySnapshot();
        }
        socketRef.current?.emit("leave-call", roomId);
      } catch {}
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