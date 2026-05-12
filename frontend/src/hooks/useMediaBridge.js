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
  notifyMediaState,
  updateParticipantMediaState,
}) {
  useEffect(() => {

    const setupVolumeAnalyzer = (stream) => {
      try {
        if (stream) {
          localStreamRef.current = stream;
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
        
        stopPeriodicEmotionCapture({ notifyMediaState });
      } catch { }
    };


    const bridgeNotifyMediaState = (participantId, state = {}) => {
      try {
        notifyMediaState?.(participantId, state);
      } catch { }
    };

    const bridgeUpdateParticipantMediaState = (participantId, state = {}) => {
      try {
        updateParticipantMediaState?.(participantId, state);
      } catch { }
    };

    window.__MEDIA_BRIDGE__ = {
      setupVolumeAnalyzer,
      stopVolumeAnalyzer,
      startTranscription,
      stopTranscription,
      startRecording,
      stopRecording,
      startEmotion,
      stopEmotion,
      notifyMediaState: bridgeNotifyMediaState,
      updateParticipantMediaState: bridgeUpdateParticipantMediaState,
    };

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
    notifyMediaState,
    updateParticipantMediaState,
  ]);
}