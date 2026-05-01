import { useRef, useCallback, useEffect } from "react";

function safeClose(pc) {
  try {
    if (pc && pc.connectionState !== "closed") pc.close();
  } catch { }
}

const DISCONNECTED_TIMEOUT_MS = 12000;

export function notifyLocalStreamReady(stream) {
  window.dispatchEvent(
    new CustomEvent("localstream:ready", { detail: { stream } })
  );
}

export default function useWebRTC({
  socketRef,
  localStreamRef,
  pcsRef,
  setRemoteStreams,
  createAnalyzerForStream,
  removeAnalyzer,
  startRecordingForStream,
  ICE_CONFIG,
  isHost,
}) {
  const makingOfferRef = useRef({});
  const ignoreOfferRef = useRef({});
  const politeRef = useRef({});
  const pendingCandidatesRef = useRef({});
  const isSettingRemoteAnswerPending = useRef({});
  const disconnectTimeoutRef = useRef({});
  const analyzerAttachedRef = useRef({});
  const recordingAttachedRef = useRef({});
  const pendingSignalsRef = useRef({});
  const pendingPeerQueueRef = useRef([]);
  const handleSignalRef = useRef(null);
  const peerStreamRef = useRef({});

  const teardown = useCallback(
    (peerId) => {
      if (disconnectTimeoutRef.current[peerId]) {
        clearTimeout(disconnectTimeoutRef.current[peerId]);
        delete disconnectTimeoutRef.current[peerId];
      }

      const pc = pcsRef.current[peerId];
      if (pc) {
        safeClose(pc);
        delete pcsRef.current[peerId];
      }

      delete makingOfferRef.current[peerId];
      delete ignoreOfferRef.current[peerId];
      delete pendingCandidatesRef.current[peerId];
      delete isSettingRemoteAnswerPending.current[peerId];
      delete analyzerAttachedRef.current[peerId];
      delete recordingAttachedRef.current[peerId];
      delete pendingSignalsRef.current[peerId];
      delete peerStreamRef.current[peerId];

      removeAnalyzer(peerId);

      setRemoteStreams((prev) => {
        if (!prev[peerId]) return prev;
        const copy = { ...prev };
        delete copy[peerId];
        return copy;
      });
    },
    [pcsRef, setRemoteStreams, removeAnalyzer]
  );

  const attachAnalyzerWhenReady = useCallback(
    (peerId, stream, pcId) => {
      if (analyzerAttachedRef.current[peerId]) return;

      const tryAttach = () => {
        const pcNow = pcsRef.current[peerId];
        if (!pcNow || pcNow.__id !== pcId) return;
        if (analyzerAttachedRef.current[peerId]) return;
        analyzerAttachedRef.current[peerId] = true;
        createAnalyzerForStream(peerId, stream);

        if (isHost && !recordingAttachedRef.current[peerId] && typeof startRecordingForStream === "function") {
          recordingAttachedRef.current[peerId] = true;
          startRecordingForStream(peerId, stream);
        }
      };

      if (stream.getAudioTracks().length > 0) {
        tryAttach();
        return;
      }

      const onAddTrack = (ev) => {
        if (ev.track?.kind !== "audio") return;
        stream.removeEventListener("addtrack", onAddTrack);
        tryAttach();
      };

      stream.addEventListener("addtrack", onAddTrack);
      stream.addEventListener(
        "inactive",
        () => stream.removeEventListener("addtrack", onAddTrack),
        { once: true }
      );
    },
    [pcsRef, createAnalyzerForStream, startRecordingForStream, isHost]
  );

  const pushStreamUpdate = useCallback(
    (peerId, stream) => {
      peerStreamRef.current[peerId] = stream;

      setRemoteStreams((prev) => {
        const existing = prev[peerId];
        if (existing && existing.id === stream.id) return prev;
        return { ...prev, [peerId]: stream };
      });
    },
    [setRemoteStreams]
  );

  const createPeerConnection = useCallback(
    (peerId) => {
      if (pcsRef.current[peerId]) return pcsRef.current[peerId];

      const pc = new RTCPeerConnection({
        ...ICE_CONFIG,
        iceTransportPolicy: "all",
      });
      const pcId = Symbol();
      pc.__id = pcId;

      const myId = socketRef.current?.id;
      politeRef.current[peerId] = myId > peerId;

      makingOfferRef.current[peerId] = false;
      ignoreOfferRef.current[peerId] = false;
      pendingCandidatesRef.current[peerId] = [];
      isSettingRemoteAnswerPending.current[peerId] = false;

      const ls = localStreamRef.current;
      if (ls) {
        ls.getTracks().forEach((track) => {
          pc.addTrack(track, ls);
        });
      }

      pcsRef.current[peerId] = pc;

      pc.ontrack = (ev) => {
        const currentPc = pcsRef.current[peerId];
        if (!currentPc || currentPc.__id !== pcId) return;

        let stream = ev.streams?.[0];
        if (!stream) stream = new MediaStream([ev.track]);

        pushStreamUpdate(peerId, stream);

        if (ev.track.kind === "audio") {
          attachAnalyzerWhenReady(peerId, stream, pcId);
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        socketRef.current?.emit(
          "signal",
          peerId,
          JSON.stringify({ candidate: ev.candidate })
        );
      };

      pc.onnegotiationneeded = async () => {
        if (
          makingOfferRef.current[peerId] ||
          pc.signalingState !== "stable" ||
          !localStreamRef.current
        )
          return;

        try {
          makingOfferRef.current[peerId] = true;
          await pc.setLocalDescription(await pc.createOffer());
          socketRef.current?.emit(
            "signal",
            peerId,
            JSON.stringify({ description: pc.localDescription })
          );
        } catch { } finally {
          makingOfferRef.current[peerId] = false;
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;

        if (state === "connected") {
          if (disconnectTimeoutRef.current[peerId]) {
            clearTimeout(disconnectTimeoutRef.current[peerId]);
            delete disconnectTimeoutRef.current[peerId];
          }
          const s = peerStreamRef.current[peerId];
          if (s) pushStreamUpdate(peerId, s);
        }

        if (state === "disconnected") {
          disconnectTimeoutRef.current[peerId] = setTimeout(() => {
            const current = pcsRef.current[peerId];
            if (!current || current.__id !== pcId) return;
            if (["disconnected", "failed"].includes(current.connectionState)) {
              teardown(peerId);
            }
          }, DISCONNECTED_TIMEOUT_MS);
        }

        if (state === "failed") {
          const current = pcsRef.current[peerId];
          if (current && current.__id === pcId) teardown(peerId);
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          try { pc.restartIce(); } catch { }
        }
      };

      const queued = pendingSignalsRef.current[peerId];
      if (queued?.length) {
        delete pendingSignalsRef.current[peerId];
        queued.forEach((msg) => handleSignalRef.current?.(peerId, msg));
      }

      return pc;
    },
    [
      ICE_CONFIG,
      pcsRef,
      localStreamRef,
      socketRef,
      attachAnalyzerWhenReady,
      teardown,
      pushStreamUpdate,
    ]
  );

  const flushPendingPeers = useCallback(() => {
    const queue = [...pendingPeerQueueRef.current];
    pendingPeerQueueRef.current = [];
    queue.forEach((peerId) => createPeerConnection(peerId));
  }, [createPeerConnection]);

  useEffect(() => {
    if (localStreamRef.current) flushPendingPeers();

    const onLocalStreamReady = (ev) => {
      if (ev.detail?.stream) localStreamRef.current = ev.detail.stream;
      flushPendingPeers();
    };

    window.addEventListener("localstream:ready", onLocalStreamReady);
    return () => window.removeEventListener("localstream:ready", onLocalStreamReady);
  }, [flushPendingPeers, localStreamRef]);

  const handleSignal = useCallback(
    async (fromId, messageStr) => {
      if (!socketRef.current) return;
      if (fromId === socketRef.current.id) return;

      let msg;
      try {
        msg = JSON.parse(messageStr);
      } catch {
        return;
      }

      if (!pcsRef.current[fromId]) {
        createPeerConnection(fromId);
      }

      const pc = pcsRef.current[fromId];
      if (!pc) {
        pendingSignalsRef.current[fromId] ||= [];
        pendingSignalsRef.current[fromId].push(messageStr);
        return;
      }

      const polite = politeRef.current[fromId];

      try {
        if (msg.description) {
          const { description } = msg;
          const isOffer = description.type === "offer";

          const offerCollision =
            isOffer &&
            (makingOfferRef.current[fromId] || pc.signalingState !== "stable");

          ignoreOfferRef.current[fromId] = !polite && offerCollision;
          if (ignoreOfferRef.current[fromId]) return;

          if (offerCollision) {
            try { await pc.setLocalDescription({ type: "rollback" }); } catch { }
          }

          await pc.setRemoteDescription(description);

          const pending = pendingCandidatesRef.current[fromId] || [];
          pendingCandidatesRef.current[fromId] = [];

          for (const candidate of pending) {
            try { await pc.addIceCandidate(candidate); } catch { }
          }

          if (isOffer) {
            await pc.setLocalDescription(await pc.createAnswer());
            socketRef.current?.emit(
              "signal",
              fromId,
              JSON.stringify({ description: pc.localDescription })
            );
          }
        } else if (msg.candidate) {
          pendingCandidatesRef.current[fromId] ||= [];
          if (pc.remoteDescription) {
            try { await pc.addIceCandidate(msg.candidate); } catch { }
          } else {
            pendingCandidatesRef.current[fromId].push(msg.candidate);
          }
        }
      } catch { }
    },
    [socketRef, pcsRef, createPeerConnection]
  );

  handleSignalRef.current = handleSignal;

  return {
    createPeerConnection,
    handleSignal,
    teardown,
    politeRef,
    pendingCandidatesRef,
    makingOfferRef,
    flushPendingPeers,
  };
}