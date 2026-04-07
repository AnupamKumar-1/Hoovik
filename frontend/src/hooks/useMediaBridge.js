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
  pcsRef,
  safeNegotiateOffer,  
}) {
  useEffect(() => {

    const renegotiateAllPeers = () => {
      const pcs = pcsRef.current || {};
      Object.keys(pcs).forEach((peerId) => {
        try {
          safeNegotiateOffer(peerId);
        } catch { }
      });
    };

    const setupVolumeAnalyzer = (stream) => {
      try {
        if (stream) {
          localStreamRef.current = stream;
        }

        createAnalyzerForStream("local", stream || localStreamRef.current);

        // ✅ IMPORTANT
        renegotiateAllPeers();

      } catch (e) { }
    };

    const stopVolumeAnalyzer = () => {
      try {
        removeAnalyzer("local");
      } catch { }
    };

    const startTranscription = (stream) => {
      try {
        startRecordingForStream("local", stream || localStreamRef.current);
      } catch { }
    };

    const stopTranscription = () => {
      try {
        const rec = recordersRef.current?.["local"];
        if (rec?.recorder && rec.recorder.state !== "inactive") {
          rec.recorder.stop();
        }
        if (recordersRef.current) delete recordersRef.current["local"];
      } catch { }
    };

    const startRecording = (stream) => {
      try {
        startRecordingForStream("local", stream || localStreamRef.current);
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
    pcsRef,
    safeNegotiateOffer,
  ]);
}