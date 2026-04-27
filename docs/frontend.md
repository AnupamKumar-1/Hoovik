# Frontend

React 18 SPA hosted on Render. All stateful logic is encapsulated in custom hooks with zero business logic in components.

---

## Hooks

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

---

## Pages

### `LandingPage`

Marketing landing page. Shows a hero section with a mock live meeting preview card, feature stats, and CTA buttons routing to `/auth`. No state beyond navigation.

### `Authentication`

Login / register page with a tab toggle. Calls `handleLogin` or `handleRegister` from `AuthContext`. On successful login, stores the JWT in `localStorage` and navigates to `/home`. Shows inline error messages and a success snackbar on registration.

### `Home`

Main dashboard after login. Provides:

- **Create a room** — calls `POST /api/v1/rooms`, stores `hostSecret` in `localStorage`, navigates to `/room/:code`
- **Join a room** — validates room existence via `GET /api/v1/rooms/:code` then navigates
- **Recent transcripts** — fetches from `GET /api/v1/transcripts`, deduplicated by `meetingCode`, paginated at 5 per page, expandable per item with per-segment emotion labels and `.txt` download. Session-cached with 2-minute TTL. Refreshes on window focus.

### `History`

Meeting history page. Fetches via `getHistoryOfUser`, merges server results with `localStorage` fallback (`meeting_history_v1`), normalizes and deduplicates, filters to only meetings where the current user participated. Shows expandable participant tiles with host/you badges.

### `VideoMeet`

Core meeting room. Composes all hooks and subcomponents. Manages:

- Remote stream map (keyed by peer socket ID)
- Spotlight + filmstrip layout (active speaker or manually pinned)
- Stable speaker detection (2s debounce on `activeSpeakerId`)
- Chat panel (desktop side panel / mobile sheet)
- Emotion panel (host only, desktop)
- Mobile sheet (`MobilePanelSheet`) for chat and emotion tabs
- Keyboard shortcuts: `M` mute, `V` video, `C` chat
- Unread message badge (resets on panel open)

---

## Components

### `MeetTopBar`

Displays room code, live/connecting status pill (animated with Framer Motion), elapsed timer (`MM:SS` / `HH:MM:SS`), participant count, and host badge.

### `MeetControlBar`

Bottom toolbar with grouped buttons: mute, video, screen share, chat (with unread badge), emotion AI toggle (host only), and leave/end. Uses `aria-pressed` and `aria-label` throughout.

### `MeetLocalPreview`

Draggable floating tile for the local video feed. Tap to reveal inline controls (mute, video, emotion toggle). Shows status badges (muted, camera off) when controls are hidden. Speaking ring animates when `isSpeaking` is true.

### `ParticipantCard`

Remote participant tile used in the filmstrip. Shows live video or avatar fallback, name pill, speaking indicator, and an optional emotion badge. Accepts `compact` prop for filmstrip sizing. Click handler pins the participant to spotlight. Wrapped in `React.memo`.

### `SpotlightCard`

Large spotlight tile for the active/pinned participant. Same video/avatar logic as `ParticipantCard` but full-size with a 400ms debounce on the speaking ring to prevent jitter. Uses `useVideoStream` from `videoShared`.

### `MeetChatPanel`

Desktop chat side panel (Framer Motion slide-in from right). Renders message bubbles with pending/sent/failed delivery status, retry on failed, and auto-scroll to bottom when already near the bottom. Uses `ChatInput` for sending.

### `MobilePanelSheet`

Bottom sheet for mobile. Supports touch-drag-to-dismiss (72px threshold). Renders either a single header (chat or emotion) or a tab bar when both are available. Contains `ChatTab` and `EmotionTab` as internal components.

### `ChatInput`

Controlled text input. `Enter` sends, `Shift+Enter` newlines. Focus restored via `requestAnimationFrame` after send. `maxLength={1000}` enforced at input level.

### `EmotionServicePanel`

Desktop sidebar panel (host only). Shows `EmotionAIInsight` at the top, per-participant `EmotionParticipantCard` rows, and `EmotionGroupSummary` when more than one participant has data.

### `EmotionParticipantCard`

Per-participant emotion card. Shows avatar, name, sample count, top-emotion pill, top-3 emotion bar chart (weighted by cumulative score), and a trend sparkline (last 8 samples).

### `EmotionGroupSummary`

Aggregates emotion counts across all participants over a 30-second rolling window. Shows top-4 emotion bars and a trend string (e.g. "Group mood shifting from neutral to happy") derived by comparing the current dominant emotion against the previous render.

### `EmotionAIInsight`

Rule-based insight generator. Evaluates the last 30 seconds of emotion history per participant and produces a single natural-language insight string — e.g. highlights sustained negative signals, positive group engagement, or mixed dynamics.

---

## Utilities

### `videoShared`

Shared helpers and hooks used by both `ParticipantCard` and `SpotlightCard`:

- `useVideoStream` — attaches a `MediaStream` to a video element, runs a hard-reset polling loop (`MAX_RESET_ATTEMPTS=8`, `RESET_CHECK_MS=300ms`) to recover stalled video, and handles track lifecycle events (`unmute`, `ended`, `mute`, `addtrack`, `removetrack`). Reattaches on `visibilitychange`.
- `getAvatarColor` — deterministic gradient + glow from initial character
- `deriveName` — resolves display name from `meta`, `emotion`, or peer ID fallback
- `hasLiveVideoTrack`, `safePlay` — video element helpers
- `WAVE_DELAYS`, `AVATAR_PALETTES` — animation and color constants

### `emotionHelpers`

Emotion normalization and display utilities:

- `formatTopEmotion(emotion)` — normalizes any emotion payload shape (string, array, `{label, score}`, `{probs}`) into `{ label, score }`
- `getTopEmotionLabel(emotion)` — returns the normalized label string, filtered by `EMOTION_DISPLAY_MIN_SCORE = 0.12`
- `renderEmojiLabelForEmotion(emotion)` — returns formatted string like `😊 Happy (74%)`
- `EMOJI_MAP` — maps emotion labels to emoji
- `VALID_EMOTIONS` — canonical label list

### `meetConfig`

Centralized environment-derived constants:

- `SOCKET_SERVER_URL` — signaling backend URL
- `TRANSCRIPT_ENDPOINT` — transcript service URL (null if `TRANSCRIPTS_ENABLED=false`)
- `API_BASE` — REST API base URL
- `ICE_CONFIG` — Google STUN + Metered.ca TURN relay configuration
- `EMO_CONFIG` — `captureIntervalMs: 3000`

### `mediaController`

Singleton module managing the local media stream lifecycle. Handles audio/video toggle, Safari-specific quirks, placeholder video tracks, and track replacement across all peer connections. Exposes:

- `toggleAudio(currentMuted)` — stops/re-acquires mic, replaces track in all peers
- `toggleVideo(currentVideoOff)` — stops/re-acquires camera, injects placeholder track when video is off to keep peer connections stable
- `initMediaController`, `resetMediaController`, `setLocalStream`, `setVideoElement`, `setPeerConnections`, `setSocketRef`
- `setExternalCleaners` — registers refs for recorders, audio context, and analyzer cleanup

### `mediaControllerUtils`

Low-level browser media utilities used by `mediaController`:

- `replaceTrackInPeers` — cascading fallback: sender → transceiver → new transceiver → `addTrack`
- `createPlaceholderVideoTrack` — 16×12 black canvas stream, marks track as `__isPlaceholder`
- `syncPreview`, `refreshSafariPreview` — preview element attachment with Safari-specific null/reattach cycle
- `attachTrackEndHandler` — emits `update-participant-state` when a track ends unexpectedly
- `isSafari`, `safePlay`, `enforceVideoMirrorBehavior` — browser detection and video helpers

### `withAuth`

HOC that checks `localStorage` for a valid JWT on mount. Redirects to `/auth` if absent. Returns `null` during the check to avoid flash-of-unauthenticated-content.

### `AuthContext` / `AuthProvider`

React context providing auth state and user data. Key behaviors:

- On mount: calls `GET /api/v1/users/me` to hydrate `userData`; falls back to JWT decode (`decodeTokenUser`) on network errors; removes token on 401
- Axios interceptors: attach `Authorization` header on every request; call `logout` on 401 responses
- `handleLogin` — stores JWT, sets `userData`, navigates to `/home`
- `getHistoryOfUser` — tries `GET /users/get_all_activity`, falls back to `localStorage` (`meeting_history_v1`)
- `addToUserHistory` — cascading POST attempts (`/meetings` → `/users/meetings` → `/add_to_activity`) with `localStorage` fallback, deduplicates by `meetingCode`, caps at 200 entries
- `logout` — calls server-side logout, clears token, navigates to `/auth`