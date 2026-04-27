# Data Flow

## Room Creation and Join

```
1. POST /api/v1/rooms
   --> generates 8-char hex roomCode
   --> generates 64-char hostSecret, stores SHA-256 hash in MongoDB
   --> returns { roomCode, hostSecret } to client

2. Client: localStorage.set("host:{CODE}", { hostSecret, ... })

3. Socket.IO connect --> emit "join-call" (roomCode, { name, userId })
   --> server: acquireRedisLock(roomCode)
   --> getParticipants(code) from Redis
   --> if new participant: addParticipant() to MongoDB
   --> setState(code, [...socketIds]) in Redis
   --> releaseRedisLock(roomCode)

4. emit "existing-participants" --> client creates RTCPeerConnection per peer
5. emit "assigned-role" { polite: stateArr.indexOf(socketId) !== 0 }  [first joiner is impolite, all others are polite]

6. Peers exchange SDP offer/answer via "signal" events (Node.js relay)
7. ICE candidates exchanged, P2P connection established
8. Media flows directly browser-to-browser, server exits media path
```

---

## Real-Time Chat

```
1. User sends message --> useChat.sendChatMessage(text)
   --> Optimistically appends { status: "pending" } to local state
   --> socket.emit("chat-message", code, { id, text }, ackCallback)
   --> ACK timeout set (5s)

2. Server handleChatMessage:
   --> Redis rate limit check (20 msg / 10s per userId)
   --> sanitize-html on message text (max 2000 chars)
   --> persist to MongoDB: meeting.addChatMessage(chatMsg)
   --> socket.to("meeting:{code}").emit("chat-message", payload)   [other participants]
   --> socket.emit("chat-ack", payload)                             [sender confirmation]

3. Sender receives "chat-ack"
   --> message status updated to "delivered", ACK timeout cleared

4. On ACK timeout: message marked "failed", retry UI shown
   --> retryMessage(id) re-emits with original ID
   - Messages are idempotent: retries reuse the same message ID, ensuring safe re-delivery without duplication
   - Deduplication via `seenMsgIdsRef` ensures consistency across reconnects, retries, and history replay

5. New joiner: server emits "chat-history" (full persisted array)
   --> client deduplicates via seenMsgIdsRef before merging into state
```

---

## Real-Time Emotion Capture

```
1. Host toggles emotion AI --> startPeriodicEmotionCapture()
2. Every 3000ms for each remote participant:
   canvas.drawImage(remoteVideoElement) --> toBlob(jpeg, 0.82, 720x540)
   --> emotionSocket.emit("emotion.frame", { meetingId, participantId, buffer })

3. Emotion Service on_frame(sid, data):
   --> LATEST_FRAME[sid] = frame_bytes  (overwrites previous)
   --> if pump not running: create asyncio task _pump(sid)

4. _pump coroutine:
   --> pop LATEST_FRAME[sid]
   --> enforce MIN_INFERENCE_INTERVAL (350ms)
   --> apply FRAME_SKIP (1 of every 7 frames)
   --> run_in_executor: decode_frame (OpenCV)
   --> run_in_executor: extract_embedding (py-feat, 27-dim)
   --> EMBEDDING_BUFFER[sid].append(embedding)
   --> run_in_executor: run_inference (ensemble)
   --> smooth via EMA (alpha=0.7)
   --> confidence threshold check (0.5)
   --> sio.emit("emotion.result", { participantId, result, ts }, to=sid)

5. Emotion Service emits result directly back to the host's browser:
   --> sio.emit("emotion.result", { participantId, result, ts }, to=sid)
   --> received by useEmotionSocket on the host client

   (Proxy path only) If frames were sent via Node.js emotion.frame handler:
   --> Node.js receives emotion.result from Emotion Service
   --> io.to(hostSocketId).emit("emotion.result", { participantId, result, ts })

6. (Optional) If using proxy mode:
   --> Emotion results can be routed via Node.js using `/emotion-socket`
   --> used only in restricted networks or centralized routing scenarios

7. Host React client:
   --> setEmotionsMap(prev => ({ ...prev, [participantId]: [...prev, { label, score, ts }].slice(-20) }))
   --> EmotionServicePanel re-renders with updated bars and AI insight text
```

---

## Post-Meeting Transcript

```
1. Host ends meeting --> stopAllRecorders()
   --> MediaRecorder.stop() per participant
   --> chunks accumulated during call (noise-gated, 1s intervals)

2. Filter by hasSufficientSpeech (totalSpeechMs >= 800ms)

3. Background: POST transcript_service/process_meeting
   Headers: { x-host-secret, x-user-token }
   Body (multipart): audio blobs per participant + speaker_map JSON

4. Transcript Service:
   --> ffmpeg: WebM → 16kHz mono WAV per speaker
   --> whisper.transcribe(wav) → segments { start, end, text }
   --> discard segments with length < 3 characters
   --> emotion_pipeline(text) per segment (DistilRoBERTa)
   --> merge_segments: time-sort + speaker interleave
   --> construct structured transcript:{ speaker, start, end, text, emotion }

5. POST /api/v1/transcripts (Node.js)
   Payload: { meetingCode, transcriptText, metadata }
   Headers: { x-host-secret, Authorization }

   --> controller validation + auth check
   --> noise filtering:
       - minimum word threshold
       - alpha ratio filtering
       - repetition detection
   --> MongoDB upsert by meetingCode
   --> Redis cache invalidation

6. Home page on next focus:
   --> GET /api/v1/transcripts
   --> renders speaker timeline with per-segment emotion labels
```