import { useRef } from "react";

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
  const negotiationTimeoutRef = useRef({}); // 🔥 NEW (debounce)

  function streamHasAudio(stream) {
    return stream?.getAudioTracks?.().some(
      (t) => t.enabled && t.readyState === "live"
    );
  }

  function createPeerConnection(peerId) {
    if (pcsRef.current[peerId]) return pcsRef.current[peerId];

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcsRef.current[peerId] = pc;

    makingOfferRef.current[peerId] = false;
    ignoreOfferRef.current[peerId] = false;
    pendingCandidatesRef.current[peerId] =
      pendingCandidatesRef.current[peerId] || [];
    isSettingRemoteAnswerPending.current[peerId] = false;

    // ✅ Attach local tracks once
    const ls = localStreamRef.current;
    if (ls && pc.getSenders().length === 0) {
  ls.getTracks().forEach((track) => {
    pc.addTrack(track, ls);
  });
}

    // ✅ Remote stream
    pc._remoteStream = new MediaStream();

    pc.ontrack = (ev) => {
      const track = ev.track;

      if (!pc._remoteStream.getTracks().some((t) => t.id === track.id)) {
        pc._remoteStream.addTrack(track);
      }

      setRemoteStreams((prev) => ({
        ...prev,
        [peerId]: pc._remoteStream,
      }));

      try {
  if (streamHasAudio(pc._remoteStream)) {
    if (!pc._analyzerAttached) {
      createAnalyzerForStream(peerId, pc._remoteStream);
      pc._analyzerAttached = true;
    }
  } else {
    if (pc._analyzerAttached) {
      removeAnalyzer(peerId);
      pc._analyzerAttached = false;
    }
  }
} catch {}
    };

    // ✅ ICE
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socketRef.current?.emit(
          "signal",
          peerId,
          JSON.stringify({ candidate: ev.candidate })
        );
      }
    };

    // 🔥 DEBOUNCED NEGOTIATION (FIXES SPAM)
    pc.onnegotiationneeded = () => {
      if (negotiationTimeoutRef.current[peerId]) {
        clearTimeout(negotiationTimeoutRef.current[peerId]);
      }

      negotiationTimeoutRef.current[peerId] = setTimeout(async () => {
        try {
          if (
  makingOfferRef.current[peerId] ||
  pc.signalingState !== "stable" ||
  pc.connectionState === "closed"
) {
  return;
}

          makingOfferRef.current[peerId] = true;

          await pc.setLocalDescription(await pc.createOffer());

          socketRef.current?.emit(
            "signal",
            peerId,
            JSON.stringify({
              description: pc.localDescription,
            })
          );
        } catch (err) {
          console.error("Negotiation error:", err);
        } finally {
          makingOfferRef.current[peerId] = false;
        }
      }, 100); // 🔥 debounce delay
    };

    // ✅ Cleanup
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        try {
          pc.close();
        } catch {}

        delete pcsRef.current[peerId];
        delete makingOfferRef.current[peerId];
delete ignoreOfferRef.current[peerId];
delete pendingCandidatesRef.current[peerId];
delete isSettingRemoteAnswerPending.current[peerId];
delete negotiationTimeoutRef.current[peerId];

        setRemoteStreams((prev) => {
          const copy = { ...prev };
          delete copy[peerId];
          return copy;
        });

        removeAnalyzer(peerId);
      }
    };

    return pc;
  }

  // 🔥 FINAL PERFECT SIGNAL HANDLER
  async function handleSignal(fromId, messageStr) {
    if (!socketRef.current || fromId === socketRef.current.id) return;

    let msg;
    try {
      msg = JSON.parse(messageStr);
    } catch {
      return;
    }

    const pc = pcsRef.current[fromId] || createPeerConnection(fromId);
    if (!pc) return;

    const polite = !!politeRef.current[fromId];

    try {
      if (msg.description) {
        const description = msg.description;
        const isOffer = description.type === "offer";
        const isAnswer = description.type === "answer";

        const readyForOffer =
          !makingOfferRef.current[fromId] &&
          (pc.signalingState === "stable" ||
            isSettingRemoteAnswerPending.current[fromId]);

        const offerCollision = isOffer && !readyForOffer;

        ignoreOfferRef.current[fromId] = !polite && offerCollision;

        if (ignoreOfferRef.current[fromId]) {
          console.warn("Ignoring offer (impolite)");
          return;
        }

        // 🔥 rollback ONLY if needed
        if (isOffer && offerCollision) {
          try {
            await pc.setLocalDescription({ type: "rollback" });
          } catch {}
        }

        // 🔥 STRONG ANSWER GUARD (FIXES YOUR ERROR)
        if (isAnswer) {
          if (pc.signalingState !== "have-local-offer") {
            console.warn("Skipping invalid answer:", pc.signalingState);
            return;
          }

          if (pc.currentRemoteDescription) {
            console.warn("Duplicate answer ignored");
            return;
          }
        }

        isSettingRemoteAnswerPending.current[fromId] = isAnswer;

        await pc.setRemoteDescription(description);

        isSettingRemoteAnswerPending.current[fromId] = false;

        // ✅ apply ICE
        const pending = pendingCandidatesRef.current[fromId] || [];
        for (const c of pending) {
          try {
            await pc.addIceCandidate(c);
          } catch {}
        }
        pendingCandidatesRef.current[fromId] = [];

        if (isOffer) {
          await pc.setLocalDescription(await pc.createAnswer());

          socketRef.current?.emit(
            "signal",
            fromId,
            JSON.stringify({
              description: pc.localDescription,
            })
          );
        }
      } else if (msg.candidate) {
        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(msg.candidate);
          } else {
            pendingCandidatesRef.current[fromId].push(msg.candidate);
          }
        } catch (err) {
          if (!ignoreOfferRef.current[fromId]) {
            console.error("ICE error:", err);
          }
        }
      }
    } catch (err) {
      console.error("Signal error:", err);
    }
  }

  return {
    createPeerConnection,
    handleSignal,
    politeRef,
    pendingCandidatesRef,
  };
}