import { useRef, useEffect } from "react";
import {
  toggleAudio as mediaToggleAudio,
  toggleVideo as mediaToggleVideo,
  setLocalStream,
  setVideoElement,
  setOnLocalStreamChange,
  replaceTrackInPeers,
} from "../utils/mediaController";

export default function useMediaControls({
  localStreamRef,
  localVideoRef,
  pcsRef,
  myUserId,
  socketRef,
  createAnalyzerForStream,
  removeAnalyzer,
  startRecordingForStream,
  stopPeriodicEmotionCapture,
  startPeriodicEmotionCapture,
}) {
  const screenTrackRef = useRef(null);

  useEffect(() => {
    setOnLocalStreamChange((stream) => {
      localStreamRef.current = stream;
    });
    return () => {
      setOnLocalStreamChange(null);
    };
  }, [localStreamRef]);

  function syncAnalyzer(stream) {
    try {
      removeAnalyzer("local");
      if (stream) createAnalyzerForStream("local", stream);
    } catch { }
  }

  async function toggleMute(muted, setMuted, mutedRef, TRANSCRIPTS_ENABLED, recordersRef) {
    try {
      const newMuted = await mediaToggleAudio(muted);

      setMuted(newMuted);
      if (mutedRef) mutedRef.current = newMuted;

      if (newMuted) {
        removeAnalyzer("local");
      } else {
        const stream = localStreamRef.current;
        if (stream) {
          syncAnalyzer(stream);
          try {
            startRecordingForStream("local", stream, { force: true });
          } catch { }
        }
      }

      if (socketRef.current?.connected) {
        socketRef.current.emit("update-participant-state", { muted: newMuted });
      }
    } catch (err) {
      console.error("toggleMute error:", err);
    }
  }

  async function toggleVideo(videoOff, setVideoOff) {
    try {
      const newVideoOff = await mediaToggleVideo(videoOff);

      setVideoOff(newVideoOff);

      if (newVideoOff) {
        stopPeriodicEmotionCapture();
        removeAnalyzer("local");
      } else {
        const stream = localStreamRef.current;
        if (stream) {
          syncAnalyzer(stream);
          try {
            startRecordingForStream("local", stream, { force: true });
          } catch { }
        }
        startPeriodicEmotionCapture();
      }
    } catch (err) {
      console.error("toggleVideo error:", err);
    }
  }

  async function startScreenShare(prevLocalStreamRef) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      screenTrackRef.current = screenTrack;

      const audioTracks = localStreamRef.current?.getAudioTracks?.() || [];
      const mergedStream = new MediaStream([screenTrack, ...audioTracks]);

      prevLocalStreamRef.current = localStreamRef.current;
      localStreamRef.current = mergedStream;

      setLocalStream(mergedStream);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = mergedStream;
        setVideoElement(localVideoRef.current);
      }

      await replaceTrackInPeers(screenTrack, "video", {
        pcsRef: pcsRef.current,
        localStream: mergedStream,
      });

      socketRef.current?.emit("update-participant-state", { screen: true });
      syncAnalyzer(mergedStream);

      screenTrack.onended = async () => {
        await stopScreenShare(prevLocalStreamRef);
      };
    } catch (err) {
      console.error("Screen share error:", err);
    }
  }

  async function stopScreenShare(prevLocalStreamRef) {
    try {
      let camStream = prevLocalStreamRef.current;

      if (!camStream) {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }

      localStreamRef.current = camStream;
      setLocalStream(camStream);

      const camTrack = camStream.getVideoTracks()[0];
      if (camTrack) {
        await replaceTrackInPeers(camTrack, "video", {
          pcsRef: pcsRef.current,
          localStream: camStream,
        });
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = camStream;
        setVideoElement(localVideoRef.current);
      }

      syncAnalyzer(camStream);
      startRecordingForStream("local", camStream, { force: true });
      socketRef.current?.emit("update-participant-state", { screen: false });
    } catch (err) {
      console.error("stop screen share error:", err);
    } finally {
      try { screenTrackRef.current?.stop(); } catch { }
      screenTrackRef.current = null;
      prevLocalStreamRef.current = null;
    }
  }

  return {
    toggleMute,
    toggleVideo,
    startScreenShare,
  };
}