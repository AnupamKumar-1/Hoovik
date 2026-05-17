import React, { useEffect, useState, useContext, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import "../styles/home.css";
import { AuthContext } from "../contexts/AuthContext";
import { TRANSCRIPTS_ENABLED } from "../environment";
import TranscriptViewer from "./TranscriptViewer";

const SERVER_BASE = process.env.REACT_APP_SERVER_URL || "http://localhost:8000";
const API_BASE = process.env.REACT_APP_API_URL || `${SERVER_BASE}/api/v1`;

const TRANSCRIPT_CACHE_KEY = "tx_cache";
const TRANSCRIPT_CACHE_TTL = 2 * 60 * 1000;
const TRANSCRIPTS_PER_PAGE = 5;
const PENDING_TRANSCRIPT_KEY = "pending_transcript_code";

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    Object.assign(textarea.style, { position: "fixed", opacity: 0 });
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return true;
    } catch {
      document.body.removeChild(textarea);
      return false;
    }
  }
}

async function createRoomAndGetLink(name) {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/rooms`, {
    method: "POST",
    headers,
    body: JSON.stringify({ hostName: name.trim() }),
  });

  if (!res.ok) throw new Error("Failed to create room");

  const { roomCode, hostSecret } = await res.json();
  const code = roomCode.toUpperCase();
  const link = `${window.location.origin}/room/${code}`;

  if (!hostSecret) {
    throw new Error("Server did not return a hostSecret");
  }

  localStorage.setItem("displayName", name.trim());
  localStorage.setItem(
    `host:${code}`,
    JSON.stringify({
      hostName: name.trim(),
      hostSecret,
      meetingCode: code,
      createdAt: new Date().toISOString(),
    })
  );

  return { code, link };
}

function getTranscriptKey(item, index) {
  const id = item._id || item.id || "";
  const code = (item.meetingCode || "local").toString();
  const ts = item.createdAt ? String(new Date(item.createdAt).getTime()) : String(index);
  return `${code}__${id || ts}`;
}

function dedupeByCode(arr) {
  const map = new Map();
  for (const it of arr) {
    const code = (it.meetingCode || "").toUpperCase();
    if (!code) continue;
    const existing = map.get(code);
    if (!existing) {
      map.set(code, it);
    } else {
      const existTs = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
      const itTs = it.createdAt ? new Date(it.createdAt).getTime() : 0;
      if (itTs > existTs) map.set(code, it);
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const aTs = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTs = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTs - aTs;
  });
}

function normalizeTranscript(t) {
  const code = (t.meetingCode || t.meeting_code || "").toString().toUpperCase().trim();
  if (!code) return null;
  return {
    _id: t._id || t.id || null,
    meetingCode: code,
    transcriptText: t.transcriptText || t.transcript || t.metadata?.transcriptText || "",
    fileName: t.fileName || null,
    metadata: t.metadata || {},
    createdAt: t.createdAt ? new Date(t.createdAt) : null,
  };
}

function getCachedTranscripts() {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > TRANSCRIPT_CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function setCachedTranscripts(data) {
  try {
    sessionStorage.setItem(TRANSCRIPT_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { }
}

function cleanInvalidHosts() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith("host:"))
    .forEach((k) => {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (!v?.hostSecret) localStorage.removeItem(k);
      } catch {
        localStorage.removeItem(k);
      }
    });
}

function Snack({ msg, severity, open }) {
  return (
    <div className={`hm-snack hm-snack-${severity} ${open ? "hm-snack-show" : ""}`}>
      {severity === "success" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {severity === "error" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      )}
      <span>{msg}</span>
    </div>
  );
}

const EMOTION_COLORS = {
  joy: "#f59e0b", happy: "#f59e0b", sadness: "#60a5fa",
  anger: "#f87171", fear: "#a78bfa", surprise: "#34d399",
  disgust: "#fb923c", neutral: "#64748b",
};

function TranscriptItem({ t, onOpen }) {
  const segments = t.metadata?.segments ?? [];

  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];

  const emoCount = {};
  segments.forEach((s) => {
    const e = s.emotion?.toLowerCase() || "neutral";
    emoCount[e] = (emoCount[e] || 0) + 1;
  });
  const dominantEmo = Object.entries(emoCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const emoColor = dominantEmo ? (EMOTION_COLORS[dominantEmo] || "#64748b") : null;

  const lastSeg = segments.at(-1);
  const duration = lastSeg?.end > 0 ? Math.floor(lastSeg.end) : null;
  function fmtDur(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  const preview = segments.length > 0
    ? segments.map((s) => s.text).join(" ").slice(0, 140)
    : (t.transcriptText || "").trim().slice(0, 140);

  const dominantSpeaker = speakers[0] || null;

  return (
    <div
      className="hm-tx-item hm-tx-item-v2"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="hm-tx-v2-bar" style={{ background: emoColor || "rgba(56,189,248,0.4)" }} />

      <div className="hm-tx-v2-content">
        <div className="hm-tx-v2-top">
          <div className="hm-tx-v2-code">{t.meetingCode}</div>
          <div className="hm-tx-v2-meta">
            {duration !== null && <span className="hm-tx-v2-chip">{fmtDur(duration)}</span>}
            {segments.length > 0 && <span className="hm-tx-v2-chip">{segments.length} turns</span>}
            {dominantSpeaker && <span className="hm-tx-v2-chip">{dominantSpeaker}</span>}
          </div>
        </div>

        {preview && (
          <div className="hm-tx-v2-preview">
            {preview}{preview.length >= 140 ? "…" : ""}
          </div>
        )}

        <div className="hm-tx-v2-bottom">
          <span className="hm-tx-v2-date">
            {t.createdAt ? new Date(t.createdAt).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
            }) : "Unknown date"}
          </span>
          {dominantEmo && (
            <span className="hm-tx-v2-emo" style={{ color: emoColor, borderColor: emoColor + "44" }}>
              {dominantEmo}
            </span>
          )}
          <span className="hm-tx-v2-open">
            View transcript
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useContext(AuthContext);

  const [name, setName] = useState(localStorage.getItem("displayName") || "");
  const [room, setRoom] = useState("");
  const [transcripts, setTranscripts] = useState([]);
  const [txLoading, setTxLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(TRANSCRIPTS_PER_PAGE);
  const [snackOpen, setSnackOpen] = useState(false);
  const [snackMsg, setSnackMsg] = useState("");
  const [snackSeverity, setSnackSeverity] = useState("success");
  const [viewingTranscript, setViewingTranscript] = useState(null);

  const isFetchingRef = useRef(false);
  const prevCountRef = useRef(0);
  const pollTimerRef = useRef(null);
  const pollAttemptsRef = useRef(0);
  const txListRef = useRef(null);

  const loadTranscripts = useCallback(async (bustCache = false) => {
    if (!TRANSCRIPTS_ENABLED) return null;
    if (isFetchingRef.current) return null;

    if (!bustCache) {
      const cached = getCachedTranscripts();
      if (cached) {
        setTranscripts(cached);
        prevCountRef.current = cached.length;
        return cached;
      }
    } else {
      sessionStorage.removeItem(TRANSCRIPT_CACHE_KEY);
    }

    isFetchingRef.current = true;
    if (bustCache) setTxLoading(true);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_BASE}/transcripts?limit=200`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (data?.success) {
        const normalized = (data.transcripts || []).map(normalizeTranscript).filter(Boolean);
        const deduped = dedupeByCode(normalized);

        if (deduped.length > 0) setCachedTranscripts(deduped);

        const isNew = deduped.length > prevCountRef.current;
        if (bustCache && isNew) {
          showSnack(
            `${deduped.length - prevCountRef.current} new transcript${deduped.length - prevCountRef.current > 1 ? "s" : ""} available`,
            "success"
          );
          setVisibleCount(TRANSCRIPTS_PER_PAGE);
        }
        prevCountRef.current = deduped.length;
        setTranscripts(deduped);
        return deduped;
      }
    } catch (err) {
      console.error("loadTranscripts error:", err);
    } finally {
      isFetchingRef.current = false;
      setTxLoading(false);
    }
    return null;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAttemptsRef.current = 0;
    localStorage.removeItem(PENDING_TRANSCRIPT_KEY);
  }, []);

  const startPollingForTranscript = useCallback((meetingCode, maxAttempts = 12, intervalMs = 5000) => {
    if (pollTimerRef.current) return;
    stopPolling();
    pollAttemptsRef.current = 0;
    localStorage.setItem(PENDING_TRANSCRIPT_KEY, meetingCode);

    const poll = async () => {
      pollAttemptsRef.current++;
      const fresh = await loadTranscripts(true);

      if (fresh) {
        const found = fresh.find(
          (t) => t.meetingCode?.toUpperCase() === meetingCode?.toUpperCase()
        );
        if (found) {
          stopPolling();
          setViewingTranscript(found);
          showSnack("Transcript ready!", "success");
          return;
        }
      }

      if (pollAttemptsRef.current < maxAttempts) {
        pollTimerRef.current = setTimeout(poll, intervalMs);
      } else {
        stopPolling();
      }
    };

    pollTimerRef.current = setTimeout(poll, intervalMs);
  }, [loadTranscripts, stopPolling]);

  useEffect(() => {
    cleanInvalidHosts();
  }, []);

  useEffect(() => {
    loadTranscripts();
  }, [loadTranscripts]);

  useEffect(() => {
    const handleFocus = () => loadTranscripts(true);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [loadTranscripts]);

  useEffect(() => {
    const state = location.state;
    if (state?.meetingEnded && state?.meetingCode) {
      startPollingForTranscript(state.meetingCode, 30, 20000);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [location.state, startPollingForTranscript]);

  useEffect(() => {
    const pending = localStorage.getItem(PENDING_TRANSCRIPT_KEY);
    if (pending && TRANSCRIPTS_ENABLED) {
      startPollingForTranscript(pending, 30, 20000);
    }
  }, [startPollingForTranscript]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  useEffect(() => {
    const el = txListRef.current;
    if (!el || visibleCount <= TRANSCRIPTS_PER_PAGE) return;
    const fourthItem = el.children[3];
    if (fourthItem) {
      el.scrollTop = fourthItem.offsetTop - el.offsetTop;
    }
  }, [visibleCount]);

  function showSnack(message, severity = "success") {
    setSnackMsg(message);
    setSnackSeverity(severity);
    setSnackOpen(true);
    setTimeout(() => setSnackOpen(false), 3500);
  }

  function extractRoomCode(input) {
    let roomId = input.trim();
    try {
      const url = new URL(roomId);
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length) roomId = segs.pop();
    } catch { }
    return roomId.toUpperCase();
  }

  async function createRoom() {
    if (!name.trim()) { showSnack("Please enter your name first.", "error"); return; }
    try {
      const { code, link } = await createRoomAndGetLink(name);
      await copyToClipboard(link);
      setRoom(link);
      showSnack("Meeting created & link copied", "success");
      navigate(`/room/${code}`);
    } catch {
      showSnack("Unable to create room.", "error");
    }
  }

  async function copyLink() {
    if (!name.trim()) { showSnack("Enter your name before creating a link", "error"); return; }
    try {
      const { link } = await createRoomAndGetLink(name);
      const copied = await copyToClipboard(link);
      setRoom(link);
      showSnack(copied ? "Link copied to clipboard" : `Copy failed — link: ${link}`, copied ? "success" : "error");
    } catch {
      showSnack("Unable to create room link.", "error");
    }
  }

  async function joinRoom() {
    if (!room.trim()) { showSnack("Enter room code or link", "error"); return; }
    const roomId = extractRoomCode(room);
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}`);
      if (!res.ok) throw new Error("Room not found");
      localStorage.setItem("displayName", name.trim() || "Guest");
      navigate(`/room/${roomId}`);
    } catch {
      showSnack("Room does not exist or has expired.", "error");
    }
  }

  async function handleLogout() {
    try {
      if (logout) await logout(true);
      else { localStorage.removeItem("token"); navigate("/login"); }
    } catch { }
    try { localStorage.removeItem("displayName"); } catch { }
  }

  const displayInitial = (name || "?")[0].toUpperCase();
  const visibleTranscripts = transcripts.slice(0, visibleCount);
  const hasMore = visibleCount < transcripts.length;
  const hiddenCount = transcripts.length - visibleCount;

  return (
    <div className="hm-root">
      <div className="hm-bg" aria-hidden />

      <header className="hm-topbar">
        <div className="hm-brand" onClick={() => navigate("/")}>
          <div className="hm-brand-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
                stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="hm-brand-name">SkyMeetAI</span>
        </div>
        <div className="hm-topbar-right">
          <button className="hm-icon-btn" onClick={() => navigate("/history")} title="History" aria-label="Open history">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 3v5h5" /><path d="M21 12a9 9 0 1 1-9-9" /><path d="M12 7v6l4 2" />
            </svg>
          </button>
          <button className="hm-logout-btn" onClick={handleLogout} aria-label="Sign out">Sign out</button>
        </div>
      </header>

      <div className="hm-welcome">
        <div className="hm-welcome-avatar" aria-hidden>{displayInitial}</div>
        <div className="hm-welcome-text">
          <h2>Welcome back{name ? `, ${name.split(" ")[0]}` : ""}!</h2>
          <p>Ready to connect? Create or join a room below.</p>
        </div>
      </div>

      <div className="hm-grid">
        <div className="hm-left">
          <div className="hm-card">
            <div className="hm-card-header">
              <div>
                <div className="hm-card-title">Create a room</div>
                <div className="hm-card-sub">Host a new meeting instantly</div>
              </div>
            </div>
            <div className="hm-card-body">
              <div className="hm-field">
                <label htmlFor="hm-name">Your display name</label>
                <input id="hm-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anupam Kumar" />
              </div>
              <div className="hm-btn-row">
                <button className="hm-btn-p" onClick={createRoom}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                  </svg>
                  Start Meeting
                </button>
                <button className="hm-btn-g" onClick={copyLink}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                    <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  Create &amp; Copy Link
                </button>
              </div>
              <div className="hm-tip-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                </svg>
                <span>Allow camera &amp; microphone when prompted. Share your link to invite others.</span>
              </div>
            </div>
          </div>

          <div className="hm-card">
            <div className="hm-card-header">
              <div>
                <div className="hm-card-title">Join a room</div>
                <div className="hm-card-sub">Paste a code or full meeting link</div>
              </div>
            </div>
            <div className="hm-card-body">
              <div className="hm-field">
                <label htmlFor="hm-room">Room code or link</label>
                <input
                  id="hm-room" type="text" value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  placeholder="e.g. XKCD42 or https://…"
                  onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                />
              </div>
              <button className="hm-btn-full" onClick={joinRoom}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" />
                </svg>
                Join Room
              </button>
            </div>
          </div>
        </div>

        <div className="hm-card hm-transcripts">
          <div className="hm-card-header">
            <div>
              <div className="hm-card-title">Recent transcripts</div>
              <div className="hm-card-sub">From your hosted meetings</div>
            </div>
            <div className="hm-tx-header-actions">
              {transcripts.length > 0 && (
                <span className="hm-tx-badge">{transcripts.length} meeting{transcripts.length !== 1 ? "s" : ""}</span>
              )}
              <button
                className={`hm-tx-refresh-btn ${txLoading ? "hm-tx-refresh-spinning" : ""}`}
                onClick={() => loadTranscripts(true)}
                title="Refresh transcripts"
                aria-label="Refresh transcripts"
                disabled={txLoading}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                </svg>
              </button>
            </div>
          </div>

          <div className="hm-divider" />

          {!TRANSCRIPTS_ENABLED && (
            <div className="hm-tx-notice hm-tx-notice-warn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <p>Transcript service unavailable on this build.</p>
                <p className="hm-tx-notice-sub">Meetings still work — local recording runs in your browser.</p>
              </div>
            </div>
          )}

          {transcripts.length === 0 && TRANSCRIPTS_ENABLED && !txLoading && (
            <div className="hm-tx-empty">
              <div className="hm-tx-empty-icon" aria-hidden>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M9 12h6M9 16h6M7 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2" />
                  <path d="M15 2H9a1 1 0 00-1 1v2a1 1 0 001 1h6a1 1 0 001-1V3a1 1 0 00-1-1z" />
                </svg>
              </div>
              <p>No transcripts yet — host a meeting and end it to generate one.</p>
            </div>
          )}

          {txLoading && transcripts.length === 0 && (
            <div className="hm-tx-loading">
              <div className="hm-tx-loading-dots">
                <span /><span /><span />
              </div>
            </div>
          )}

          <div className="hm-tx-list" ref={txListRef}>
            {visibleTranscripts.map((t, i) => {
              const key = getTranscriptKey(t, i);
              return (
                <TranscriptItem
                  key={key}
                  t={t}
                  onOpen={() => setViewingTranscript(t)}
                />
              );
            })}
          </div>

          {(hasMore || visibleCount > TRANSCRIPTS_PER_PAGE) && (
            <div className="hm-tx-pagination">
              {hasMore && (
                <button
                  className="hm-tx-load-more"
                  onClick={() => setVisibleCount((v) => v + TRANSCRIPTS_PER_PAGE)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                  Show {Math.min(hiddenCount, TRANSCRIPTS_PER_PAGE)} more
                  <span className="hm-tx-remaining">({hiddenCount} remaining)</span>
                </button>
              )}
              {visibleCount > TRANSCRIPTS_PER_PAGE && (
                <button
                  className="hm-tx-collapse"
                  onClick={() => setVisibleCount(TRANSCRIPTS_PER_PAGE)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                  Collapse
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Snack msg={snackMsg} severity={snackSeverity} open={snackOpen} />

      {viewingTranscript && (
        <TranscriptViewer
          t={viewingTranscript}
          onClose={() => setViewingTranscript(null)}
        />
      )}
    </div>
  );
}