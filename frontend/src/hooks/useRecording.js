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

  function _stopRecorderForId(id) {
    const existing = recordersRef.current[id];
    if (!existing) return;
    try {
      if (existing.recorder?.state !== "inactive") {
        existing.recorder.stop();
      }
    } catch { }
    delete recordersRef.current[id];
  }

  function startRecordingForStream(id, stream, { force = false } = {}) {
    if (!isHost || !stream) return;

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks?.length) return;

    const existing = recordersRef.current[id];

    if (existing && !force) {
      const recorderTrack = existing.audioStream?.getAudioTracks?.()?.[0];
      const newTrack = audioTracks[0];
      if (recorderTrack && recorderTrack.id === newTrack.id) {
        if (existing.recorder?.state === "recording") return;
      }
    }

    if (existing) {
      _stopRecorderForId(id);
    }

    try {
      const track = audioTracks[0];
      const audioStream = new MediaStream([track]);

      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      }

      const recorder = new MediaRecorder(
        audioStream,
        mimeType ? { mimeType } : undefined
      );

      const chunks = existing?.chunks ?? [];

      recorder.ondataavailable = (ev) => {
        if (ev.data?.size > 0) chunks.push(ev.data);
      };

      recorder.start(1000);
      recordersRef.current[id] = { recorder, chunks, audioStream };
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