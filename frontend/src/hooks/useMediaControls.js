import { useRef } from "react";
import {
  toggleAudio as mediaToggleAudio,
  toggleVideo as mediaToggleVideo,
  setLocalStream,
  setVideoElement,
} from "../utils/mediaController";

export default function useMediaControls({
  localStreamRef,
  localVideoRef,
  pcsRef,
  socketRef,
  createAnalyzerForStream,
  removeAnalyzer,
  startRecordingForStream,
  stopPeriodicEmotionCapture,
  startPeriodicEmotionCapture,
}) {
  const videoOffRef = useRef(false);

  // ✅ CENTRALIZED ANALYZER RESET (IMPORTANT)
  function resetLocalAnalyzer() {
    try {
      removeAnalyzer("local");
      if (localStreamRef.current) {
        createAnalyzerForStream("local", localStreamRef.current);
      }
    } catch {}
  }

  // ================= MUTE =================
  async function toggleMute(
    muted,
    setMuted,
    mutedRef,
    TRANSCRIPTS_ENABLED,
    recordersRef
  ) {
    try {
      const newMuted = await mediaToggleAudio(muted);

      setMuted(newMuted);
      if (mutedRef) mutedRef.current = newMuted;

      if (newMuted) {
        // 🔴 MUTED
        if (TRANSCRIPTS_ENABLED) {
          try { window.stopTranscription?.(); } catch {}
        }

        try {
          const rec = recordersRef.current?.["local"];
          if (rec?.recorder && rec.recorder.state !== "inactive") {
            rec.recorder.stop();
          }
          delete recordersRef.current?.["local"];
        } catch {}
      } else {
        // 🟢 UNMUTED
        if (TRANSCRIPTS_ENABLED) {
          try {
            window.startTranscription?.(localStreamRef.current);
          } catch {}
        }

        try {
          window.startRecording?.("audio", localStreamRef.current);
        } catch {}
      }
    } catch (err) {
      console.error("toggleMute error:", err);
      if (mutedRef) mutedRef.current = muted;
    }
  }

  // ================= VIDEO =================
  async function toggleVideo(videoOff, setVideoOff) {
    try {
      const newVideoOff = await mediaToggleVideo(videoOff);

      setVideoOff(newVideoOff);
      videoOffRef.current = newVideoOff;

      if (newVideoOff) {
        // 🔴 VIDEO OFF (CLEAN)
        try { stopPeriodicEmotionCapture(); } catch {}
        try { removeAnalyzer("local"); } catch {}
        try { window.stopRecording?.("video"); } catch {}
      } else {
        // 🟢 VIDEO ON
        resetLocalAnalyzer();

        try {
          startRecordingForStream("local", localStreamRef.current);
        } catch {}

        try { startPeriodicEmotionCapture(); } catch {}
      }
    } catch (err) {
      console.error("toggleVideo error:", err);
      videoOffRef.current = videoOff;
    }
  }

  // ================= SCREEN SHARE =================
  async function startScreenShare(prevLocalStreamRef) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // ✅ IMPORTANT
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      // ✅ PRESERVE MIC
      const audioTracks =
        localStreamRef.current?.getAudioTracks?.() || [];

      const mergedStream = new MediaStream([
        screenTrack,
        ...audioTracks,
      ]);

      prevLocalStreamRef.current = localStreamRef.current;
      localStreamRef.current = mergedStream;
      setLocalStream(mergedStream);

      // ✅ LOCAL PREVIEW
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = mergedStream;
        setVideoElement(localVideoRef.current);
      }

      // ✅ REPLACE TRACK IN PEERS
      Object.values(pcsRef.current).forEach((pc) => {
        const sender = pc
          .getSenders()
          .find((s) => s.track?.kind === "video");

        if (sender) {
          try { sender.replaceTrack(screenTrack); } catch {}
        }
      });

      // ✅ FORCE NEGOTIATION (IMPORTANT)
      Object.values(pcsRef.current).forEach((pc) => {
        try {
          pc.dispatchEvent(new Event("negotiationneeded"));
        } catch {}
      });

      socketRef.current?.emit("update-participant-state", {
        screen: true,
      });

      // ================= END SCREEN SHARE =================
      screenTrack.onended = async () => {
        try {
          let camStream = prevLocalStreamRef.current;

          if (!camStream) {
            try {
              camStream =
                await navigator.mediaDevices.getUserMedia({
                  video: true,
                  audio: true,
                });
            } catch {}
          }

          if (camStream) {
            localStreamRef.current = camStream;
            setLocalStream(camStream);

            const camTrack = camStream.getVideoTracks()[0];

            if (camTrack) {
              Object.values(pcsRef.current).forEach((pc) => {
                const sender = pc
                  .getSenders()
                  .find((s) => s.track?.kind === "video");

                if (sender) {
                  try { sender.replaceTrack(camTrack); } catch {}
                }
              });
            }

            // ✅ RESET ANALYZER + RECORDING
            resetLocalAnalyzer();
            startRecordingForStream("local", camStream);

            // ✅ LOCAL PREVIEW
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = camStream;
              setVideoElement(localVideoRef.current);
            }
          } else {
            // fallback
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = null;
            }
            localStreamRef.current = null;
            setLocalStream(null);
          }

          socketRef.current?.emit("update-participant-state", {
            screen: false,
          });
        } finally {
          prevLocalStreamRef.current = null;

          try {
            screenStream.getTracks().forEach((t) => {
              if (t.readyState !== "ended") t.stop();
            });
          } catch {}
        }
      };
    } catch (err) {
      if (err.name === "NotAllowedError") {
        console.log("User cancelled screen share");
      } else {
        console.error("Screen share error:", err);
      }
    }
  }

  return {
    toggleMute,
    toggleVideo,
    startScreenShare,
  };
}