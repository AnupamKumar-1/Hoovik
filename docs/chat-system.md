# Chat System

SkyMeetAI includes a full-featured real-time chat built on the existing Socket.IO signaling connection — no separate transport required.

---

## Architecture

Chat runs over the same Socket.IO connection used for WebRTC signaling. Messages are persisted to MongoDB on the backend and replayed to participants who join mid-meeting via `chat-history`. Because the backend is horizontally scaled across three PM2 instances, the Redis pub/sub adapter ensures a message sent through instance A is delivered to clients connected to instances B and C.

### Controlled Chat Buffer

- Stores last 500 messages per meeting
- Prevents unbounded MongoDB document growth
- Maintains performance during long sessions

> Avoids MongoDB document bloat in real-time systems by capping the chat array at the schema level.

---

## Delivery Guarantees

The client implements an **optimistic UI with ACK-based confirmation and retry**:

```
Client sends "chat-message" (code, msg, ack callback)
  --> Optimistically renders message as "pending" in UI immediately
  --> Sets ACK timeout (5s)

Server (handleChatMessage):
  --> Rate-limit check (20 messages / 10s per user, Redis sliding window)
  --> Sanitize text (sanitize-html, max 2000 chars)
  --> Persist to MongoDB (meeting.chat array)
  --> Broadcast to room: socket.to(roomName).emit("chat-message", payload)
  --> ACK sender:        socket.emit("chat-ack", payload)

Client on "chat-ack":
  --> Marks message as delivered, clears timeout

Client on ACK timeout:
  --> Marks message as failed
  --> Surfaces retry UI to user
  --> retryMessage() re-emits with same message ID (idempotent)
```

Duplicate suppression is handled client-side via a `seenMsgIdsRef` set — messages are keyed by `msg.id` (a client-generated UUID, or a server-generated 10-byte hex fallback if absent) or `userId:ts` fallback, ensuring deduplication across reconnects, history replays, and retries.

---

## Key Implementation Details

### `useChat` Hook

Manages the full lifecycle:
- Maintains an optimistic message queue with per-message status (`pending` / `delivered` / `failed`)
- Deduplicates against `seenMsgIdsRef` before adding to state — safe across reconnects and history replays
- `retryMessage(id)` re-emits a failed message using its original ID, allowing the server to treat it idempotently
- `sendChatMessage(text)` emits with an ACK callback and sets a timeout; on expiry the message transitions to `failed`

### `ChatInput` Component

Keyboard-native UX:
- `Enter` sends, `Shift+Enter` is a newline (standard convention)
- Focus is restored via `requestAnimationFrame` after send to keep the input ready without layout thrashing
- `maxLength={1000}` enforced at the input level; server enforces `MAX_CHAT_LEN = 2000`

### `MeetChatPanel`

Animated via Framer Motion and renders as a side panel on desktop. On mobile it slides up as a sheet managed by `MobilePanelSheet`, toggled via the control bar or the `C` keyboard shortcut.

### Unread Badge

An `unreadCount` counter increments whenever new messages arrive while the chat panel is closed. It resets to zero on panel open.

### History on Join

The server sends the full persisted `meeting.chat` array as `chat-history` when a participant joins. Messages are normalized to a stable shape (`id`, `userId`, `name`, `text`, `ts`) before emission, with missing IDs generated server-side to ensure client-side deduplication works correctly even for legacy messages.

### Rate Limiting

Chat is rate-limited at 20 messages per 10-second sliding window per user via a Redis counter (`socket:chat:rate:{userId}`). The counter is set with a TTL on first increment, so the window resets automatically.

### Sanitization

All message text is passed through `sanitize-html` before persistence and broadcast, stripping any HTML/script injection attempts while preserving plain text content.

---

## Chat Data Flow

```
1. User types message --> ChatInput onChange updates local state
2. User presses Enter (or clicks Send button)
   --> useChat.sendChatMessage(text)
   --> generates client-side tempId
   --> appends { id: tempId, text, status: "pending" } to chatMessages state (optimistic)
   --> socket.emit("chat-message", code, { id: tempId, text }, ackCallback)
   --> sets 5s ACK timeout

3. Server handleChatMessage:
   --> rate limit check (Redis)       [returns { ok: false, reason: "rate_limited" } if exceeded]
   --> sanitize text (sanitize-html, max 2000 chars)
   --> use client-provided msg.id, or generate crypto.randomBytes(10).toString("hex") if absent
   --> persist to MongoDB: meeting.addChatMessage(chatMsg)
   --> broadcast: socket.to("meeting:{code}").emit("chat-message", payload)
   --> ack sender:  socket.emit("chat-ack", payload)

4. Sender receives "chat-ack"
   --> handleAck(msgId): updates message status to "delivered"
   --> clears ACK timeout

5. Other participants receive "chat-message"
   --> handleIncomingMessage(m): deduplicates via seenMsgIdsRef
   --> appends to chatMessages state

6. If ACK timeout fires (no ack received):
   --> message status transitions to "failed"
   --> UI surfaces retry button
   --> retryMessage(id) re-emits the original payload

7. New participant joins mid-meeting:
   --> server emits "chat-history" with full persisted chat array
   --> client deduplicates against seenMsgIdsRef before merging
```

---

## Why Optimistic UI with ACK-Based Retry?

Optimistic rendering eliminates perceived latency — the message appears instantly in the sender's UI without waiting for a server round-trip. The ACK callback confirms server receipt and persistence; a timeout triggers a failure state with a visible retry option. This gives users confidence that messages were delivered while keeping the interface responsive. Deduplication via `seenMsgIdsRef` ensures retried messages (which carry the same ID) are never shown twice.