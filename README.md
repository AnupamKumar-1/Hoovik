<div align="center">

<br/>

<img src="./frontend/public/logo.svg" width="88" alt="Hoovik Logo" />

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://readme-typing-svg.demolab.com?font=Syne&weight=800&size=52&pause=1000&color=FFFFFF&center=true&vCenter=true&width=400&height=70&lines=Hoovik" />
    <img src="https://readme-typing-svg.demolab.com?font=Syne&weight=800&size=52&pause=1000&color=0F0F0F&center=true&vCenter=true&width=400&height=70&lines=Hoovik" alt="Hoovik" />
  </picture>
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/WebRTC-Peer--to--Peer_Media-FF6B35?style=for-the-badge&logo=webrtc&logoColor=white" />
  &nbsp;
  <img src="https://img.shields.io/badge/Emotion_Analysis-Multimodal_Inference-7C3AED?style=for-the-badge&logo=pytorch&logoColor=white" />
  &nbsp;
  <img src="https://img.shields.io/badge/Real--Time-4_Microservices-0EA5E9?style=for-the-badge&logo=socketdotio&logoColor=white" />
</p>

<p align="center">
  <em>A distributed video meeting platform — WebRTC media, real-time multimodal emotion inference,<br/>in-meeting chat, and async transcript analysis across four independently deployed services.</em>
</p>

<br/>

<p align="center">
  <a href="https://github.com/AnupamKumar-1/Hoovik/actions/workflows/ci.yml">
    <img src="https://github.com/AnupamKumar-1/Hoovik/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  &nbsp;
  <a href="https://github.com/AnupamKumar-1/Hoovik/stargazers">
    <img src="https://img.shields.io/github/stars/AnupamKumar-1/Hoovik?style=social" alt="GitHub Stars" />
  </a>
  &nbsp;
  <img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" />
  &nbsp;
  <img src="https://img.shields.io/badge/PRs-Welcome-F59E0B?style=flat-square" />
</p>

<p align="center">If you find this project useful, a ⭐ goes a long way — thank you!</p>

<br/>

<a href="https://hoovik.onrender.com">
  <img src="https://img.shields.io/badge/%20Live%20Demo-hoovik.onrender.com-000000?style=for-the-badge&logoColor=white" alt="Live Demo" />
</a>

<br/><br/>

<table>
  <thead>
    <tr>
      <th align="center">Frontend</th>
      <th align="center">Backend (Node.js)</th>
      <th align="center">Emotion Service</th>
      <th align="center">Transcript Service</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=000" /></td>
      <td align="center"><img src="https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=000" /></td>
      <td align="center"><img src="https://img.shields.io/badge/Azure-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" /></td>
      <td align="center"><img src="https://img.shields.io/badge/Azure-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white" /></td>
    </tr>
  </tbody>
</table>

</div>

<br/>

![Hoovik demo](docs/src/Hoovik.gif)

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Key Technical Highlights](#key-technical-highlights)
- [Services Overview](#services-overview)
  - [Transports](#transports)
- [System Architecture](#system-architecture)
  - [State Map](#state-map)
- [End-to-End Runtime Flow](#end-to-end-runtime-flow)
- [Deployment Topology](#deployment-topology)
- [Configuration](#configuration)
  - [Frontend (`.env`)](#frontend-env)
  - [Backend (env vars)](#backend-env-vars)
  - [Emotion Service](#emotion-service)
  - [Transcript Service](#transcript-service)
- [Running the System](#running-the-system)
  - [Quick start](#quick-start)
  - [Step by step](#step-by-step)
- [API \& Event Contracts](#api--event-contracts)
  - [Backend REST](#backend-rest)
  - [Socket.IO — Client → Backend](#socketio--client--backend)
  - [Socket.IO — Backend → Client](#socketio--backend--client)
  - [Emotion Service — Socket.IO](#emotion-service--socketio)
- [Engineering Challenges](#engineering-challenges)
- [Known Limitations](#known-limitations)
- [Dataset](#dataset)
- [Contributing](#contributing)
- [License](#license)
- [Documentation](#documentation)

---

## Key Technical Highlights

| Area | What was built |
|---|---|
| **WebRTC signalling** | SDP/ICE relay over Socket.IO; Redis adapter fans events across 3 pm2 processes; distributed join lock (`SET NX PX 10000` + Lua CAS) serialises concurrent joins |
| **Multimodal emotion inference** | Per-participant: MediaPipe face landmarks + Wav2Vec2 audio → `EmotionTransformer` (PyTorch) + XGBoost → EMA smoothing + anomaly detection; server-side backpressure; live P50/P90/P95 at `GET /stats` |
| **Browser media pipeline** | `AudioWorklet` + `AnalyserNode` for RMS-gated noise detection; `MediaRecorder` per participant; JPEG frames from `<video>` at self-throttled rates; SSRC-based active speaker with RMS fallback |
| **Async transcript pipeline** | HTTP 202 immediately; background: ffmpeg → Whisper (`small`) → DistilRoBERTa per-segment emotion → speaker merge → HTTP POST callback to backend (3 retries, 5 s → 15 s → 30 s) |
| **Multi-process backend** | 3 pm2 instances unified by `@socket.io/redis-adapter`; all room state in Redis — no in-process state; participant map as Redis Hash (`HSET`/`HDEL` per event) |
| **Auth & rate limiting** | JWT + HttpOnly refresh token rotation; per-IP and per-username rate limiting via Redis Lua INCR+EXPIRE; account lockout after 10 failed logins; uniform `401` prevents username enumeration |
| **Chat** | Server-assigned timestamps; `chat-ack` delivery confirmation; 5,000 ms ACK timeout with user-initiated retry; capped at 500 messages |
| **Host verification** | `declare-host` verified server-side against `hostSecretHash` (SHA-256); `isHost` state set only after server ACK; `end-meeting` guard on `socket.data.isHost` |
| **AI summary** | `POST /transcripts/:id/summary` annotates Whisper segments with live facial/audio emotion per speaker; returns `discrepancies` array (NLP-vs-live mismatches); rate-limited 2× per 2 hours |
| **Redis test suite** | 25 tests: distributed cache, locks, rate limiting, pub/sub, batch ops, reconnection recovery; CI runs 20 via `npm run test:redis:ci` |

---

## Services Overview

| Service | Runtime | Role |
|---|---|---|
| **Frontend** | React SPA | UI, WebRTC, emotion capture, chat, transcript viewer |
| **Backend** | Node.js / Express + Socket.IO | Signalling, auth, room management, transcript storage |
| **Emotion Service** | Python / FastAPI + Socket.IO | Real-time multimodal emotion inference |
| **Transcript Service** | Python / FastAPI | Post-meeting ASR, per-segment emotion, callback delivery |

### Transports

| Transport | Between | Purpose |
|---|---|---|
| WebRTC | Browser ↔ Browser (via backend signalling) | Live audio/video — never proxied through backend |
| Socket.IO / WS | Frontend ↔ Backend | SDP/ICE relay, chat, participant state, room lifecycle |
| Socket.IO / WS | Frontend ↔ Emotion Service | `emotion.frame` (JPEG), `audio_chunk` (Float32 PCM), `emotion.result` |
| HTTP multipart POST | Frontend → Transcript Service | Audio blob upload after meeting ends |
| HTTP REST | Frontend ↔ Backend | Auth, rooms, transcripts, meeting history |

---

## System Architecture

```mermaid
graph TD
    Browser["Browser (React SPA)"]

    subgraph Backend ["Backend — Node.js (pm2: ports 8000–8002)"]
        SIO_B["Socket.IO · signalling · chat · room state"]
        REST["REST API · /api/v1/..."]
    end

    subgraph EmotionSvc ["Emotion Service — Python (port 5002)"]
        SIO_E["Socket.IO · per-participant inference"]
    end

    subgraph TranscriptSvc ["Transcript Service — Python (port 5001)"]
        HTTP_T["POST /process_meeting → HTTP 202"]
    end

    subgraph Persistence
        Mongo[("MongoDB")]
        Redis[("Redis · ephemeral + locks + pub/sub")]
    end

    Browser -- "WebRTC (peer-to-peer)" --> Browser
    Browser -- "Socket.IO" --> SIO_B
    Browser -- "REST" --> REST
    Browser -- "Socket.IO" --> SIO_E
    Browser -- "HTTP multipart" --> HTTP_T

    SIO_B --> Redis
    REST --> Mongo & Redis
    SIO_B --> Mongo
    HTTP_T -- "HTTP POST callback" --> REST
    Redis -- "pub/sub adapter" --> SIO_B
```

### State Map

| Store | What lives there |
|---|---|
| **MongoDB** | Users, rooms, meetings, chat history (cap: 500), transcripts, AI summaries |
| **Redis** | Participant maps (Hash), socket-ID arrays, join locks, rate limit counters, account lock flags, TTL caches |
| **In-process — Backend** | Nothing — all room state is in Redis |
| **In-process — Emotion Service** | Embedding buffers, EMA state, pump coroutine handles (not shared across instances) |
| **Browser localStorage** | JWT, `host:<code>` secret, `emotions:<code>` + `emotionNames:<code>` for AI summary |

---

## End-to-End Runtime Flow

```mermaid
sequenceDiagram
    participant FE as Browser
    participant BE as Backend
    participant RD as Redis
    participant MG as MongoDB
    participant EM as Emotion Service
    participant TS as Transcript Service

    Note over FE,BE: 1 — Auth & Room Creation
    FE->>BE: POST /users/login
    BE-->>FE: accessToken + HttpOnly refresh cookie
    FE->>BE: POST /rooms
    BE-->>FE: meetingCode + hostSecret (once only)
    FE->>BE: emit declare-host(meetingCode, hostSecret)
    BE-->>FE: ack {ok: true} — hostSecretHash verified

    Note over FE,RD: 2 — Join & Signalling
    FE->>BE: emit join-call(meetingCode, meta)
    BE->>RD: SET lock:room:<code> NX PX 10000
    BE->>MG: findMeetingByCode / addParticipant
    BE->>RD: HSET participant · setState
    BE-->>FE: existing-participants · assigned-role · chat-history
    BE-->>FE: broadcast user-joined
    RD-->>BE: DEL lock (Lua CAS)
    FE->>FE: RTCPeerConnection per peer
    FE->>BE: emit signal (SDP / ICE)
    BE-->>FE: signal → target (same-room verified)

    Note over FE,EM: 3 — Emotion Streaming (host only)
    loop every ~300–500 ms per participant
        FE->>EM: emotion.frame (JPEG 720×540)
        FE->>EM: audio_chunk (Float32 PCM 16 kHz)
        EM-->>FE: emotion.result {label, score, probs, anomaly}
        EM-->>FE: backpressure (if face queue ≥ 3)
    end

    Note over FE,BE: 4 — Chat
    FE->>BE: emit chat-message
    BE->>MG: addChatMessage (cap 500)
    BE-->>FE: broadcast chat-message + chat-ack
    Note over FE: marks failed after 5,000 ms with no ACK

    Note over FE,TS: 5 — End Meeting & Transcript
    FE->>BE: emit end-meeting (host only, isHost checked)
    FE->>TS: POST /process_meeting (audio blobs, x-host-secret)
    TS-->>FE: HTTP 202
    TS->>TS: ffmpeg → Whisper → DistilRoBERTa
    TS->>BE: POST /transcripts (3 retries on 5xx/network error)
    BE->>MG: upsert transcript
    BE->>RD: cache (TTL 300 s)
    loop poll every 20 s (max 30×)
        FE->>BE: GET /transcripts
    end
    FE->>BE: POST /transcripts/:id/summary (emotionData, emotionNames)
    BE-->>FE: summary + discrepancies[]
```

---

## Deployment Topology

```mermaid
graph TD
    FE["Frontend SPA (static / CDN)"]
    LB["Reverse Proxy — sticky sessions required"]

    subgraph PM2 ["Backend — pm2"]
        B0["hoovik-backend-8000"]
        B1["hoovik-backend-8001"]
        B2["hoovik-backend-8002"]
    end

    subgraph Python ["Python Services — uvicorn"]
        ES["Emotion Service :5002"]
        TS["Transcript Service :5001"]
    end

    subgraph Data
        Mongo[("MongoDB")]
        Redis[("Redis")]
    end

    FE --> LB --> B0 & B1 & B2
    FE --> ES
    FE --> TS
    B0 & B1 & B2 --> Mongo & Redis
    Redis -- "pub/sub" --> B0 & B1 & B2
    TS -- "HTTP callback" --> LB
```

| Service | Notes |
|---|---|
| **Backend (pm2)** | 3 instances on ports 8000–8002; 512 MiB `max_memory_restart`; exponential-backoff restart; `merge_logs: true` |
| **Emotion Service** | Single uvicorn process; in-process participant state — no horizontal scaling without Redis-backed externalisation |
| **Transcript Service** | Single uvicorn process; models loaded at startup; uploads deleted after 120 s |
| **MongoDB + Redis** | Both required at startup — connection failure → `process.exit(1)` |

> Docker / Kubernetes / cloud autoscaling not implemented.

---

## Configuration

### Frontend (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `REACT_APP_SIGNALING_URL` | `http://localhost:8000` | Backend Socket.IO + REST |
| `REACT_APP_EMOTION_SOCKET_URL` | *(required)* | Emotion service Socket.IO |
| `REACT_APP_TRANSCRIPT_URL` / `REACT_APP_AI_URL` | `http://localhost:5001/process_meeting` | Transcript endpoint |
| `REACT_APP_API_URL` | `http://localhost:8000/api/v1` | REST API base |
| `REACT_APP_TURN_URL_*` / `_USERNAME` / `_CREDENTIAL` | *(optional)* | TURN server config |
| `REACT_APP_NOISE_GATE_RMS` | `0.008` | Recording noise gate threshold |
| `REACT_APP_SPEECH_MIN_ACTIVE_MS` | `800` | Min speech for recording to count |

Feature flags: `TRANSCRIPTS_ENABLED`, `EMOTIONS_ENABLED`.

### Backend (env vars)

| Variable | Default | Notes |
|---|---|---|
| `MONGO_URI` | — | Required |
| `JWT_SECRET` | — | Required; exits if absent; warns if < 32 chars |
| `JWT_EXPIRES_IN` | `1h` | Access token lifetime + blacklist TTL |
| `REFRESH_TOKEN_TTL_SEC` | `604800` | 7 days |
| `REDIS_URL` | `redis://localhost:6379` | TLS enabled only for `rediss://` |
| `CLIENT_ORIGIN` | — | Production CORS origin + meeting link base |
| `Ts_SERVICE_URL` | — | Transcript proxy upstream |
| `MAX_PARTICIPANTS_PER_ROOM` | `50` | Per-room cap |
| `SOCKET_MAX_HTTP_BUFFER` | `104857600` | 100 MiB Socket.IO buffer |
| `ACCOUNT_LOCK_THRESHOLD` / `ACCOUNT_LOCK_SEC` | `10` / `900` | Failed login lockout |
| `AI_SUMMARY_RATE_LIMIT_MAX` / `_WIN_SEC` | `2` / `7200` | AI summary rate limit |

See [`docs/backend.md`](docs/backend.md) for the full table.

### Emotion Service

Config read from `emotion_service/config/config.json` (model paths, sequence length, EMA alpha). CORS currently `*` — restrict before external exposure.

### Transcript Service

| Variable | Default |
|---|---|
| `NODE_API` | `http://localhost:8000/api/v1/transcripts` |
| `ALLOWED_ORIGINS` | `""` |

---

## Running the System

### Quick start

```bash
npm install   # installs concurrently (one-time)
npm run dev   # starts all 4 services in parallel
```

| Prefix | Service | Command |
|---|---|---|
| `FRONTEND` | React SPA | `cd frontend && npm start` |
| `BACKEND` | Node.js | `cd backend && npm run dev` |
| `EMOTION` | FastAPI | `uvicorn app:app --app-dir emotion_service --port 5002` |
| `TRANSCRIPT` | FastAPI | `uvicorn app:app --app-dir transcript_service --port 5001` |

> Python venvs must exist at `emotion_service/venv` and `transcript_service/venv`. Start MongoDB and Redis first.

### Step by step

**1 — MongoDB + Redis**
```bash
mongod --dbpath /data/db
redis-server
```

**2 — Backend**
```bash
cd backend && npm install
pm2 start ecosystem.config.cjs          # production (3 processes)
PORT=8000 node src/app.js               # single-process dev
```

Redis tests:
```bash
npm run test:redis      # 25 tests (kills + restarts local Redis)
npm run test:redis:ci   # 20 tests (no recovery tests — safe for CI)
```

**3 — Emotion Service**
```bash
cd emotion_service && pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 5002
```
> `models/` must contain `best_modal.pt`, `xgb_model.joblib`, `weights.json`, and anomaly detectors.

**4 — Transcript Service**
```bash
cd transcript_service && pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 5001
```
> `ffmpeg` must be in `PATH` — validated at startup. Whisper + DistilRoBERTa downloaded from HuggingFace on first run.

**5 — Frontend**
```bash
cd frontend && npm install
npm start        # dev
npm run build    # production
```

---

## API & Event Contracts

### Backend REST

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/users/login` | None | Returns `{ accessToken, expiresIn, user }`; refresh token via HttpOnly cookie |
| `POST` | `/users/register` | None | `201` on success |
| `POST` | `/users/logout` | JWT | Blacklists access token; deletes refresh token; clears cookie |
| `POST` | `/users/refresh` | None | Rotates refresh token; returns new `accessToken` via HttpOnly cookie |
| `GET` | `/users/me` | JWT | `{ user: { _id, username, name } }` |
| `POST` | `/rooms` | Optional JWT | Returns `{ roomCode, hostSecret, owner }` |
| `GET` | `/rooms/mine` | JWT | Rooms owned by authenticated user |
| `GET` | `/rooms/:roomCode` | None | Room info if `active: true`; `404` otherwise |
| `POST` | `/transcripts` | Optional JWT | Body: `{ meetingCode, transcriptText, metadata? }`; requires `x-host-secret` or JWT |
| `GET` | `/transcripts` | Optional JWT | `{ transcripts }` — filtered by owner or host secret |
| `GET` | `/transcripts/:id` | Optional JWT | Single transcript by ObjectId or `meetingCode` |
| `POST` | `/transcripts/:id/summary` | Optional JWT | Body: `{ emotionData?, emotionNames? }`; generates Groq AI summary with discrepancies; rate-limited 2× / 2 h |

### Socket.IO — Client → Backend

| Event | Payload | Notes |
|---|---|---|
| `join-call` | `meetingCode, meta` | Acquires room lock; restores on reconnect |
| `declare-host` | `meetingCode, hostSecret, ack` | Verified against `hostSecretHash`; ack `{ok, reason?}` |
| `signal` | `targetId, message` | Target verified as same-room member before forwarding |
| `chat-message` | `meetingCode, msg, ack` | Rate-limited 20 msgs / 10 s per user |
| `update-participant-state` | `{ muted?, screen? }` | Broadcasts to room |
| `emotion-status` | `{ active: boolean }` | Host only — broadcasts to non-host sockets |
| `end-meeting` | `meetingCode` | Host only (`socket.data.isHost` checked); silent host leave |
| `leave-call` | `meetingCode` | Marks participant left |

### Socket.IO — Backend → Client

| Event | Payload |
|---|---|
| `existing-participants` | `Array<{ id, meta, polite }>` |
| `assigned-role` | `{ polite: boolean }` |
| `chat-history` | `Array<{ id, text, from, userId, name, ts }>` |
| `user-joined` / `user-left` | `{ id, meta, polite }` / `socketId` |
| `participants-updated` | `Array<{ id, meta }>` — debounced 150 ms |
| `chat-message` / `chat-ack` | `{ id, text, from, userId, name, ts }` |
| `signal` | `(fromSocketId, message)` |
| `emotion-status` | `{ active: boolean }` |
| `error` | `string` |

### Emotion Service — Socket.IO

| Direction | Event | Payload |
|---|---|---|
| Client → Service | `emotion.frame` | JPEG buffer ≤ 4 MB |
| Client → Service | `audio_chunk` | Float32 PCM 16 kHz ≤ 2 MB |
| Client → Service | `participant.media_state` | `{ participantId, micEnabled, cameraEnabled }` |
| Service → Client | `emotion.result` | `{ participantId, label, score, probs, anomaly }` |
| Service → Client | `backpressure` | face queue depth ≥ 3 — reduce frame rate |
| Service → Client | `server.status` | `targetFps` hint |

---

## Engineering Challenges

**1 — Multi-process Socket.IO fan-out** — `@socket.io/redis-adapter` uses Redis pub/sub to deliver events across all 3 pm2 instances. All room state lives in Redis so any process can serve any client. Sticky sessions at the load balancer are still required for the Socket.IO handshake.

**2 — Concurrent join races** — Without coordination, parallel joins produce lost updates. A Redis distributed lock (`SET NX PX 10000`, Lua CAS release) serialises participant state mutations within a 10-second window per room.

**3 — CPU-bound inference without blocking** — The emotion service runs PyTorch and MediaPipe inside per-participant async pump coroutines, offloading to a thread-pool executor. Backpressure events throttle the client when the face queue depth hits 3, preventing memory growth.

**4 — Async transcript delivery with no shared state** — Services share no DB or queue. The transcript service delivers via HTTP POST callback to the backend. The frontend polls every 20 s (up to 30 attempts) rather than waiting for a push — fully decoupled but eventually consistent.

**5 — Parallel media capture in the browser** — Host simultaneously plays WebRTC video, captures frames for emotion analysis, and records audio for transcription. Three separate tap points avoid interference: `captureStream()` for frames, cloned `MediaStream` + `AudioWorklet` for recording, standard `<video>` for playback.

**6 — Reconnect state gap** — Backend reconstructs participant records from Redis on reconnect. The emotion service holds per-participant inference state in process memory. The two stores are not reconciled — stale buffers may persist in the emotion service after a reconnect.

---

## Known Limitations

| Area | Limitation |
|---|---|
| **Inference scaling** | Emotion service in-process state cannot be horizontally scaled without externalising to Redis. Transcript service model singletons have the same constraint. |
| **Transcript delivery** | A crashed transcription process or empty merged-segment result causes silent data loss. Network/5xx failures are retried (3×) and the user is alerted on final failure. |
| **Cleanup timer** | `cleanupOldMeetings` runs in all 3 pm2 processes independently every hour — no distributed leader election. |
| **Transcription language** | Whisper hardcoded to `language="en"`. Multilingual meetings produce degraded output. |
| **Orchestration** | No unified supervisor across 4 services. Only the emotion service exposes `GET /health` and `GET /ready`. |
| **CORS** | Backend allows `localhost:3000` + one `CLIENT_ORIGIN`. Additional origins require a code change. |
| **Frontend — camera mute diff** | `cameraEnabled` always passed as `true` in remote mute sync; camera state is not tracked in the diff. |
| **Frontend — hot reload** | `_activeRooms` module-level `Set` persists across React hot-reloads in dev, which can suppress room re-entry. |
| **Chat history** | Capped at 500 messages; no archival or export. |

---

## Dataset

Training data for the `EmotionTransformer` + XGBoost ensemble — paired audio/video embedding sequences with ground-truth emotion labels.

**Download**: [dataset.npz — Google Drive](https://drive.google.com/file/d/135wYH7DB8_10Jc8g08MfC6Poews_Lkgp/view?usp=sharing)

Place under `emotion_service/` before running the training pipeline. See [`docs/emotion-service.md`](docs/emotion-service.md) for the full training procedure.

---

## Contributing

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for local setup, environment configuration, and contribution guidelines.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Documentation

| File | Contents |
|---|---|
| [`docs/frontend.md`](docs/frontend.md) | Hook architecture, WebRTC lifecycle, emotion pipeline, event contracts, error handling |
| [`docs/backend.md`](docs/backend.md) | Routes, Socket.IO handlers, Redis lock design, pm2 config, API contracts, security |
| [`docs/realTimeEmotionService.md`](docs/realTimeEmotionService.md) | Inference pipeline, model training, configuration schema, performance |
| [`docs/transcript_service.md`](docs/transcript_service.md) | ASR pipeline, segment merging, callback schema, error handling |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Setup guide, prerequisites, contribution workflow |