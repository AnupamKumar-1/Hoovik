import { useRef, useCallback } from "react";


function streamHasAudio(stream) {
  return stream?.getAudioTracks?.().some(
    (t) => t.enabled && t.readyState === "live"
  );
}

function safeClose(pc) {
  try {
    if (pc && pc.connectionState !== "closed") pc.close();
  } catch { }
}


const NEGOTIATION_DEBOUNCE_MS = 100;
const DISCONNECTED_TIMEOUT_MS = 5000; // wait before tearing down on "disconnected"


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
  // Signaling state maps (keyed by peerId)
  const makingOfferRef = useRef({});
  const ignoreOfferRef = useRef({});
  const politeRef = useRef({});
  const pendingCandidatesRef = useRef({});
  const isSettingRemoteAnswerPending = useRef({});

  // Timers
  const negotiationTimeoutRef = useRef({});
  const disconnectTimeoutRef = useRef({});

  // Per-peer supplementary state
  const remoteStreamsMapRef = useRef({}); // peerId → MediaStream
  const analyzerAttachedRef = useRef({}); // peerId → boolean


  // Teardown a single peer — safe to call multiple times


  const teardown = useCallback((peerId) => {
    // Cancel pending timers first so nothing fires after cleanup
    if (negotiationTimeoutRef.current[peerId]) {
      clearTimeout(negotiationTimeoutRef.current[peerId]);
      delete negotiationTimeoutRef.current[peerId];
    }
    if (disconnectTimeoutRef.current[peerId]) {
      clearTimeout(disconnectTimeoutRef.current[peerId]);
      delete disconnectTimeoutRef.current[peerId];
    }

    const pc = pcsRef.current[peerId];
    if (pc) {
      safeClose(pc);
      delete pcsRef.current[peerId];
    }

    // Clean all signaling state
    delete makingOfferRef.current[peerId];
    delete ignoreOfferRef.current[peerId];
    delete pendingCandidatesRef.current[peerId];
    delete isSettingRemoteAnswerPending.current[peerId];

    // Clean supplementary state
    delete remoteStreamsMapRef.current[peerId];
    delete analyzerAttachedRef.current[peerId];

    removeAnalyzer(peerId);

    setRemoteStreams((prev) => {
      if (!prev[peerId]) return prev;
      const copy = { ...prev };
      delete copy[peerId];
      return copy;
    });
  }, [pcsRef, setRemoteStreams, removeAnalyzer]);


  


  const createPeerConnection = useCallback((peerId) => {
    // Return existing healthy connection
    const existing = pcsRef.current[peerId];

    if (existing) {
      safeClose(existing);
      delete pcsRef.current[peerId];
    }
    const pc = new RTCPeerConnection(ICE_CONFIG);

    makingOfferRef.current[peerId] = false;
    ignoreOfferRef.current[peerId] = false;
    pendingCandidatesRef.current[peerId] = [];
    isSettingRemoteAnswerPending.current[peerId] = false;
    analyzerAttachedRef.current[peerId] = false;


    try {
      const ls = localStreamRef.current;
      if (ls) {
        ls.getTracks().forEach((track) => {
          const sender = pc.getSenders().find(
            (s) => s.track?.kind === track.kind
          );

          if (sender) {
            sender.replaceTrack(track);
          } else {
            pc.addTrack(track, ls);
          }
        });
      }
    } catch (err) {
      console.error(`[useWebRTC] Failed to add local tracks for ${peerId}:`, err);
      safeClose(pc);
      return null;
    }
    pcsRef.current[peerId] = pc;


    pc.ontrack = (ev) => {
      const stream = ev.streams?.[0];
      if (!stream) return;

      setRemoteStreams((prev) => ({
        ...prev,
        [peerId]: stream,
      }));

      // Attach analyzer once
      if (
        streamHasAudio(stream) &&
        analyzerAttachedRef.current[peerId] !== true
      ) {
        analyzerAttachedRef.current[peerId] = true;

        try {
          createAnalyzerForStream(peerId, stream);
        } catch (err) {
          console.warn(`[useWebRTC] Analyzer failed:`, err);
          analyzerAttachedRef.current[peerId] = false;
        }
      }
    };

    // ── ICE candidates
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      socketRef.current?.emit(
        "signal",
        peerId,
        JSON.stringify({ candidate: ev.candidate })
      );
    };

    pc.onicecandidateerror = (ev) => {
      // Only log meaningful errors 
      if (ev.port !== 9) {
        console.warn(`[useWebRTC] ICE candidate error for ${peerId}:`, ev.errorText);
      }
    };

    // ── Negotiation (debounced to prevent spam)
    pc.onnegotiationneeded = () => {
      if (negotiationTimeoutRef.current[peerId]) {
        clearTimeout(negotiationTimeoutRef.current[peerId]);
      }

      negotiationTimeoutRef.current[peerId] = setTimeout(async () => {
        delete negotiationTimeoutRef.current[peerId];

        if (
          makingOfferRef.current[peerId] ||
          pc.signalingState !== "stable" ||
          pc.connectionState === "closed"
        ) return;

        try {
          makingOfferRef.current[peerId] = true;
          await pc.setLocalDescription(await pc.createOffer());
          socketRef.current?.emit(
            "signal",
            peerId,
            JSON.stringify({ description: pc.localDescription })
          );
        } catch (err) {
          console.error(`[useWebRTC] Negotiation error for ${peerId}:`, err);
        } finally {
          makingOfferRef.current[peerId] = false;
        }
      }, NEGOTIATION_DEBOUNCE_MS);
    };

    // ── Connection state
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;

      if (state === "connected") {
        // Cancel any pending disconnect teardown
        if (disconnectTimeoutRef.current[peerId]) {
          clearTimeout(disconnectTimeoutRef.current[peerId]);
          delete disconnectTimeoutRef.current[peerId];
        }
      }

      if (state === "disconnected") {
        // "disconnected" is transient — give it time to recover before tearing down
        disconnectTimeoutRef.current[peerId] = setTimeout(() => {
          const current = pcsRef.current[peerId];
          if (
            current &&
            ["disconnected", "failed"].includes(current.connectionState)
          ) {
            console.warn(`[useWebRTC] Peer ${peerId} did not recover, tearing down`);
            teardown(peerId);
          }
        }, DISCONNECTED_TIMEOUT_MS);
      }

      if (state === "failed" || state === "closed") {
        teardown(peerId);
      }
    };

    // ── ICE connection state (supplementary logging) ──
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        console.warn(`[useWebRTC] ICE failed for ${peerId}, restarting ICE`);
        try {
          pc.restartIce();
        } catch { }
      }
    };

    return pc;
  }, [
    ICE_CONFIG,
    pcsRef,
    localStreamRef,
    socketRef,
    setRemoteStreams,
    createAnalyzerForStream,
    teardown,
  ]);


  // safeNegotiateOffer — called externally when
  // tracks are added after initial connection


  const safeNegotiateOffer = useCallback(async (peerId) => {
    const pc = pcsRef.current[peerId];
    if (!pc) return;

    if (
      makingOfferRef.current[peerId] ||
      pc.signalingState !== "stable" ||
      pc.connectionState === "closed"
    ) return;

    try {
      makingOfferRef.current[peerId] = true;
      await pc.setLocalDescription(await pc.createOffer());
      socketRef.current?.emit(
        "signal",
        peerId,
        JSON.stringify({ description: pc.localDescription })
      );
    } catch (err) {
      console.error(`[useWebRTC] safeNegotiateOffer error for ${peerId}:`, err);
    } finally {
      makingOfferRef.current[peerId] = false;
    }
  }, [pcsRef, socketRef]);


  // handleSignal — Perfect Negotiation pattern


  const handleSignal = useCallback(async (fromId, messageStr) => {
    if (!socketRef.current) return;
    if (fromId === socketRef.current.id) return;

    let msg;
    try {
      msg = JSON.parse(messageStr);
    } catch {
      console.warn("[useWebRTC] Failed to parse signal message");
      return;
    }

    const pc = pcsRef.current[fromId] || createPeerConnection(fromId);
    if (!pc) return;

    const polite = !!politeRef.current[fromId];

    try {
      // ── SDP description
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

        // Rollback only when needed (polite peer, offer collision)
        if (isOffer && offerCollision) {
          try {
            await pc.setLocalDescription({ type: "rollback" });
          } catch (err) {
            console.warn(`[useWebRTC] Rollback failed for ${fromId}:`, err);
          }
        }

        // Answer guard — prevents "InvalidStateError" on duplicate answers
        if (isAnswer) {
          if (pc.signalingState !== "have-local-offer") {
            console.warn(
              `[useWebRTC] Skipping answer in wrong state: ${pc.signalingState}`
            );
            return;
          }
          if (pc.currentRemoteDescription) {
            console.warn(`[useWebRTC] Duplicate answer ignored for ${fromId}`);
            return;
          }
        }

        isSettingRemoteAnswerPending.current[fromId] = isAnswer;

        await pc.setRemoteDescription(description);

        isSettingRemoteAnswerPending.current[fromId] = false;

        // Flush queued ICE candidates
        const pending = pendingCandidatesRef.current[fromId] || [];
        pendingCandidatesRef.current[fromId] = [];
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!ignoreOfferRef.current[fromId]) {
              console.warn(`[useWebRTC] Queued ICE candidate error for ${fromId}:`, err);
            }
          }
        }

        // Send answer if received an offer
        if (isOffer) {
          await pc.setLocalDescription(await pc.createAnswer());
          socketRef.current?.emit(
            "signal",
            fromId,
            JSON.stringify({ description: pc.localDescription })
          );
        }
      }

      // ICE candidate
      else if (msg.candidate) {
        // Ensure array exists (race: candidate arrives before createPeerConnection)
        pendingCandidatesRef.current[fromId] =
          pendingCandidatesRef.current[fromId] || [];

        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch (err) {
            if (!ignoreOfferRef.current[fromId]) {
              console.warn(`[useWebRTC] ICE candidate error for ${fromId}:`, err);
            }
          }
        } else {
          pendingCandidatesRef.current[fromId].push(msg.candidate);
        }
      }
    } catch (err) {
      console.error(`[useWebRTC] Signal handling error for ${fromId}:`, err);
    }
  }, [socketRef, pcsRef, politeRef, createPeerConnection]);


  return {
    createPeerConnection,
    safeNegotiateOffer,
    handleSignal,
    teardown,
    politeRef,
    pendingCandidatesRef,
  };
}