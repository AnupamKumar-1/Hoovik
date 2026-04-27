# API Reference

## Authentication

JWT via `Authorization: Bearer <token>`. Transcripts additionally accept `x-host-secret` header for unauthenticated host access.

---

## Rooms

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/rooms` | Optional | Create room. Returns `roomCode` and `hostSecret` |
| `GET` | `/api/v1/rooms/:code` | None | Validate room is active |
| `GET` | `/api/v1/rooms/mine` | JWT | List rooms owned by authenticated user |

---

## Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/users/register` | None | Create account |
| `POST` | `/api/v1/users/login` | None | Returns `accessToken` (1h expiry) |
| `POST` | `/api/v1/users/logout` | None | Clears refresh cookie |
| `GET` | `/api/v1/users/me` | JWT | Authenticated user profile |
| `GET` | `/api/v1/users/get_all_activity` | JWT | Meeting history for user |

---

## Transcripts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/transcripts` | JWT or hostSecret | Save transcript with noise filtering |
| `GET` | `/api/v1/transcripts` | JWT or hostSecret | List transcripts (optional `?meeting_code=`) |
| `GET` | `/api/v1/transcripts/:id` | JWT or hostSecret | Fetch by MongoDB ID or meeting code |

---

## Emotion

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/emotion/upload` | None | HTTP file upload for inference |
| `GET` | `/api/v1/emotion/status` | None | Health check |

---

## Socket Events (client to server)

| Event | Payload | Description |
|-------|---------|-------------|
| `join-call` | `(code, { name, userId })` | Join room, receive peers and chat history |
| `declare-host` | `code` | Mark this socket as room host |
| `signal` | `(targetId, sdpOrIce)` | Relay WebRTC signal to peer |
| `chat-message` | `(code, msg, ack)` | Send message with ACK callback; server persists and broadcasts |
| `update-participant-state` | `{ muted, screen }` | Broadcast AV state to room |
| `update-meta` | `metaUpdate` | Update display name or video state |
| `emotion.frame` | `{ meetingId, participantId, buffer }` | Send video frame for inference |
| `emotion.chunk` | `{ seq, totalChunks, chunk, ... }` | Chunked file upload segment |
| `emotion.chunk.complete` | `{ meetingId, participantId, type }` | Trigger assembly and inference |
| `emotion.chunk.abort` | `{ meetingId, participantId }` | Cancel and clean up partial upload |
| `leave-call` | `code` | Graceful leave |

---

## Socket Events (server to client)

| Event | Payload | Description |
|-------|---------|-------------|
| `existing-participants` | `[{ id, meta, polite }]` | Peers already in room on join |
| `assigned-role` | `{ polite }` | This peer's negotiation role |
| `user-joined` | `{ id, meta, polite }` | New peer joined |
| `user-left` | `socketId` | Peer disconnected |
| `participants-updated` | `[{ id, meta }]` | Full participant list refresh |
| `chat-history` | `[msg]` | Full persisted chat history, sent on join |
| `chat-message` | `msg` | Incoming message from another participant |
| `chat-ack` | `msg` | Delivery confirmation for sender's message |
| `emotion.result` | `{ participantId, result, ts }` | Inference result, emitted to host only |
| `update-participant-state` | `{ peerId, muted }` | Peer AV state changed |
| `participant-meta-updated` | `{ id, meta }` | Peer metadata changed |

---

## Emotion Service (port 5002)

| Path / Event | Type | Description |
|---|---|---|
| `POST /analyze` | HTTP | Single frame or file. Returns `{ result: { emotion, confidence, probs } }` |
| `frame` | Socket in | Raw binary frame bytes |
| `emotion.frame` | Socket in | Dict payload `{ buffer, participantId }` |
| `emotion.result` | Socket out | `{ participantId, result: { emotion, confidence }, ts }` |

---

## Transcript Service (port 5001)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/process_meeting` | Multipart: `audio_files[]`, `meeting_code`, `speaker_map`. Runs full ASR and emotion pipeline. |