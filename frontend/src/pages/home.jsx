import React, { useEffect, useState, useContext, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/home.css";
import { AuthContext } from "../contexts/AuthContext";
import { apiClient } from "../contexts/AuthContext";
import { TRANSCRIPTS_ENABLED } from "../environment";

const SERVER_BASE = process.env.REACT_APP_SERVER_URL || "http://localhost:8000";
const API_BASE = process.env.REACT_APP_API_URL || `${SERVER_BASE}/api/v1`;

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = 0;
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try { document.execCommand("copy"); }
    catch (err2) { document.body.removeChild(textarea); return false; }
    document.body.removeChild(textarea);
    return true;
  }
}

function getTranscriptKey(item, index) {
  const id = item._id || item.id || "";
  const code = (item.meeting_code || item.meetingCode || "local").toString();
  const ts = item.createdAt ? String(new Date(item.createdAt).getTime()) : String(index);
  return `${code}__${id || ts}`;
}

function dedupeByCodeKeepNewest(arr) {
  const map = new Map();
  for (const it of arr) {
    const codeRaw = (it.meeting_code || it.meetingCode || "").toString();
    const code = codeRaw
      ? codeRaw.toUpperCase()
      : `__NO_CODE__:${Math.random().toString(36).slice(2, 8)}`;
    const existing = map.get(code);
    if (!existing) {
      map.set(code, it);
    } else {
      const existingTs = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
      const itTs = it.createdAt ? new Date(it.createdAt).getTime() : 0;
      if (itTs > existingTs) map.set(code, it);
    }
  }
  return Array.from(map.values());
}

function mapTranscript(t) {
  const code = (t.meetingCode || t.meeting_code || "").toString().toUpperCase();
  if (!code) return null;
  return {
    _id: t._id || t.id || null,
    meeting_code: code,
    transcript: t.transcriptText ?? t.metadata?.transcriptText ?? "",
    createdAt: t.createdAt ? new Date(t.createdAt) : null,
    fileName: t.fileName || null,
    fromServer: true,
  };
}

/* ─── Snackbar ─── */
function Snack({ msg, severity, open }) {
  return (
    <div className={`hm-snack hm-snack-${severity} ${open ? "hm-snack-show" : ""}`}>
      {severity === "success" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
      )}
      {severity === "error" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      )}
      <span>{msg}</span>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { logout } = useContext(AuthContext);

  const [name, setName] = useState(localStorage.getItem("displayName") || "");
  const [room, setRoom] = useState("");
  const [recentLocal, setRecentLocal] = useState([]);
  const [expandedTranscripts, setExpandedTranscripts] = useState({});

  const [snackOpen, setSnackOpen] = useState(false);
  const [snackMsg, setSnackMsg] = useState("");
  const [snackSeverity, setSnackSeverity] = useState("success");
  const [serverHadTranscripts, setServerHadTranscripts] = useState(false);

  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;
    if (!TRANSCRIPTS_ENABLED) { setRecentLocal([]); setServerHadTranscripts(false); return; }

    (async () => {
      try {
        const token = localStorage.getItem("token");
        const hostKeys = Object.keys(localStorage).filter((k) => k.startsWith("host:"));
        const hostSecrets = hostKeys
          .map((k) => { try { return JSON.parse(localStorage.getItem(k))?.hostSecret ?? null; } catch { return null; } })
          .filter(Boolean);

        if (!token && hostSecrets.length === 0) return;

        let authItems = [], authHad = false;
        if (token) {
          try {
            const resp = await apiClient.get(`/transcript?limit=200`);
            const body = resp.data;
            if (body?.success) {
              const list = Array.isArray(body.transcripts) ? body.transcripts : body.transcript ? [body.transcript] : [];
              authHad = list.length > 0;
              authItems = list.map(mapTranscript).filter(Boolean);
            }
          } catch (err) { console.warn("Auth transcript failed:", err?.response?.status); }
        }

        let hostServerItems = [];
        for (const hostSecret of hostSecrets) {
          try {
            const resp = await apiClient.get(`/transcript?limit=200`, { headers: { "x-host-secret": hostSecret } });
            const body = resp.data;
            const list = Array.isArray(body?.transcripts) ? body.transcripts : body?.transcript ? [body.transcript] : [];
            if (list.length === 0) continue;
            hostServerItems = [...hostServerItems, ...list.map(mapTranscript).filter(Boolean)];
          } catch (err) { console.warn("Host transcript failed:", err?.response?.status); }
        }

        const mergedRaw = [...authItems, ...hostServerItems];
        setServerHadTranscripts(authHad || hostServerItems.length > 0);
        if (mergedRaw.length === 0) { setRecentLocal([]); return; }
        setRecentLocal(dedupeByCodeKeepNewest(mergedRaw));
      } catch (err) {
        console.warn("Transcript load failed:", err);
        setRecentLocal([]); setServerHadTranscripts(false);
      }
    })();
  }, []);

  function showSnack(message, severity = "success") {
    setSnackMsg(message); setSnackSeverity(severity); setSnackOpen(true);
    setTimeout(() => setSnackOpen(false), 3500);
  }

  function extractRoomFromInput(input) {
    let roomId = input.trim();
    try { const url = new URL(roomId); const segs = url.pathname.split("/").filter(Boolean); if (segs.length) roomId = segs.pop(); } catch { }
    return roomId;
  }

  async function createRoom() {
    if (!name.trim()) { showSnack("Please enter your name first.", "error"); return; }
    try {
      const token = localStorage.getItem("token");
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/rooms`, { method: "POST", headers, body: JSON.stringify({ hostName: name.trim() }) });
      if (!res.ok) throw new Error("Failed to create room");
      const { roomCode, hostSecret } = await res.json();
      localStorage.setItem("displayName", name.trim());
      localStorage.setItem(`host:${roomCode.toUpperCase()}`, JSON.stringify({ hostName: name.trim(), hostSecret: hostSecret || null, meetingCode: roomCode.toUpperCase(), createdAt: new Date().toISOString() }));
      navigate(`/room/${roomCode.toUpperCase()}`);
    } catch (err) { console.error(err); showSnack("Unable to create room.", "error"); }
  }

  async function copyLink() {
    if (!name.trim()) { showSnack("Enter your name before creating a link", "error"); return; }
    try {
      const token = localStorage.getItem("token");
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/rooms`, { method: "POST", headers, body: JSON.stringify({ hostName: name.trim() }) });
      if (!res.ok) throw new Error("Failed to create room");
      const { roomCode, hostSecret } = await res.json();
      const link = `${window.location.origin}/room/${roomCode.toUpperCase()}`;
      localStorage.setItem("displayName", name.trim());
      localStorage.setItem(`host:${roomCode.toUpperCase()}`, JSON.stringify({ hostName: name.trim(), hostSecret: hostSecret || null, createdAt: new Date().toISOString() }));
      const copied = await copyToClipboard(link);
      showSnack(copied ? "Link copied to clipboard" : `Copy failed — link: ${link}`, copied ? "success" : "error");
    } catch (err) { console.error(err); showSnack("Unable to create room link.", "error"); }
  }

  async function joinRoom() {
    if (!room.trim()) { showSnack("Enter room code or link", "error"); return; }
    const roomId = extractRoomFromInput(room).toUpperCase();
    try {
      const res = await fetch(`${API_BASE}/rooms/${roomId}`);
      if (!res.ok) throw new Error("Room not found");
      localStorage.setItem("displayName", name.trim() || "Guest");
      navigate(`/room/${roomId}`);
    } catch (err) { console.error(err); showSnack("Room does not exist or has expired.", "error"); }
  }

  async function handleLogout() {
    try { if (logout) { await logout(true); } else { localStorage.removeItem("token"); navigate("/login"); } }
    catch (err) { console.warn("logout error:", err); }
    finally { try { localStorage.removeItem("displayName"); } catch { } }
  }

  const displayInitial = (name || "?")[0].toUpperCase();

  return (
    <div className="hm-root">
      <div className="hm-bg" aria-hidden />

      {/* ── TOPBAR ── */}
      <header className="hm-topbar">
        <div className="hm-brand" onClick={() => navigate("/")}>
          <div className="hm-brand-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

      {/* ── WELCOME ── */}
      <div className="hm-welcome">
        <div className="hm-welcome-avatar" aria-hidden>{displayInitial}</div>
        <div className="hm-welcome-text">
          <h2>Welcome back{name ? `, ${name.split(" ")[0]}` : ""}!</h2>
          <p>Ready to connect? Create or join a room below.</p>
        </div>
      </div>

      {/* ── GRID ── */}
      <div className="hm-grid">

        {/* LEFT COLUMN */}
        <div className="hm-left">

          {/* Create Room */}
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
                <input id="hm-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex Kumar" />
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
                  Copy Link
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

          {/* Join Room */}
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
                <input id="hm-room" type="text" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="e.g. XKCD42 or https://…" onKeyDown={(e) => e.key === "Enter" && joinRoom()} />
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

        {/* RIGHT COLUMN — TRANSCRIPTS */}
        <div className="hm-card hm-transcripts">
          <div className="hm-card-header">
            <div>
              <div className="hm-card-title">Recent transcripts</div>
              <div className="hm-card-sub">From your hosted meetings</div>
            </div>
            {recentLocal.length > 0 && (
              <span className="hm-tx-badge">{recentLocal.length} saved</span>
            )}
          </div>

          <div className="hm-divider" />

          {/* Disabled state */}
          {!TRANSCRIPTS_ENABLED && (
            <div className="hm-tx-notice hm-tx-notice-warn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <p>Transcript service unavailable on this build.</p>
                <p className="hm-tx-notice-sub">Meetings still work — local recording runs in your browser.</p>
              </div>
            </div>
          )}

          {/* Empty state */}
          {recentLocal.length === 0 && TRANSCRIPTS_ENABLED && (
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

          {/* Transcript list */}
          {recentLocal.map((t, i) => {
            const key = getTranscriptKey(t, i);
            const isExpanded = !!expandedTranscripts[key];

            return (
              <div key={key} className="hm-tx-item">
                <div
                  className="hm-tx-head"
                  onClick={() => setExpandedTranscripts((prev) => ({ ...prev, [key]: !prev[key] }))}
                  role="button"
                  aria-expanded={isExpanded}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setExpandedTranscripts((prev) => ({ ...prev, [key]: !prev[key] }))}
                >
                  <div>
                    <div className="hm-tx-code">{t.meeting_code || "UNKNOWN"}</div>
                    <div className="hm-tx-date">{t.createdAt ? new Date(t.createdAt).toLocaleString() : "Unknown date"}</div>
                  </div>
                  <svg className={`hm-tx-chevron ${isExpanded ? "hm-tx-chevron-open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>

                {isExpanded && (
                  <div className="hm-tx-body">
                    <div className="hm-tx-preview">
                      {t.metadata?.segments?.length ? (
                        t.metadata.segments.map((s, idx) => (
                          <div key={idx} className="hm-tx-segment">
                            <span className="hm-tx-speaker">{s.speaker}</span>
                            {s.emoji && <span>{s.emoji}</span>}
                            {s.emotion && <span className="hm-tx-emotion">({s.emotion})</span>}
                            <span>: {s.text}</span>
                          </div>
                        ))
                      ) : (
                        t.transcript?.trim() || "(empty transcript)"
                      )}
                    </div>
                    <div className="hm-tx-actions">
                      <button
                        className="hm-tx-btn hm-tx-btn-dl"
                        onClick={() => {
                          const blob = new Blob([t.transcript || ""], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${(t.meeting_code || "transcript").toString().replace(/[^a-z0-9_\-]/gi, "_")}.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                        </svg>
                        Download .txt
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>


      <Snack msg={snackMsg} severity={snackSeverity} open={snackOpen} />
    </div>
  );
}