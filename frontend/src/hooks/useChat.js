import { useState, useRef, useCallback } from "react";

const MAX_TEXT_LENGTH = 2000;
const ACK_TIMEOUT_MS = 5000;

function resolveIdentity(userId, displayName) {
  return {
    resolvedUserId: userId ?? localStorage.getItem("userId") ?? "",
    resolvedName: displayName ?? localStorage.getItem("displayName") ?? "Guest",
  };
}

function insertSorted(prev, msg) {
  const ts = msg.ts ?? 0;
  if (prev.length === 0 || ts >= (prev[prev.length - 1].ts ?? 0)) {
    return [...prev, msg];
  }
  const idx = prev.findLastIndex((m) => (m.ts ?? 0) <= ts);
  const result = [...prev];
  result.splice(idx + 1, 0, msg);
  return result;
}

export default function useChat({ socketRef, roomId, userId, displayName }) {
  const [chatMessages, setChatMessages] = useState([]);
  const seenMsgIdsRef = useRef(new Set());
  const pendingAcksRef = useRef(new Map());

  const _setStatus = useCallback((msgId, status) => {
    setChatMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, status } : m))
    );
  }, []);

  const _clearAckTimer = useCallback((msgId) => {
    const timer = pendingAcksRef.current.get(msgId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingAcksRef.current.delete(msgId);
    }
  }, []);

  const _armAckTimer = useCallback((msgId) => {
    _clearAckTimer(msgId);
    const timer = setTimeout(() => {
      pendingAcksRef.current.delete(msgId);
      _setStatus(msgId, "failed");
    }, ACK_TIMEOUT_MS);
    pendingAcksRef.current.set(msgId, timer);
  }, [_clearAckTimer, _setStatus]);

  const _addMessage = useCallback((msg) => {
    if (!msg?.id) return;
    if (seenMsgIdsRef.current.has(msg.id)) return;
    seenMsgIdsRef.current.add(msg.id);
    setChatMessages((prev) => insertSorted(prev, msg));
  }, []);

  const sendChatMessage = useCallback((text) => {
    const socket = socketRef.current;
    if (!text?.trim() || !socket?.connected) return;

    const { resolvedUserId, resolvedName } = resolveIdentity(userId, displayName);
    const id = crypto.randomUUID();

    const msg = {
      id,
      userId: resolvedUserId,
      fromSocketId: socket.id,
      name: resolvedName,
      text: String(text).trim().slice(0, MAX_TEXT_LENGTH),
      meta: { name: resolvedName, userId: resolvedUserId },
      ts: Date.now(),
      status: "pending",
    };

    _addMessage(msg);
    _armAckTimer(id);

    socket.emit("chat-message", roomId, msg, (ack) => {
      _clearAckTimer(id);
      _setStatus(id, ack?.ok ? "sent" : "failed");
    });
  }, [socketRef, roomId, userId, displayName, _addMessage, _armAckTimer, _clearAckTimer, _setStatus]);

  const handleIncomingMessage = useCallback((msg) => {
    if (!msg?.id) return;
    _addMessage({ ...msg, status: "sent" });
  }, [_addMessage]);

  const handleAck = useCallback((msgId) => {
    if (!msgId) return;
    _clearAckTimer(msgId);
    _setStatus(msgId, "sent");
  }, [_clearAckTimer, _setStatus]);

  const retryMessage = useCallback((msg) => {
    const socket = socketRef.current;
    if (!msg?.id || !socket?.connected) return;

    _setStatus(msg.id, "pending");
    _armAckTimer(msg.id);

    socket.emit("chat-message", roomId, msg, (ack) => {
      _clearAckTimer(msg.id);
      _setStatus(msg.id, ack?.ok ? "sent" : "failed");
    });
  }, [socketRef, roomId, _setStatus, _armAckTimer, _clearAckTimer]);

  const clearChat = useCallback(() => {
    pendingAcksRef.current.forEach(clearTimeout);
    pendingAcksRef.current.clear();
    seenMsgIdsRef.current.clear();
    setChatMessages([]);
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