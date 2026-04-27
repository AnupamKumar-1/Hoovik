# Security

SkyMeetAI is designed as a distributed real-time system with security controls applied across authentication, transport, data handling, and real-time communication layers. The architecture prioritizes isolation, bounded resource usage, and failure-safe behavior under unreliable networks.

---

## Security Principles

- **Stateless backend** with centralized validation and persistence
- **Capability-based access control** for host-level operations
- **Least privilege** — compute services do not access the database directly
- **Bounded resource usage** — no unbounded queues or memory growth
- **Fail-safe design** — core meeting functionality continues under partial failure
- **Idempotent operations** — safe retries without duplication or corruption

---

## Authentication & Authorization

### JWT Authentication

- Used for all authenticated REST endpoints
- Passed via `Authorization: Bearer <token>`
- Expiry: **1 hour**
- Implemented using `passport-jwt`
- Attached automatically via Axios interceptors on the frontend

### Host Capability Model

Each meeting generates a **64-character host secret**:

- Only **SHA-256 hash** is stored in MongoDB
- Plaintext secret is returned once on room creation
- Verified per request without requiring login session

Used for:
- Transcript submission
- Transcript retrieval
- Host-only operations

**Benefits:**
- No persistent session required
- Prevents privilege escalation
- Works independently of JWT auth

---

## Rate Limiting & Abuse Protection

### Redis-Based Sliding Window Limits

| Surface | Limit |
|--------|------|
| Login attempts | Account lock after 10 failures (15 min lock) |
| Chat messages | 20 messages / 10 seconds per user |
| Chunk uploads | Rate-limited per user/session |

### Socket-Level Protections

- Event-level validation and normalization
- Payload size checks on incoming events
- Deduplication using stable message IDs
- Idempotent retries prevent duplication attacks

### Room Join Protection

- Redis **distributed lock (Lua CAS)** ensures:
  - No race conditions
  - No duplicate participants
  - Consistent room state under concurrency

---

## Input Validation & Sanitization

### Chat & User Input

- All user-generated content sanitized using `sanitize-html`
- Max length enforced:
  - Client: 1000 chars
  - Server: 2000 chars
- Prevents:
  - XSS attacks
  - Script injection
  - HTML injection

### File Uploads

- Enforced at:
  - Multer middleware level
  - Application validation layer
- Rejects oversized or malformed uploads

### Transcript Filtering

- Noise removal:
  - Minimum word threshold
  - Alpha ratio filtering
  - Repetition detection
- Prevents low-quality or adversarial transcript input

---

## Data Security

### Storage Model

| Data | Storage | Notes |
|------|--------|------|
| Passwords | MongoDB | bcrypt hashed |
| Host secrets | MongoDB | SHA-256 hashed |
| Chat messages | MongoDB | Sanitized |
| Transcripts | MongoDB | Filtered + structured |
| Emotion data | Not persisted | Ephemeral (real-time only) |

### Key Properties

- No plaintext secrets stored
- Emotion inference data is **not stored**
- Database writes only occur through Node.js backend
- Compute services (Emotion, Transcript) are **stateless**

---

## Transport & Network Security

### Communication Channels

- REST APIs over HTTP/HTTPS
- WebSockets (Socket.IO) for signaling and chat
- Direct WebRTC peer-to-peer media

### Properties

- Media flows **browser-to-browser** (server not in media path)
- Emotion frames sent directly to Emotion Service
- Optional proxy path via backend for restricted networks

### Production Expectations

- HTTPS/WSS enforced via Nginx (TLS termination)
- Secure headers recommended (e.g., Helmet)
- CORS restricted to frontend origin

---

## WebRTC Security Model

- Uses standard WebRTC security:
  - DTLS (encryption)
  - SRTP (secure media transport)
- No media passes through backend servers
- ICE with:
  - Google STUN (public NAT traversal)
  - Metered TURN (relay fallback)

**Note:**
TURN/STUN servers may see **IP metadata**, but not application-level data.

---

## Real-Time System Safety

### Idempotent Messaging

- All chat messages include stable IDs
- Deduplicated on client using `seenMsgIdsRef`
- Safe retry without duplication

### Backpressure Protection

- Emotion pipeline uses:
  - **Single-slot overwrite buffer**
  - No queue buildup
  - Constant memory (O(1))
- Prevents:
  - Memory exhaustion
  - Latency amplification attacks

### Rate-Controlled Inference

- Minimum inference interval enforced
- Frame skipping reduces compute load
- Protects against high-frequency input flooding

---

## Service Isolation

### Separation of Concerns

| Service | Responsibility | DB Access |
|--------|---------------|----------|
| Node.js Backend | Auth, validation, persistence | Yes |
| Emotion Service | Inference only | No |
| Transcript Service | ASR + NLP | No |

### Benefits

- Limits blast radius of compromise
- Prevents direct database exposure
- Ensures all writes go through validated backend

---

## Reliability as Security

- Automatic reconnection (Socket.IO)
- Retry-safe operations
- Graceful degradation if Emotion Service fails
- Distributed locking prevents state corruption
- Periodic cleanup of inactive meetings

---

## Data Privacy Model

- Emotion data:
  - Processed in real-time
  - Not persisted
  - Visible only during session

- Transcripts:
  - Persisted after meeting
  - Accessible via JWT or host secret

- Chat:
  - Persisted per meeting (bounded to 500 messages)

---

## External Exposure

- TURN/STUN servers handle NAT traversal
- External services may observe:
  - IP addresses
  - Connection metadata
- No media content is routed through backend infrastructure

---

## Known Limitations / Non-Goals

- No end-to-end encryption beyond standard WebRTC
- No fine-grained role-based access control (RBAC)
- No per-event authorization layer beyond room membership
- Emotion inference endpoint does not require explicit auth (scoped to active socket session)
- No advanced bot detection or CAPTCHA

---

## Threat Model (Simplified)

### Mitigated

- XSS via sanitization
- Replay/duplicate messages via idempotency
- Race conditions via Redis locks
- Brute-force login via rate limiting + lockout
- Memory exhaustion via overwrite buffer
- Injection via input filtering

### Not Fully Addressed

- Sophisticated DDoS attacks
- Malicious WebRTC peers
- Network-level interception without TLS
- Abuse of TURN relay infrastructure

---

## Summary

SkyMeetAI applies layered security across:

- Authentication (JWT + host capability)
- Input validation and sanitization
- Rate limiting and abuse protection
- Stateless service isolation
- Real-time backpressure control
- Secure media transport via WebRTC

The system prioritizes **consistency, bounded resource usage, and failure safety**, making it resilient under real-world network conditions while maintaining a strong baseline security posture.