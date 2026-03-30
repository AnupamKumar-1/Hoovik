import { useState, useRef, useCallback } from "react";

export default function useChat({ socketRef, roomId }) {
  const [chatMessages, setChatMessages] = useState([]);
  const seenMsgIdsRef = useRef(new Set());

  const addMessage = useCallback((msg) => {
    if (!msg || !msg.id) return;

    if (seenMsgIdsRef.current.has(msg.id)) return;
    seenMsgIdsRef.current.add(msg.id);

    setChatMessages((prev) => {
      const updated = [...prev, msg];

      updated.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      return updated;
    });
  }, []);

  const sendChatMessage = useCallback(
    (text) => {
      if (!text || !socketRef.current) return;

      const userId = localStorage.getItem("userId");
      const name = localStorage.getItem("displayName") || "Guest";

      const id = crypto.randomUUID();

      const msg = {
        id,
        userId,
        fromSocketId: socketRef.current.id,
        name,
        text: String(text).slice(0, 2000),
        meta: { name, userId },
        ts: Date.now(),
        status: "pending",
      };

      addMessage(msg);

      try {
        socketRef.current.emit("chat-message", roomId, msg);
        setTimeout(() => {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, status: "sent" } : m
            )
          );
        }, 300);
      } catch (e) {
        console.warn("chat emit failed", e);

        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, status: "failed" } : m
          )
        );
      }
    },
    [socketRef, roomId, addMessage]
  );


  const handleIncomingMessage = useCallback(
    (msg) => {
      if (!msg || !msg.id) return;

      addMessage({
        ...msg,
        status: "sent",
      });
    },
    [addMessage]
  );

  const handleAck = useCallback((msgId) => {
    if (!msgId) return;

    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, status: "sent" } : m
      )
    );
  }, []);

  const retryMessage = useCallback(
    (msg) => {
      if (!msg || !socketRef.current) return;

      try {
        socketRef.current.emit("chat-message", roomId, msg);

        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id ? { ...m, status: "pending" } : m
          )
        );
      } catch (e) {
        console.warn("retry failed", e);
      }
    },
    [socketRef, roomId]
  );

  const clearChat = useCallback(() => {
    setChatMessages([]);
    seenMsgIdsRef.current.clear();
  }, []);

  return {
    chatMessages,
    setChatMessages,
    sendChatMessage,
    handleIncomingMessage,
    handleAck,
    retryMessage,
    seenMsgIdsRef,
    clearChat,
  };
}