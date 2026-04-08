import { useEffect, useRef } from "react";

/**
 * All props are stored in a ref so every socket handler always calls the
 * latest version of each callback — no stale-closure bugs even though the
 * effect only runs once per socket instance.
 */
export default function useSocket({
  socketRef,
  roomId,
  setMyId,
  setParticipantsMeta,
  setChatMessages,
  seenMsgIdsRef,
  createPeerConnection,
  safeNegotiateOffer,
  isInitiatorFor,
  politeRef,
  pendingCandidatesRef,
  pcsRef,
  closePeer,
  removeAnalyzer,
  recordersRef,
  setEmotionsMap,
  handleSignal,
  navigate,
  cleanupAll,
  persistHistorySnapshot,
  handleIncomingMessage,
  handleAck,
}) {
  // Mirror every prop into a ref so handlers always see current values.
  const h = useRef({});
  h.current = {
    setMyId,
    setParticipantsMeta,
    setChatMessages,
    seenMsgIdsRef,
    createPeerConnection,
    safeNegotiateOffer,
    isInitiatorFor,
    politeRef,
    pendingCandidatesRef,
    pcsRef,
    closePeer,
    removeAnalyzer,
    recordersRef,
    setEmotionsMap,
    handleSignal,
    navigate,
    cleanupAll,
    persistHistorySnapshot,
    handleIncomingMessage,
    handleAck,
  };

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    let disconnectTimer = null;

    // ── connect ─────────────────────────────────────────────────────────────
    const onConnect = () => {
      h.current.setMyId(socket.id);
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      try { window.myId = socket.id; } catch { }
    };
    socket.on("connect", onConnect);

    // ── chat history ─────────────────────────────────────────────────────────
    const onChatHistory = (history = []) => {
      const seen = h.current.seenMsgIdsRef.current;
      const unique = [];
      for (const m of history) {
        const id = m.id || `${m.userId}:${m.ts}`;
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(m);
      }
      // Merge with any optimistic local messages that haven't been acked yet.
      h.current.setChatMessages((prev) => {
        if (unique.length === 0) return prev;
        const existingIds = new Set(prev.map((m) => m.id || `${m.userId}:${m.ts}`));
        const fresh = unique.filter((m) => {
          const id = m.id || `${m.userId}:${m.ts}`;
          return !existingIds.has(id);
        });
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    };
    socket.on("chat-history", onChatHistory);

    // ── participants-updated ─────────────────────────────────────────────────
    const onParticipantsUpdated = (participants) => {
      if (!Array.isArray(participants)) return;
      h.current.setParticipantsMeta(
        participants
          .filter((p) => p.id !== socket.id)
          .map((p) => ({ id: p.id, meta: p.meta || {}, polite: !!p.polite }))
      );
    };
    socket.on("participants-updated", onParticipantsUpdated);

    // ── shared peer setup logic ──────────────────────────────────────────────
    const setupPeer = (p) => {
      if (!p?.id || p.id === socket.id) return;

      const { politeRef, pendingCandidatesRef, createPeerConnection, isInitiatorFor, safeNegotiateOffer } = h.current;

      politeRef.current[p.id] =
        typeof p.polite === "boolean" ? p.polite : !isInitiatorFor(p.id);

      pendingCandidatesRef.current[p.id] =
        pendingCandidatesRef.current[p.id] || [];

      const pc = createPeerConnection(p.id);
      if (!pc) return;

      if (isInitiatorFor(p.id)) {
        const tryNegotiate = () => {
          if (pc.signalingState === "stable") {
            safeNegotiateOffer(p.id);
          } else {
            setTimeout(tryNegotiate, 50);
          }
        };
        tryNegotiate();
      }
    };

    // ── existing-participants ────────────────────────────────────────────────
    const onExistingParticipants = (existing) => {
      const normalized = (Array.isArray(existing) ? existing : []).map(
        (item) => ({ id: item.id, polite: item.polite, meta: item.meta || {} })
      );

      h.current.setParticipantsMeta((prev) => {
        const map = {};
        prev.forEach((p) => (map[p.id] = p));
        normalized.forEach((p) => {
          map[p.id] = { id: p.id, meta: p.meta || {}, polite: p.polite };
        });
        return Object.values(map);
      });

      normalized.forEach(setupPeer);
    };
    socket.on("existing-participants", onExistingParticipants);

    // ── user-joined ──────────────────────────────────────────────────────────
    const onUserJoined = (peer) => {
      const peerId = peer?.id;
      if (!peerId || peerId === socket.id) return;

      h.current.setParticipantsMeta((prev) => {
        if (prev.some((p) => p.id === peerId)) return prev;
        return [...prev, { id: peerId, meta: peer.meta || {} }];
      });

      setupPeer(peer);
    };
    socket.on("user-joined", onUserJoined);

    // ── user-left ────────────────────────────────────────────────────────────
    const onUserLeft = (peerId) => {
      h.current.setParticipantsMeta((prev) =>
        prev.filter((p) => p.id !== peerId)
      );
      h.current.closePeer(peerId);
      h.current.removeAnalyzer(peerId);
      delete h.current.recordersRef.current[peerId];
      h.current.setEmotionsMap((prev) => {
        const copy = { ...prev };
        delete copy[peerId];
        return copy;
      });
    };
    socket.on("user-left", onUserLeft);

    // ── signal ───────────────────────────────────────────────────────────────
    const onSignal = async (fromId, messageStr) => {
      if (!fromId || !messageStr) return;
      try {
        await h.current.handleSignal(fromId, messageStr);
      } catch { }
    };
    socket.on("signal", onSignal);

    // ── chat-message ─────────────────────────────────────────────────────────
    const onChatMessage = (m) => {
      h.current.handleIncomingMessage(m);
    };
    socket.on("chat-message", onChatMessage);

    // ── chat-ack ─────────────────────────────────────────────────────────────
    const onChatAck = (msg) => {
      if (!msg?.id) return;
      h.current.handleAck(msg.id);
    };
    socket.on("chat-ack", onChatAck);

    // ── end-meeting ──────────────────────────────────────────────────────────
    const onEndMeeting = async () => {
      try {
        await h.current.persistHistorySnapshot();
      } catch { }
      h.current.cleanupAll();
      h.current.navigate("/home");
    };
    socket.on("end-meeting", onEndMeeting);

    // ── disconnect ───────────────────────────────────────────────────────────
    const onDisconnect = () => {
      if (disconnectTimer) return;
      disconnectTimer = setTimeout(() => {
        if (!socket.connected) {
          Object.keys(h.current.pcsRef.current).forEach((peerId) => {
            h.current.closePeer(peerId);
          });
          h.current.cleanupAll();
          h.current.navigate("/home");
        }
      }, 3000);
    };
    socket.on("disconnect", onDisconnect);

    // ── emotion handlers ─────────────────────────────────────────────────────
    const emotionHandler = (payload) => {
      const participantId =
        payload.participant_id ||
        payload.participantId ||
        payload.from ||
        payload.userId;

      if (!participantId) return;

      const emotion =
        payload?.result?.result || payload?.result || payload?.emotion;

      if (!emotion) return;

      if (emotion.label) {
        h.current.setEmotionsMap((prev) => ({
          ...prev,
          [participantId]: { label: emotion.label, score: emotion.score ?? 1 },
        }));
        return;
      }

      if (emotion.emotion) {
        h.current.setEmotionsMap((prev) => ({
          ...prev,
          [participantId]: {
            label: emotion.emotion,
            score: emotion.confidence ?? 1,
          },
        }));
        return;
      }

      if (emotion.probs) {
        const [topLabel, topScore] = Object.entries(emotion.probs).reduce(
          (max, curr) => (curr[1] > max[1] ? curr : max),
          ["neutral/calm", 0]
        );
        h.current.setEmotionsMap((prev) => ({
          ...prev,
          [participantId]: { label: topLabel, score: topScore },
        }));
      }
    };

    socket.on("emotion.result", emotionHandler);
    socket.on("emotion.update", emotionHandler);
    socket.on("emotion", emotionHandler);

    // ── cleanup ──────────────────────────────────────────────────────────────
    return () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      socket.off("connect", onConnect);
      socket.off("chat-history", onChatHistory);
      socket.off("participants-updated", onParticipantsUpdated);
      socket.off("existing-participants", onExistingParticipants);
      socket.off("user-joined", onUserJoined);
      socket.off("user-left", onUserLeft);
      socket.off("signal", onSignal);
      socket.off("chat-message", onChatMessage);
      socket.off("chat-ack", onChatAck);
      socket.off("end-meeting", onEndMeeting);
      socket.off("disconnect", onDisconnect);
      socket.off("emotion.result", emotionHandler);
      socket.off("emotion.update", emotionHandler);
      socket.off("emotion", emotionHandler);
    };
    // Intentionally only re-runs when the socket instance changes.
    // All other values are accessed through the stable `h` ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketRef.current]);
}