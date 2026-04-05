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