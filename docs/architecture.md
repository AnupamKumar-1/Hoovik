# Architecture

## Services Overview

The system consists of four independent services:

| Service | Stack | Host |
|---------|-------|------|
| Frontend | React 18 SPA | Render |
| Backend (signaling) | Node.js 20 + Express + Socket.IO | AWS EC2 |
| Emotion Service | FastAPI + python-socketio ASGI | AWS EC2 |
| Transcript Service | FastAPI (stateless) | AWS EC2 |

---

## Frontend — Render

React 18 SPA. All stateful logic is encapsulated in custom hooks with zero business logic in components.

| Hook | Responsibility |
|------|----------------|
| `useWebRTC` | `RTCPeerConnection` lifecycle, **Perfect Negotiation pattern**, ICE restart, glare handling |
| `useSocket` | Socket.IO event binding, participant sync, signal relay |
| `useAudioAnalyzer` | Active speaker detection via SSRC (primary) and Web Audio RMS (fallback) |
| `useEmotionCapture` | Periodic frame capture from remote video elements, socket emission |
| `useRecording` | `MediaRecorder` per participant with noise-gated chunk accumulation |
| `useMeetingLifecycle` | Room join/leave, full cleanup, background transcript trigger |
| `useMediaControls` | Audio/video toggle, screen share, `replaceTrack` in existing peer connections |
| `useChat` | Optimistic message queue, ACK timeout, retry on failure |
| `useEmotionSocket` | Dedicated socket to Emotion Service, incoming result parsing and validation |

### WebRTC Perfect Negotiation

Implements the official WebRTC Perfect Negotiation pattern:

- `polite` peer strategy
- Offer collision detection
- Controlled rollback
- Safe renegotiation handling

Benefits:
- Prevents signaling deadlocks
- Handles simultaneous offers correctly
- Enables stable multi-peer connections

> Most WebRTC implementations fail under offer collisions — this system explicitly resolves them using the standardized negotiation model.

---

## Backend — EC2 (3 instances)

Node.js 20 + Express + Socket.IO. Three parallel PM2 processes behind Nginx load balancer.

```js
// ecosystem.config.cjs
apps: [
  { ...base, name: "meet-8000", env: { PORT: 8000 } },
  { ...base, name: "meet-8001", env: { PORT: 8001 } },
  { ...base, name: "meet-8002", env: { PORT: 8002 } },
]
```

Nginx distributes connections across all three. Redis pub/sub (`@socket.io/redis-adapter`) ensures a socket event emitted on instance A reaches clients connected to instances B and C. Room state lives in Redis, not process memory. PM2 config sets `max_memory_restart: 512M` and `exp_backoff_restart_delay: 100ms` so each instance restarts automatically on OOM with exponential backoff.

### Security

- JWT auth (1h expiry, `passport-jwt`)
- Account lockout after 10 failed login attempts (Redis counter, 15min lock)
- Sliding window rate limiting on login (per-user + per-IP), chat messages, and chunk uploads
- Distributed Redis lock on room join (Lua CAS script) prevents race conditions under concurrent joins
- Host secret (SHA-256 hashed, stored in MongoDB) for unauthenticated transcript access
- HTML sanitization on all user-generated content (names, chat, transcription chunks)
- File size limits enforced at multer middleware and application layers

### Host Capability Security

Each meeting generates a unique host secret — only its SHA-256 hash is stored in MongoDB. The plaintext secret is verified per request without requiring a persistent login session.

Benefits:
- Secure host-only operations (transcript access, emotion results)
- Prevents privilege escalation
- Works without persistent login state

> Implements capability-based access control instead of traditional role-based systems.

### Real-time Participant State Engine

Meeting lifecycle is managed using schema-level methods:

- Join → `addParticipant`
- Temporary disconnect → `markParticipantLeft`
- Reconnect → `restoreParticipant`
- Hard leave → `removeParticipant`

Key capabilities:
- Prevents duplicate participants
- Supports reconnection within time window
- Tracks join/leave timestamps
- Maintains consistent meeting state

> Functions as a lightweight state machine persisted in MongoDB.

### Smart Reconnection Handling

- Restores participants using userId OR name + recent activity window
- Uses time-based cutoff (~5 minutes)
- Prevents duplicate entries on reconnect

> Handles unstable networks without breaking meeting continuity.

> Note: `Schema.Types.Mixed` is used intentionally for dynamic participant metadata and analytics payloads.

---

## Emotion Service — EC2

FastAPI + python-socketio ASGI server. Two input paths:

### WebSocket (real-time inference)

One persistent socket per participant. A per-`sid` background coroutine (`_pump`) processes frames asynchronously using a single-slot frame buffer. New frames overwrite the old one — inference always runs on the freshest available frame regardless of network jitter.

The pump exits immediately when no frame is waiting, avoiding idle resource consumption. It is re-spawned on the next incoming frame, so there is no persistent background loop — only active inference tasks.

Inference is strictly rate-limited and decoupled from frame ingestion. Incoming frames overwrite the buffer, ensuring constant latency regardless of input rate (O(1) memory, O(1) queue).

```
Frame arrives --> LATEST_FRAME[sid] = bytes
   (Overwrite buffer ensures only latest frame is processed, preventing queue buildup and unbounded latency)
_pump loop    --> pop frame --> rate limit check --> skip N frames -->
                  decode (OpenCV) --> extract embedding (py-feat) -->
                  append to deque(maxlen=8) --> run_inference -->
                  smooth (EMA, alpha=0.7) --> emit emotion.result
```

The model operates on a fixed 8-frame sliding window. If fewer than 8 frames are available, the sequence is left-padded by repeating the earliest available frame.

### HTTP (`POST /analyze`)

Used for chunked audio/video uploads assembled by the backend. Same inference pipeline, separate per-key embedding buffer.

Graceful degradation is implemented via fallback responses and retry logic at the Node.js layer to handle transient network failures or service unavailability.

---

## Transcript Service — EC2

FastAPI. Triggered once per meeting by the host's browser after the call ends.

> The Transcript Service is stateless and does not directly access the database.  
> All persistence is delegated to the Node.js backend via a secured HTTP API, ensuring centralized validation, authorization, and data consistency.

```
Audio WebM blobs (per participant) -->
ffmpeg --> 16kHz mono WAV -->
Whisper (small) --> timestamped segments -->
DistilRoBERTa (j-hartmann/emotion-english-distilroberta-base, per segment text) -->
merge_segments (sort by start time, interleave speakers) -->
POST /api/v1/transcripts (Node.js, with x-host-secret)
```

### Consistency Model

- The system is eventually consistent — transcripts may appear with slight delay after meeting completion
- Real-time pipelines prioritize latency, while post-processing pipelines prioritize correctness and completeness
- Transcript submission is retried on transient failures (network / service downtime)
- Duplicate submissions are safely handled via MongoDB upsert (meetingCode as key)

---

## Code Deep Dives

### Active Speaker Detection — `useAudioAnalyzer`

A hybrid, production-grade speaker detection system combining:

- **SSRC-based audio level extraction** (WebRTC native, low-cost)
- **Web Audio API RMS fallback** (for unsupported browsers)
- **Adaptive noise floor tracking** per participant
- **Score-based temporal smoothing** (decay + boost model)
- **Speaker switching logic** with:
  - cooldown window
  - dominance ratio (`PROMOTE_RATIO`)
  - hold duration to prevent jitter

Key design decisions:
- Avoids naive thresholding (which is unstable in real calls)
- Uses **continuous scoring instead of binary detection**
- Maintains **O(N) per tick with minimal allocations**

---

### Intelligent Audio Recording & Noise Gating — `useRecording`

Custom audio capture pipeline with built-in speech filtering:

- RMS-based audio level detection
- Exponential smoothing for stable signal tracking
- Noise gate with configurable hold duration
- Speech activity accumulation (`totalSpeechMs`)

Key Features:
- Filters out silence and background noise in real-time
- Prevents unnecessary audio uploads
- Reduces bandwidth and processing overhead
- Captures only meaningful speech segments

**Speech Activity Qualification:**
- Tracks cumulative speech duration per participant
- Enforces minimum speech threshold (`SPEECH_MIN_ACTIVE_MS`)
- Discards recordings with insufficient speech

> Implements a lightweight Voice Activity Detection (VAD) system directly in the browser using Web Audio API, avoiding server-side filtering costs.

> Thresholds (RMS ~0.008, hold ~1500ms, speech ~800ms) were empirically tuned for conversational speech.

---

### Media Control System — `mediaController`

Handles browser-specific media inconsistencies (notably Safari/WebKit) and track lifecycle edge cases without renegotiation.

- Seamless **track replacement across all peer connections**
- Safari-specific handling (preview refresh, mic re-acquisition)
- **Placeholder video tracks** to maintain connection stability
- Safe fallback strategies:
  - sender → transceiver → addTrack hierarchy
- Prevents:
  - renegotiation storms
  - broken streams on toggle
  - track desync across peers

> WebRTC track replacement is unreliable across browsers — this system ensures consistency without full renegotiation.

---

### Media State Orchestration — `useMediaControls`

Coordinates UI + media + network state:

- Syncs:
  - local stream
  - peer connections
  - analyzers
  - recording pipelines
- Handles:
  - mute/unmute with analyzer reset
  - video toggle with emotion pipeline control
  - screen sharing with track replacement
- Ensures **state consistency across multiple subsystems**

> Media actions are not local — they must propagate across WebRTC, analytics, and backend systems simultaneously.

---

## Infrastructure & Deployment

```
AWS EC2
|
+-- Nginx (port 80 / 443)
|   +-- upstream backend {
|         server 127.0.0.1:8000;
|         server 127.0.0.1:8001;
|         server 127.0.0.1:8002;
|       }
|
+-- PM2
|   +-- meet-8000   (Node.js backend, PORT=8000)
|   +-- meet-8001   (Node.js backend, PORT=8001)
|   +-- meet-8002   (Node.js backend, PORT=8002)
|   +-- emotion     (uvicorn app:app --port 5002)
|   +-- transcript  (uvicorn app:app --port 5001)
|
+-- Redis (localhost:6379)
|   +-- Socket.IO pub/sub adapter (pub + sub clients)
|   +-- Meeting state and participant maps
|   +-- Rate limiters and account locks
|   +-- Transcript and user profile cache
|
+-- MongoDB Atlas (external, replica set)
    +-- meetings    (participants, chat, analytics, hostSecretHash)
    +-- transcripts (text, metadata/segments, ownerId)
    +-- userdbs     (username, bcrypt password hash)

Render
+-- Frontend SPA (React, static build)
    +-- REACT_APP_SERVER_URL --> EC2 public IP / domain
```

### PM2 Configuration Details

- `max_memory_restart: 512M` — automatic restart on OOM
- `exp_backoff_restart_delay: 100ms` — exponential backoff on crash loops
- `merge_logs: true` with `time: true` — timestamped unified log stream
- `watch: false` — production mode, no file watching

### Why 3 Explicit PM2 Instances Instead of Node.js Cluster Mode?

PM2 cluster mode uses Node's built-in `cluster` fork sharing a single port via IPC round-robin. This is opaque to Nginx and limits per-process control. Running three explicit instances on distinct ports gives Nginx full visibility — health checks per upstream, connection counts, least-connections routing — and lets each instance be restarted or redeployed independently without interrupting the others. Redis ensures state is shared across all three.

### TURN/STUN

Metered.ca relay servers handle NAT traversal for restricted corporate networks. Google STUN handles standard symmetric NAT. ICE restart is triggered automatically on `iceConnectionState === "failed"`.

---

## Reliability & Fault Tolerance

SkyMeetAI is designed to remain stable under unreliable networks, partial service failures, and high-frequency real-time streams.

- **Automatic reconnection:** Client-facing Socket.IO connections use infinite retry. The backend's internal proxy connection to the Emotion Service retries up to 5 times (configurable via `emotionClients.reconnectionAttempts`).
- **Graceful degradation:** If Emotion Service is unavailable, core meeting features (WebRTC, chat) continue uninterrupted
- **Idempotent messaging:** Chat and signaling events use stable IDs and deduplication to prevent duplication during retries
- **Backpressure control:** Real-time emotion pipeline uses a single-slot overwrite buffer to ensure constant memory and bounded latency
- **Distributed locking:** Redis-based locks prevent race conditions during concurrent room joins and reconnections
- **Client-side validation:** Incoming emotion payloads are schema-normalized and filtered by confidence threshold before rendering
- **Duplicate suppression:** Messages and events are deduplicated using stable identifiers across reconnects and history replays
- **Automated cleanup:** Periodic removal of inactive meetings using activity timestamps and TTL logic
- **Fail-safe media pipeline:** Errors in recording and analysis are caught intentionally to prevent UI disruption — a deliberate design decision to preserve meeting continuity over analytics completeness

---

## Key Engineering Decisions

**Why P2P WebRTC mesh instead of SFU?**
This design prioritizes low-latency peer-to-peer communication and minimal infrastructure complexity. It is well-suited for small group meetings (typically 4–6 participants). For larger rooms, an SFU architecture (e.g., mediasoup) would be introduced. This intentionally trades scalability for simplicity and low latency.

**Why reuse the signaling Socket.IO connection for chat?**
Opening a separate WebSocket for chat would double connection overhead with no benefit. The signaling socket is already persistent, authenticated, and scoped to the meeting room. Chat messages are simply multiplexed as additional event types on the same connection, with the Redis pub/sub adapter ensuring cross-instance delivery just as it does for signaling events.

**Why chunked socket upload instead of HTTP multipart for emotion?**
HTTP multipart requires the full file buffered before the request resolves. Chunked socket upload with sequence numbers enables streaming with per-chunk acknowledgment, retry of individual lost chunks, and progress tracking. The server writes chunk files to disk as they arrive and assembles in-order on completion. The assembled file is deleted immediately after inference.

**Why Redis pub/sub adapter for Socket.IO?**
Without it, a socket event emitted on instance A (`io.to(hostSocketId).emit(...)`) would silently fail if the host is connected to instance B. The Redis adapter publishes the event to a channel that all instances subscribe to — any instance holding a matching socket delivers it. This makes the signaling layer horizontally scalable without sticky sessions.

**Why drop-oldest frames in the emotion pump?**
Emotion analysis reflects current state, not history. A frame that arrived 800ms ago carries less value than the one that just arrived. Under high frame rates, queuing creates unbounded latency growth. The single-slot overwrite strategy ensures inference always runs on the freshest frame, keeping end-to-end latency bounded at approximately one inference cycle regardless of send rate.

**Why distributed lock on room join?**
Without a lock, two sockets joining simultaneously both read an empty participants map from Redis, both append themselves, and write back — one write wins, the other is silently lost. The Lua CAS script on the lock key serializes all join operations per room code without blocking unrelated rooms.

**Why IsolationForest for anomaly detection?**
The training set is clean studio recordings. In production, users send noisy real-world webcam video — low light, motion blur, partial occlusion. IsolationForest flags out-of-distribution inputs in the learned feature space without requiring labeled anomaly data. It adds approximately 1ms overhead and runs before the ensemble.

**Why idempotent messaging and deduplication?**
Real-world networks are unreliable — messages may be retried, duplicated, or delivered out of order. By assigning stable IDs and enforcing deduplication at the client, the system guarantees consistency without requiring exactly-once delivery semantics.