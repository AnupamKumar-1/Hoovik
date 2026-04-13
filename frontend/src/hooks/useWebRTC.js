import { useRef, useCallback, useEffect } from "react";

function safeClose(pc) {
  try {
    if (pc && pc.connectionState !== "closed") pc.close();
  } catch { }
}

const DISCONNECTED_TIMEOUT_MS = 5000;

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
  recordersRef,
  ICE_CONFIG,
}) {
  const makingOfferRef = useRef({});
  const ignoreOfferRef = useRef({});
  const politeRef = useRef({});
  const pendingCandidatesRef = useRef({});
  const isSettingRemoteAnswerPending = useRef({});
  const disconnectTimeoutRef = useRef({});
  const analyzerAttachedRef = useRef({});
  const pendingSignalsRef = useRef({});
  const pendingPeerQueueRef = useRef([]);
  const handleSignalRef = useRef(null);
  const streamMapRef = useRef({});

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
      delete pendingSignalsRef.current[peerId];
      delete streamMapRef.current[peerId];

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
    [pcsRef, createAnalyzerForStream]
  );

  const createPeerConnection = useCallback(
    (peerId) => {
      if (!localStreamRef.current) {
        if (!pendingPeerQueueRef.current.includes(peerId)) {
          pendingPeerQueueRef.current.push(peerId);
        }
        return null;
      }

      const existing = pcsRef.current[peerId];
      if (existing) {
        const state = existing.connectionState;
        if (state === "connected" || state === "connecting" || state === "new") {
          return existing;
        }
        existing.ontrack = null;
        existing.onicecandidate = null;
        existing.onnegotiationneeded = null;
        existing.onconnectionstatechange = null;
        existing.oniceconnectionstatechange = null;
        safeClose(existing);
        delete pcsRef.current[peerId];
      }

      const pc = new RTCPeerConnection(ICE_CONFIG);
      const pcId = Symbol();
      pc.__id = pcId;

      if (politeRef.current[peerId] === undefined) {
        const myId = socketRef.current?.id;
        politeRef.current[peerId] = myId && peerId ? myId > peerId : false;
      }

      makingOfferRef.current[peerId] = false;
      ignoreOfferRef.current[peerId] = false;
      pendingCandidatesRef.current[peerId] = [];
      isSettingRemoteAnswerPending.current[peerId] = false;
      analyzerAttachedRef.current[peerId] = false;

      try {
        const ls = localStreamRef.current;
        if (ls) {
          ls.getTracks().forEach((track) => {
            const sender = pc
              .getSenders()
              .find((s) => s.track?.kind === track.kind);
            if (sender) {
              sender.replaceTrack(track);
            } else {
              pc.addTrack(track, ls);
            }
          });
        }
      } catch {
        safeClose(pc);
        return null;
      }

      pcsRef.current[peerId] = pc;

      pc.ontrack = (ev) => {
        let stream = ev.streams?.[0];

        if (!stream) {
          const existing = streamMapRef.current[peerId]?.stream;
          if (existing) {
            existing.addTrack(ev.track);
            stream = existing;
          } else {
            stream = new MediaStream([ev.track]);
          }
        }

        const prevEntry = streamMapRef.current[peerId];
        const newTrackCount = stream.getTracks().length;

        if (prevEntry && prevEntry.stream === stream && prevEntry.trackCount === newTrackCount) {
          return;
        }

        streamMapRef.current[peerId] = { stream, trackCount: newTrackCount };

        setRemoteStreams((prev) => {
          const prevVal = prev[peerId];
          if (prevVal && prevVal.stream === stream && prevVal.trackCount === newTrackCount) return prev;
          return { ...prev, [peerId]: { stream, trackCount: newTrackCount } };
        });

        const onTrackChange = () => {
          const currentPc = pcsRef.current[peerId];
          if (!currentPc || currentPc.__id !== pcId) {
            stream.removeEventListener("addtrack", onTrackChange);
            stream.removeEventListener("removetrack", onTrackChange);
            return;
          }
          const updatedCount = stream.getTracks().length;
          const cached = streamMapRef.current[peerId];
          if (cached && cached.stream === stream && cached.trackCount === updatedCount) return;
          streamMapRef.current[peerId] = { stream, trackCount: updatedCount };
          setRemoteStreams((prev) => {
            const prevVal = prev[peerId];
            if (
              prevVal &&
              prevVal.stream === stream &&
              prevVal.trackCount === updatedCount
            )
              return prev;
            return { ...prev, [peerId]: { stream, trackCount: updatedCount } };
          });
        };

        if (!prevEntry || prevEntry.stream !== stream) {
          stream.addEventListener("addtrack", onTrackChange);
          stream.addEventListener("removetrack", onTrackChange);
        }

        attachAnalyzerWhenReady(peerId, stream, pcId);
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
          pc.connectionState === "closed"
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
        } catch { }
        finally {
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
          if (current && current.__id === pcId) {
            teardown(peerId);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          try {
            pc.restartIce();
          } catch { }
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
      setRemoteStreams,
      attachAnalyzerWhenReady,
      teardown,
    ]
  );

  const flushPendingPeers = useCallback(() => {
    const queue = [...pendingPeerQueueRef.current];
    pendingPeerQueueRef.current = [];
    queue.forEach((peerId) => createPeerConnection(peerId));
  }, [createPeerConnection]);

  useEffect(() => {
    if (localStreamRef.current) {
      flushPendingPeers();
    }

    const onLocalStreamReady = (ev) => {
      if (ev.detail?.stream) {
        localStreamRef.current = ev.detail.stream;
      }
      flushPendingPeers();
    };

    window.addEventListener("localstream:ready", onLocalStreamReady);
    return () =>
      window.removeEventListener("localstream:ready", onLocalStreamReady);
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
        pendingSignalsRef.current[fromId] ||= [];
        pendingSignalsRef.current[fromId].push(messageStr);
        createPeerConnection(fromId);
        return;
      }

      const pc = pcsRef.current[fromId];
      const polite = !!politeRef.current[fromId];

      try {
        if (msg.description) {
          const { description } = msg;
          const isOffer = description.type === "offer";
          const isAnswer = description.type === "answer";

          const readyForOffer =
            !makingOfferRef.current[fromId] &&
            (pc.signalingState === "stable" ||
              isSettingRemoteAnswerPending.current[fromId]);

          const offerCollision = isOffer && !readyForOffer;

          ignoreOfferRef.current[fromId] = !polite && offerCollision;
          if (ignoreOfferRef.current[fromId]) return;

          if (isOffer && offerCollision) {
            try {
              await pc.setLocalDescription({ type: "rollback" });
            } catch { }
          }

          if (isAnswer && pc.signalingState !== "have-local-offer") return;

          isSettingRemoteAnswerPending.current[fromId] = isAnswer;
          await pc.setRemoteDescription(description);
          isSettingRemoteAnswerPending.current[fromId] = false;

          const pending = pendingCandidatesRef.current[fromId] || [];
          pendingCandidatesRef.current[fromId] = [];
          for (const candidate of pending) {
            try {
              await pc.addIceCandidate(candidate);
            } catch { }
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
          pendingCandidatesRef.current[fromId] =
            pendingCandidatesRef.current[fromId] || [];

          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(msg.candidate);
            } catch { }
          } else {
            pendingCandidatesRef.current[fromId].push(msg.candidate);
          }
        }
      } catch { }
    },
    [socketRef, pcsRef, politeRef, createPeerConnection]
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