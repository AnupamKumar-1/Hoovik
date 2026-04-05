import { useEffect } from "react";

export default function useSocket({
  socketRef,
  roomId,
  setMyId,
  setParticipantsMeta,
  setChatMessages,
  seenMsgIdsRef,
  createPeerConnection,
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
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    
    const onConnect = () => {
      setMyId(socket.id);
      try {
        window.myId = socket.id;
      } catch { }
    };
    socket.on("connect", onConnect);

    // CHAT HISTORY
    const onChatHistory = (history = []) => {
      const seen = seenMsgIdsRef.current;
      const unique = [];

      for (const m of history) {
        const id = m.id || `${m.userId}:${m.ts}`;
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(m);
      }

      setChatMessages(unique);
    };
    socket.once("chat-history", onChatHistory);

    // PARTICIPANTS
    const onParticipantsUpdated = (participants) => {
      if (!Array.isArray(participants)) return;

      setParticipantsMeta(
        participants
          .filter((p) => p.id !== socket.id)
          .map((p) => ({
            id: p.id,
            meta: p.meta || {},
            polite: !!p.polite,
          }))
      );
    };
    socket.on("participants-updated", onParticipantsUpdated);

    const setupPeer = (p) => {
      if (!p?.id || p.id === socket.id) return;

      politeRef.current[p.id] =
        typeof p.polite === "boolean"
          ? p.polite
          : !isInitiatorFor(p.id);

      pendingCandidatesRef.current[p.id] =
        pendingCandidatesRef.current[p.id] || [];

      createPeerConnection(p.id);
    };

    const onExistingParticipants = (existing) => {
      const normalized = (Array.isArray(existing) ? existing : []).map(
        (item) => ({
          id: item.id,
          polite: item.polite,
          meta: item.meta || {},
        })
      );

      setParticipantsMeta((prev) => {
        const map = {};
        prev.forEach((p) => (map[p.id] = p));
        normalized.forEach((p) => {
          map[p.id] = { id: p.id, meta: p.meta || {} };
        });
        return Object.values(map);
      });

      normalized.forEach(setupPeer);
    };
    socket.on("existing-participants", onExistingParticipants);

    const onUserJoined = (peer) => {
      const peerId = peer?.id;
      if (!peerId || peerId === socket.id) return;

      setParticipantsMeta((prev) => {
        if (prev.some((p) => p.id === peerId)) return prev;
        return [...prev, { id: peerId, meta: peer.meta || {} }];
      });

      setupPeer(peer);
    };
    socket.on("user-joined", onUserJoined);

    const onUserLeft = (peerId) => {
      setParticipantsMeta((prev) =>
        prev.filter((p) => p.id !== peerId)
      );

      closePeer(peerId);
      removeAnalyzer(peerId);

      delete recordersRef.current[peerId];

      setEmotionsMap((prev) => {
        const copy = { ...prev };
        delete copy[peerId];
        return copy;
      });
    };
    socket.on("user-left", onUserLeft);


    const onSignal = async (fromId, messageStr) => {
      if (!fromId || !messageStr) return;

      try {
        await handleSignal(fromId, messageStr);
      } catch (err) {
        console.warn("Signal error:", err);
      }
    };
    socket.on("signal", onSignal);

    // CHAT
    const onChatMessage = (m) => {
      handleIncomingMessage(m);
    };
    socket.on("chat-message", onChatMessage);

    const onChatAck = (msg) => {
      if (!msg?.id) return;
      handleAck(msg.id);
    };
    socket.on("chat-ack", onChatAck);

    // END / DISCONNECT
    const onEndMeeting = async () => {
      try {
        await persistHistorySnapshot();
      } catch { }

      cleanupAll();
      navigate("/home");
    };
    socket.on("end-meeting", onEndMeeting);

    const onDisconnect = () => {
      cleanupAll();
      navigate("/home");
    };
    socket.on("disconnect", onDisconnect);


    const emotionHandler = (payload) => {
      console.log("EMOTION EVENT RECEIVED:", payload);

      const participantId =
        payload.participant_id ||
        payload.participantId ||
        payload.from ||
        payload.userId;

      if (!participantId) return;

      const emotion = payload?.result?.result || payload?.result || payload?.emotion;

      if (!emotion) return;

      // direct label
      if (emotion.label) {
        setEmotionsMap((prev) => ({
          ...prev,
          [participantId]: {
            label: emotion.label,
            score: emotion.score ?? 1,
          },
        }));
        return;
      }

      if (emotion.emotion) {
        setEmotionsMap((prev) => ({
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

        setEmotionsMap((prev) => ({
          ...prev,
          [participantId]: {
            label: topLabel,
            score: topScore,
          },
        }));
      }
    };

    socket.onAny((event, ...args) => {
      console.log("📡 SOCKET EVENT:", event, args);
    });

    socket.on("emotion.result", emotionHandler);
    socket.on("emotion.update", emotionHandler);
    socket.on("emotion", emotionHandler);

    // CLEANUP
    return () => {
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
  }, [socketRef, handleSignal, createPeerConnection]);
}