import React, { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import '../styles/history.css';


const isTrivialName = (n) => {
  if (!n) return true;
  const s = String(n).trim().toLowerCase();
  if (!s || s.length <= 2) return true;
  return ['guest', 'participant', 'host', 'unknown', 'user'].includes(s);
};

const toM = (s) => {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
};

const formatDate = (dateString) => {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const mins = date.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} · ${hours}:${mins}`;
};

const participantName = (p) => {
  if (!p) return 'Guest';
  if (typeof p === 'string') return p;
  return p?.name || p?.display || p?.username || 'Guest';
};

const initials = (name) => {
  if (!name || typeof name !== 'string') return 'G';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || name.slice(0, 1).toUpperCase();
};

const userMatchesParticipant = (user, participant) => {
  if (!user || !participant) return false;
  const pId = participant?._id || participant?.id || participant?.userId || participant?.user_id || null;
  const pUsername = participant?.username || participant?.userName || participant?.user || null;
  const pEmail = participant?.email || participant?.mail || null;
  const pName = typeof participant === 'string' ? participant : participant?.name || participant?.display || participant?.fullName || null;
  const uId = user?._id || user?.id || null;
  const uUsername = user?.username || user?.userName || null;
  const uEmail = user?.email || null;
  const uName = user?.name || user?.display || null;
  if (uId && pId && String(uId) === String(pId)) return true;
  if (uUsername && pUsername && String(uUsername).toLowerCase() === String(pUsername).toLowerCase()) return true;
  if (uEmail && pEmail && String(uEmail).toLowerCase() === String(pEmail).toLowerCase()) return true;
  if (uName && pName && !isTrivialName(uName) && !isTrivialName(pName)) {
    if (String(uName).trim().toLowerCase() === String(pName).trim().toLowerCase()) return true;
  }
  return false;
};


export default function History() {
  const { getHistoryOfUser, userData } = useContext(AuthContext);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [showAllFor, setShowAllFor] = useState({});
  const [snack, setSnack] = useState({ open: false, msg: '', severity: 'success' });
  const routeTo = useNavigate();

  useEffect(() => {
    let mounted = true;

    const toArrayShape = (res) => {
      if (!res) return [];
      if (Array.isArray(res)) return res;
      if (Array.isArray(res.meetings)) return res.meetings;
      if (Array.isArray(res.data)) return res.data;
      return [];
    };

    const readLocalFallback = () => {
      try {
        const raw = localStorage.getItem('meeting_history_v1');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.warn('readLocalFallback failed', err);
        return [];
      }
    };

    const normalizeParticipants = (rawParts) => {
      const arr = Array.isArray(rawParts) ? rawParts : [];
      const out = [];
      const seen = new Set();
      for (const p of arr) {
        if (!p && p !== 0) continue;
        const obj = typeof p === 'string' ? { name: p } : typeof p === 'object' ? p : { name: String(p) };
        const key = obj?._id || obj?.id || obj?.username || obj?.email ||
          (obj?.name ? String(obj.name).trim().toLowerCase() : null) || JSON.stringify(obj);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(obj);
      }
      return out;
    };

    const normalize = (m) => {
      const meetingCode = m?.meetingCode || m?.code || m?.room || m?.meeting_code || '';
      const createdAt = m?.createdAt || m?.created_at || m?.date || m?.created || m?.timestamp || '';
      const hostName =
        m?.hostInfo?.name ||
        m?.hostName ||
        m?.host_name ||
        (m?.host && typeof m.host === 'object' && (m.host.name || m.host.username || m.host.email)) ||
        (typeof m?.host === 'string' ? m.host : null) ||
        'Unknown';
      const participants = normalizeParticipants(m?.participants || m?.attendees || m?.people || []);
      const link = m?.link || (meetingCode
        ? `${window.location.origin}/room/${encodeURIComponent(String(meetingCode).trim().toUpperCase())}`
        : null);
      const id = m?._id || m?.id || meetingCode || Math.random().toString(36).slice(2, 9);
      const hostId = m?.host?._id || m?.host?.id || m?.host_id || m?.hostId || null;
      return { id, meetingCode, createdAt, hostName, participants, link, raw: m, hostId };
    };

    const mergeServerAndLocal = (serverArr, localArr) => {
      const out = [];
      const seen = new Set();
      const keyFor = (item) => {
        const code = item?.meetingCode || item?.meeting_code || item?.code || item?.room;
        if (code) return String(code).trim().toUpperCase();
        if (item?.id) return `ID:${String(item.id).trim()}`;
        return `RAW:${JSON.stringify(item).slice(0, 100)}`;
      };
      (serverArr || []).forEach((s) => { const k = keyFor(s); if (!seen.has(k)) { out.push(s); seen.add(k); } });
      (localArr || []).forEach((l) => { const k = keyFor(l); if (!seen.has(k)) { out.push(l); seen.add(k); } });
      return out;
    };

    const isUserInMeeting = (hoovik, user) => {
      if (!user) return false;
      if (hoovik.hostId && user?._id && String(user._id) === String(hoovik.hostId)) return true;
      const raw = hoovik.raw || {};
      const rawHost = raw.host || raw.host_info || null;
      if (rawHost && typeof rawHost === 'object') {
        if (user._id && String(rawHost._id || rawHost.id) === String(user._id)) return true;
        if (user.username && rawHost.username && String(user.username).toLowerCase() === String(rawHost.username).toLowerCase()) return true;
        if (user.email && rawHost.email && String(user.email).toLowerCase() === String(rawHost.email).toLowerCase()) return true;
      }
      return (hoovik.participants || []).some((p) => userMatchesParticipant(user, p));
    };

    const fetchHistory = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await getHistoryOfUser();
        const serverArr = toArrayShape(res);
        const localArr = readLocalFallback();
        const merged = mergeServerAndLocal(serverArr, localArr);
        const normalized = merged.map(normalize);
        const filtered = userData ? normalized.filter((m) => isUserInMeeting(m, userData)) : [];
        const sorted = filtered.sort((a, b) => toM(b.createdAt) - toM(a.createdAt));
        if (mounted) setMeetings(sorted);
      } catch (err) {
        console.error('fetchHistory error:', err);
        if (mounted) setError(err?.message || 'Failed to load history');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchHistory();

    const onStorage = (ev) => { if (ev.key === 'meeting_history_v1' && mounted) setTimeout(fetchHistory, 60); };
    const onCustomUpdate = () => { if (mounted) fetchHistory(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('meeting_history_updated', onCustomUpdate);
    return () => {
      mounted = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('meeting_history_updated', onCustomUpdate);
    };
  }, [getHistoryOfUser, userData]);

  const buildLink = (m) =>
    m?.link || (m?.meetingCode
      ? `${window.location.origin}/room/${encodeURIComponent(String(m.meetingCode).trim().toUpperCase())}`
      : null);

  const showSnack = (msg, severity = 'success') => {
    setSnack({ open: true, msg, severity });
    setTimeout(() => setSnack(s => ({ ...s, open: false })), 3000);
  };

  const copyLink = async (link) => {
    if (!link) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const ta = document.createElement('textarea');
        ta.value = link;
        Object.assign(ta.style, { position: 'fixed', left: '-9999px' });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showSnack('Link copied to clipboard', 'success');
    } catch {
      showSnack('Failed to copy link', 'error');
    }
  };

  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const isCardHost = (m) => {
    if (!userData) return false;
    const hostId = m.hostId || (m.raw && (m.raw.host?._id || m.raw.host?.id || m.raw.hostId || m.raw.host_id));
    if (hostId && userData._id && String(hostId) === String(userData._id)) return true;
    const rawHost = m.raw?.host;
    if (rawHost && typeof rawHost === 'object') {
      if (rawHost.username && userData.username && String(rawHost.username).toLowerCase() === String(userData.username).toLowerCase()) return true;
      if (rawHost.email && userData.email && String(rawHost.email).toLowerCase() === String(userData.email).toLowerCase()) return true;
    }
    if (m.hostName && userData.name && !isTrivialName(m.hostName) && !isTrivialName(userData.name)) {
      if (String(m.hostName).trim().toLowerCase() === String(userData.name).trim().toLowerCase()) return true;
    }
    return false;
  };

  const isParticipantHost = (pRaw, m) => {
    if (!pRaw || !m) return false;
    const hostId =
      m.hostId ||
      (m.raw && (m.raw.host?._id || m.raw.host?.id || m.raw.hostId || m.raw.host_id)) ||
      null;
    if (!hostId) return false;
    const pUserId = pRaw?._id || pRaw?.id || pRaw?.userId || pRaw?.user_id || pRaw?.meta?.userId || null;
    if (!pUserId) return false;
    if (!/^[a-f\d]{24}$/i.test(String(hostId))) return false;
    if (!/^[a-f\d]{24}$/i.test(String(pUserId))) return false;
    return String(pUserId) === String(hostId);
  };

  const isYou = (pRaw) => {
    if (!userData || !pRaw) return false;
    const pUserId = pRaw?._id || pRaw?.id || pRaw?.userId || pRaw?.user_id || pRaw?.meta?.userId || null;
    const uId = userData?._id || userData?.id || null;
    if (!pUserId || !uId) return false;
    return String(pUserId) === String(uId);
  };

  const PREVIEW_LIMIT = 6;

  return (
    <div className="hist-root">
      <div className="hist-bg-sparkles" aria-hidden />
      <header className="hist-topbar">
        <button
          className="hist-back"
          onClick={() => routeTo('/home')}
          aria-label="Back to home"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="hist-brand" aria-hidden>
          <img src="/logo.svg" alt="Hoovik" width="28" height="28" />
          <span className="hist-brand-name">Hoovik</span>
        </div>

        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M9 18l6-6-6-6" />
        </svg>

        <div>
          <div className="hist-page-title">Meeting history</div>
          <div className="hist-page-sub">Meetings you joined or hosted</div>
        </div>

        {!loading && meetings.length > 0 && (
          <div className="hist-count-badge">{meetings.length} total</div>
        )}
      </header>

      <div className="hist-content">

        {loading && (
          <div className="hist-loading-row">
            <span className="hist-spinner" />
            Loading history…
          </div>
        )}

        {error && (
          <div className="hist-alert hist-alert--error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {!loading && !userData && (
          <div className="hist-empty-state">
            <div className="hist-empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            </div>
            <p className="hist-empty-text">You're not signed in. Sign in to view meetings you participated in.</p>
            <button className="hist-sign-in" onClick={() => routeTo('/login')}>Sign in</button>
          </div>
        )}

        {!loading && userData && meetings.length === 0 && !error && (
          <div className="hist-empty-state">
            <div className="hist-empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M3 3v5h5" /><path d="M21 12a9 9 0 1 1-9-9" /><path d="M12 7v6l4 2" />
              </svg>
            </div>
            <p className="hist-empty-text">No meeting history found. If you recently left a meeting, try refreshing the page.</p>
          </div>
        )}

        {!loading && meetings.map((m) => {
          const cardIsHost = isCardHost(m);
          const link = buildLink(m);
          const isExpanded = !!expanded[m.id];
          const showAll = !!showAllFor[m.id];
          const parts = Array.isArray(m.participants) ? m.participants : [];
          const visibleParts = showAll ? parts : parts.slice(0, PREVIEW_LIMIT);

          return (
            <div key={m.id} className="hist-card">
              <div className="hist-card-header">
                <div className="hist-card-left">
                  <div className="hist-meta-row">
                    <span className="hist-code-chip">
                      {m.meetingCode ? String(m.meetingCode).trim().toUpperCase() : '—'}
                    </span>
                    <span className="hist-date-text">{formatDate(m.createdAt)}</span>
                  </div>

                  <div className="hist-host-row">
                    <span className="hist-host-name">{m.hostName || 'Unknown'}</span>
                    {cardIsHost && <span className="hist-host-badge">HOST</span>}
                  </div>

                  <div className="hist-participant-count">
                    {parts.length} participant{parts.length !== 1 ? 's' : ''}
                  </div>

                  {link && (
                    <div className="hist-link-row">
                      <a href={link} target="_blank" rel="noreferrer" className="hist-open-link">
                        Open meeting
                      </a>
                      <button
                        className="hist-icon-btn"
                        onClick={() => window.open(link, '_blank')}
                        title="Open in new tab"
                        aria-label="Open meeting in new tab"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                        </svg>
                      </button>
                      <button
                        className="hist-icon-btn"
                        onClick={() => copyLink(link)}
                        title="Copy link"
                        aria-label="Copy meeting link"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: expand toggle */}
                {parts.length > 0 && (
                  <button
                    className="hist-expand-btn"
                    onClick={() => toggleExpand(m.id)}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? 'Collapse participants' : 'Expand participants'}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8z" />
                    </svg>
                    Participants
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                      className={`hist-expand-chevron ${isExpanded ? 'hist-expand-chevron--open' : 'hist-expand-chevron--closed'}`}
                      aria-hidden
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Participants panel */}
              {isExpanded && (
                <>
                  <div className="hist-divider" />
                  <div className="hist-participants-grid">
                    {parts.length === 0 && (
                      <p className="hist-no-participants">No participants recorded.</p>
                    )}
                    {visibleParts.map((pRaw, idx) => {
                      const name = participantName(pRaw);
                      const pIsHost = isParticipantHost(pRaw, m);
                      const pIsYou = isYou(pRaw);
                      const tileKey = pRaw?._id || pRaw?.id || `${name}-${idx}`;

                      return (
                        <div key={`${m.id}-p-${tileKey}`} className="hist-ptile">
                          <div className="hist-avatar">{initials(name)}</div>
                          <div className="hist-ptile-info">
                            <div className="hist-ptile-name-row">
                              <span className="hist-p-name">{name}</span>
                              {pIsYou && <span className="hist-you-chip">YOU</span>}
                              {pIsHost && <span className="hist-host-chip">HOST</span>}
                            </div>
                            <div className="hist-role-row">
                              <span className={`hist-role-badge ${pIsHost ? 'hist-role-badge--host' : 'hist-role-badge--participant'}`}>
                                {pIsHost ? 'Host' : 'Participant'}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {parts.length > PREVIEW_LIMIT && (
                    <button
                      className="hist-show-more"
                      onClick={() => setShowAllFor(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                    >
                      {showAll ? 'Show less' : `Show all ${parts.length} participants`}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {snack.open && (
        <div className={`hist-snack hist-snack--${snack.severity}`} role="status" aria-live="polite">
          {snack.severity === 'success'
            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><polyline points="20 6 9 17 4 12" /></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
          }
          {snack.msg}
        </div>
      )}
    </div>
  );
}