# Reliability

SkyMeetAI is designed as a latency-sensitive distributed system that must remain stable under unreliable networks, partial service failures, and high-frequency real-time streams. Reliability is achieved through idempotent operations, bounded resource usage, reconnection strategies, and strict separation between real-time and batch pipelines.

---

## Reliability Principles

- **Bounded latency over completeness** — prioritize fresh data, drop stale work
- **Fail-soft architecture** — core meeting continues even if subsystems fail
- **Idempotent operations** — safe retries without duplication
- **Stateless compute services** — easier recovery and horizontal scaling
- **Separation of real-time and batch pipelines**
- **Distributed coordination with strong consistency where required**

---

## System Resilience Overview

| Layer | Strategy |
|------|--------|
| Client | Auto-reconnect, retry logic, optimistic UI |
| Backend (Node.js) | Stateless, horizontally scaled, Redis-backed |
| Emotion Service | Overwrite buffer, rate-limited inference |
| Transcript Service | Retry-safe batch processing |
| Data Layer | MongoDB upserts, Redis ephemeral state |

---

## Connection Reliability

### WebRTC (Media Layer)

- Direct peer-to-peer connections (no server dependency after setup)
- ICE restart triggered automatically on:
  - `iceConnectionState === "failed"`
- TURN fallback for restrictive NAT environments

**Impact:**
- Media continues even if backend is degraded
- Network fluctuations handled at protocol level

---

### Socket.IO (Signaling + Chat)

- Automatic reconnection with infinite retry (client-side)
- Session restoration logic:
  - Rejoin room
  - Restore participants
  - Replay chat history

**Failure Handling:**
- Temporary disconnect → seamless recovery
- No permanent session loss on network drop

---

## Reconnection & State Recovery

### Participant Restoration

On reconnect:

- Identify participant via:
  - `userId` OR
  - `name + recent activity window (~5 min)`
- Restore using:
  - `restoreParticipant()` (MongoDB-backed state machine)

### Guarantees

- No duplicate participants
- State continuity across reconnects
- Join/leave timestamps preserved

---

## Idempotency & Deduplication

### Chat System

- Each message has a **stable ID**
- Retries reuse same ID
- Client deduplicates via `seenMsgIdsRef`

**Result:**
- No duplicate messages
- Safe retry under packet loss

---

### Backend Operations

- Transcript writes use **MongoDB upsert (meetingCode)**
- Chunk uploads tracked via sequence numbers
- Duplicate submissions safely ignored

---

## Backpressure & Load Control

### Emotion Pipeline (Critical Reliability Mechanism)

- **Single-slot overwrite buffer**
  - New frames overwrite old frames
  - No queue buildup
- **Frame skipping (7×)**
- **Minimum inference interval (350 ms)**

**Properties:**

| Property | Outcome |
|---------|--------|
| O(1) memory | No memory growth |
| No queue | No latency accumulation |
| Freshest frame only | Stable real-time behavior |

---

### Why This Matters

Queue-based systems fail under load due to:
- Increasing latency
- Memory buildup
- Eventual crashes

SkyMeetAI avoids this entirely by design.

---

## Fault Tolerance

### Graceful Degradation

If **Emotion Service fails**:
- WebRTC (video/audio) continues
- Chat continues
- Meeting is unaffected

If **Transcript Service fails**:
- Meeting completes normally
- Transcript retry can occur later

---

### Retry Strategies

| Component | Strategy |
|----------|---------|
| Chat | ACK timeout + retry |
| Socket.IO | Automatic reconnect |
| Emotion proxy (Node) | Limited retries |
| Transcript submission | Retry on failure |

---

## Distributed Consistency

### Redis Coordination

Used for:
- Room state
- Participant tracking
- Rate limiting
- Distributed locks

### Critical Mechanism: Distributed Lock

- Lua CAS script ensures:
  - Atomic room join
  - No race conditions
  - Consistent participant list

---

## Data Consistency Model

### Real-Time Layer

- **Eventually consistent**
- Prioritizes latency over strict ordering
- Tolerates:
  - Out-of-order events
  - Temporary inconsistencies

### Post-Processing Layer (Transcripts)

- Stronger consistency guarantees:
  - Validated writes
  - Upsert-based deduplication
  - Retry-safe processing

---

## Failure Scenarios & Handling

### 1. Client Network Drop

- Socket reconnects automatically
- Participant restored
- Chat history replayed
- Media renegotiated if needed

---

### 2. Emotion Service Down

- Frames fail silently or fallback
- No UI crash
- Core meeting unaffected

---

### 3. Backend Instance Crash

- Nginx reroutes to other instances
- Redis ensures shared state
- No session loss

---

### 4. Duplicate Events

- Deduplication via IDs
- Idempotent handlers prevent corruption

---

### 5. High Frame Rate Input

- Frames dropped via overwrite buffer
- Latency remains constant
- System remains stable

---

## Resource Management

### Memory Safety

- No unbounded queues
- Fixed-size buffers:
  - Emotion: 1 frame + 8-frame sequence
  - Chat: max 500 messages

---

### CPU Protection

- Frame skipping reduces load
- Inference rate-limited
- No batching → avoids spikes

---

## Horizontal Scalability

### Backend (Node.js)

- 3 PM2 instances behind Nginx
- Stateless design
- Redis pub/sub for cross-instance sync

### Guarantees

- No sticky sessions required
- Any instance can serve any request
- Failure of one instance does not affect others

---

## Cleanup & Lifecycle Management

- Inactive meetings removed via TTL logic
- Participant states updated on disconnect
- Temporary data (emotion frames, chunk files) cleaned after use

---

## Observability (Current)

- High-resolution timers:
  - `time.perf_counter`
  - `process.hrtime`
- Stage-level latency tracking:
  - decode
  - feature extraction
  - inference

---

## Known Limitations

- No global distributed tracing (e.g., OpenTelemetry)
- No circuit breaker pattern
- Limited retry strategies for some services
- No autoscaling (manual EC2 scaling)
- No SLA guarantees

---

## Summary

SkyMeetAI achieves reliability through:

- Idempotent and retry-safe operations
- Automatic reconnection and state restoration
- Distributed coordination via Redis
- Backpressure-resistant streaming (overwrite buffer)
- Graceful degradation under partial failure
- Separation of real-time and batch pipelines

The system is designed to **remain stable under real-world conditions**, including network instability, partial outages, and high-frequency data streams, while maintaining bounded latency and consistent behavior.