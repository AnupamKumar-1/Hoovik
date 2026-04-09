import { useRef } from "react";

export default function useRecording({
  isHost,
  roomId,
  participantsMetaRef,
  TRANSCRIPTS_ENABLED,
  TRANSCRIPT_ENDPOINT,
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

  function getHostSecretForRoom(code) {
    if (!code) return null;
    try {
      const raw = localStorage.getItem(`host:${code.toUpperCase()}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.hostSecret || null;
    } catch {
      return null;
    }
  }

  async function uploadRecordingsAndStoreTranscript() {
    if (!isHost) return null;

    if (!TRANSCRIPTS_ENABLED) {
      stopAllRecorders();
      recordersRef.current = {};
      return null;
    }

    if (!TRANSCRIPT_ENDPOINT) {
      stopAllRecorders();
      recordersRef.current = {};
      return null;
    }

    try {
      stopAllRecorders();
      await new Promise((r) => setTimeout(r, 1200));

      const code = (roomId || "").toUpperCase();
      if (!code) return null;

      const hostSecret = getHostSecretForRoom(code);
      if (!hostSecret) return null;

      const fd = new FormData();
      fd.append("meeting_code", code);

      const speakerMap = {};

      const currentMeta = participantsMetaRef?.current || [];
      currentMeta.forEach((p) => {
        const name =
          p?.meta?.name ||
          p?.meta?.displayName ||
          p?.name ||
          `Guest-${(p.id || "").slice(0, 6)}`;
        if (p.id) speakerMap[p.id] = name;
      });

      speakerMap["local"] = localStorage.getItem("displayName") || "Host";

      fd.append("speaker_map", JSON.stringify(speakerMap));

      let fileCount = 0;
      for (const [id, rec] of Object.entries(recordersRef.current)) {
        const chunks = rec?.chunks;
        if (!chunks?.length) continue;
        const blob = new Blob(chunks, { type: "audio/webm" });
        fd.append("audio_files", blob, `${id}.webm`);
        fileCount++;
      }

      if (fileCount === 0) return null;

      let resp;
      try {
        resp = await fetch(TRANSCRIPT_ENDPOINT, {
          method: "POST",
          headers: { "x-host-secret": hostSecret },
          body: fd,
        });
      } catch {
        return null;
      }

      if (!resp || !resp.ok) return null;

      const data = await resp.json();
      if (!data?.success) return null;

      try {
        localStorage.setItem(
          `transcript:${code}`,
          JSON.stringify({
            meeting_code: code,
            transcript: data.transcript_text || "",
            createdAt: new Date().toISOString(),
          })
        );
      } catch { }

      return data;
    } catch {
      return null;
    } finally {
      recordersRef.current = {};
    }
  }

  return {
    recordersRef,
    startRecordingForStream,
    stopAllRecorders,
    uploadRecordingsAndStoreTranscript,
  };
}