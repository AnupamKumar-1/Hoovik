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
  flushPendingPeers,
}) {
  useEffect(() => {
    const setupVolumeAnalyzer = (stream) => {
      try {
        if (stream) {
          localStreamRef.current = stream;
          if (typeof flushPendingPeers === "function") {
            flushPendingPeers();
          }
        }

        const s = stream || localStreamRef.current;
        if (!s) return;

        createAnalyzerForStream("local", s);
      } catch { }
    };

    const stopVolumeAnalyzer = () => {
      try {
        removeAnalyzer("local");
      } catch { }
    };

    const startTranscription = (stream) => {
      try {
        const s = stream || localStreamRef.current;
        if (!s) return;

        if (recordersRef.current?.["local"]) return;

        startRecordingForStream("local", s);
      } catch { }
    };

    const stopTranscription = () => {
      try {
        const rec = recordersRef.current?.["local"];
        if (rec?.recorder?.state !== "inactive") {
          rec.recorder.stop();
        }
        if (recordersRef.current) {
          delete recordersRef.current["local"];
        }
      } catch { }
    };

    const startRecording = (stream) => {
      try {
        const s = stream || localStreamRef.current;
        if (!s) return;

        if (recordersRef.current?.["local"]) return;

        startRecordingForStream("local", s);
      } catch { }
    };

    const stopRecording = () => {
      try {
        stopAllRecorders();
      } catch { }
    };

    const startEmotion = (opts = {}) => {
      try {
        startPeriodicEmotionCapture(opts);
      } catch { }
    };

    const stopEmotion = () => {
      try {
        stopPeriodicEmotionCapture();
      } catch { }
    };

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

    window.__MEDIA_BRIDGE__ = bridge;

    return () => {
      try {
        delete window.__MEDIA_BRIDGE__;
      } catch { }
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
    flushPendingPeers,
  ]);
}