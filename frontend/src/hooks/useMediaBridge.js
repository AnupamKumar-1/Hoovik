import { useEffect } from "react";


export default function useMediaBridge({
  localStreamRef,
  createAnalyzerForStream,
  removeAnalyzer,
  startRecordingForStream,
  stopAllRecorders,
  recordersRef,
  startPeriodicEmotionCapture,
  stopPeriodicEmotionCapture,
}) {
  useEffect(() => {
    
    const setupVolumeAnalyzer = (stream) => {
      try {
        if (stream) {
          localStreamRef.current = stream;
        }
        createAnalyzerForStream("local", stream || localStreamRef.current);
      } catch (e) {
        console.warn("setupVolumeAnalyzer failed", e);
      }
    };

    const stopVolumeAnalyzer = () => {
      try {
        removeAnalyzer("local");
      } catch (e) {
        console.warn("stopVolumeAnalyzer failed", e);
      }
    };

    // --- Transcription ---
    const startTranscription = (stream) => {
      try {
        startRecordingForStream("local", stream || localStreamRef.current);
      } catch (e) {
        console.warn("startTranscription failed", e);
      }
    };

    const stopTranscription = () => {
      try {
        const rec = recordersRef.current?.["local"];
        if (rec?.recorder && rec.recorder.state !== "inactive") {
          rec.recorder.stop();
        }
        if (recordersRef.current) delete recordersRef.current["local"];
      } catch (e) {
        console.warn("stopTranscription failed", e);
      }
    };

    // --- Recording ---
    const startRecording = (stream) => {
      try {
        startRecordingForStream("local", stream || localStreamRef.current);
      } catch (e) {
        console.warn("startRecording failed", e);
      }
    };

    const stopRecording = () => {
      try {
        stopAllRecorders();
      } catch (e) {
        console.warn("stopRecording failed", e);
      }
    };

    // --- Emotion Capture ---
    const startEmotion = (opts = {}) => {
      try {
        startPeriodicEmotionCapture(opts);
      } catch (e) {
        console.warn("startEmotion failed", e);
      }
    };

    const stopEmotion = () => {
      try {
        stopPeriodicEmotionCapture();
      } catch (e) {
        console.warn("stopEmotion failed", e);
      }
    };

    /**
     * OPTIONAL:
     * expose for debugging (safe namespace instead of polluting window)
     */
    const bridge = {
      setupVolumeAnalyzer,
      stopVolumeAnalyzer,
      startTranscription,
      stopTranscription,
      startRecording,
      stopRecording,
      startEmotion,
      stopEmotion,
    };

    // attach safely (NOT polluting global root)
    window.__MEDIA_BRIDGE__ = bridge;

    return () => {
      try {
        delete window.__MEDIA_BRIDGE__;
      } catch {}
    };
  }, [
    localStreamRef,
    createAnalyzerForStream,
    removeAnalyzer,
    startRecordingForStream,
    stopAllRecorders,
    recordersRef,
    startPeriodicEmotionCapture,
    stopPeriodicEmotionCapture,
  ]);
}