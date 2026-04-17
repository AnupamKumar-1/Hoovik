import { useRef } from "react";

export default function useRecording({
  isHost,
  roomId,
  participantsMetaRef,
  TRANSCRIPTS_ENABLED,
  TRANSCRIPT_ENDPOINT,
  API_BASE,
}) {
  const recordersRef = useRef({});

  function startRecordingForStream(id, stream) {
    if (!isHost || !stream) return;
    if (recordersRef.current[id]) return;

    try {
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks?.length) return;

      const audioStream = new MediaStream([audioTracks[0]]);

      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      }

      const recorder = new MediaRecorder(
        audioStream,
        mimeType ? { mimeType } : undefined
      );

      const chunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data?.size > 0) chunks.push(ev.data);
      };

      recorder.start(1000);
      recordersRef.current[id] = { recorder, chunks };
    } catch { }
  }

  function stopAllRecorders() {
    Object.values(recordersRef.current).forEach((rec) => {
      try {
        if (rec?.recorder?.state !== "inactive") {
          rec.recorder.stop();
        }
      } catch { }
    });
  }

  function uploadRecordingsAndStoreTranscript() {
    return Promise.resolve(null);
  }

  return {
    recordersRef,
    startRecordingForStream,
    stopAllRecorders,
    uploadRecordingsAndStoreTranscript,
  };
}