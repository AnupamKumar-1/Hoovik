import { useRef } from "react";

export default function useRecording({
  isHost,
  roomId,
  participantsMeta,
  TRANSCRIPTS_ENABLED,
  TRANSCRIPT_ENDPOINT,
}) {
  const recordersRef = useRef({});

  function startRecordingForStream(id, stream) {
    if (!isHost || !stream) return;
    if (recordersRef.current[id]) return;

    try {
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks?.length) {
        console.warn(`[recorder] no audio tracks for ${id}`);
        return;
      }

      const audioStream = new MediaStream([audioTracks[0]]);

      let mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
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

    } catch (err) {
      console.warn(`[recorder] failed for ${id}:`, err);
    }
  }

  function stopAllRecorders() {
    Object.values(recordersRef.current).forEach((rec) => {
      try {
        if (rec?.recorder?.state !== "inactive") {
          rec.recorder.stop();
        }
      } catch {}
    });
  }

  function getHostSecretForRoom(code) {
    if (!code) return null;

    try {
      const raw = localStorage.getItem(`host:${code.toUpperCase()}`);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      return parsed?.hostSecret || null;
    } catch (e) {
      console.warn("❌ Failed to read host secret", e);
      return null;
    }
  }

  async function uploadRecordingsAndStoreTranscript() {
    if (!isHost) return null;

    if (!TRANSCRIPTS_ENABLED) {
      console.warn("[transcript] disabled");
      stopAllRecorders();
      recordersRef.current = {};
      return null;
    }

    if (!TRANSCRIPT_ENDPOINT) {
      console.warn("[transcript] missing endpoint");
      stopAllRecorders();
      recordersRef.current = {};
      return null;
    }

    try {
      stopAllRecorders();
      await new Promise((r) => setTimeout(r, 1200));

      const code = (roomId || "").toUpperCase();

      if (!code) {
        console.error("❌ INVALID ROOM ID");
        return null;
      }

      console.log("🔥 ROOM ID:", code);
      console.log("🔥 HOST DATA:", localStorage.getItem(`host:${code}`));

      const hostSecret = getHostSecretForRoom(code);

      if (!hostSecret) {
        console.error("❌ NO HOST SECRET FOUND → aborting");
        return null;
      }

      console.log("🔥 USING HOST SECRET:", hostSecret);

      const fd = new FormData();
      fd.append("meeting_code", code);

      const speakerMap = {};

      participantsMeta?.forEach((p) => {
        const name =
          p?.meta?.name ||
          p?.meta?.displayName ||
          `Guest-${(p.id || "").slice(0, 6)}`;

        speakerMap[p.id] = name;
      });

      speakerMap["local"] =
        localStorage.getItem("displayName") || "Host";

      fd.append("speaker_map", JSON.stringify(speakerMap));

      let fileCount = 0;

      for (const [id, rec] of Object.entries(recordersRef.current)) {
        const chunks = rec?.chunks;

        if (!chunks?.length) continue;

        const blob = new Blob(chunks, { type: "audio/webm" });
        fd.append("audio_files", blob, `${id}.webm`);
        fileCount++;
      }

      if (fileCount === 0) {
        console.warn("[transcript] no audio recorded");
        return null;
      }

      console.log("🔥 FILE COUNT:", fileCount);

      const resp = await fetch(TRANSCRIPT_ENDPOINT, {
        method: "POST",
        headers: {
          "x-host-secret": hostSecret,
        },
        body: fd,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("❌ upload failed:", errText);
        return null;
      }

      const data = await resp.json();

      if (!data?.success) {
        console.error("❌ transcript failed:", data);
        return null;
      }

      const payload = {
        meeting_code: code,
        transcript: data.transcript_text || "",
        createdAt: new Date().toISOString(),
      };

      try {
        localStorage.setItem(
          `transcript:${code}`,
          JSON.stringify(payload)
        );
      } catch {}

      console.log("✅ TRANSCRIPT SUCCESS");

      return data;

    } catch (err) {
      console.error("❌ upload error:", err);
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