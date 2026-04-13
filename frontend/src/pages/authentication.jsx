import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../contexts/AuthContext";
import "../styles/authentication.css";

export default function Authentication() {
  const navigate = useNavigate();

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [formState, setFormState] = React.useState(0); // 0 = login, 1 = register
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const { handleRegister, handleLogin } = React.useContext(AuthContext);

  const handleAuth = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (formState === 0) {
        await handleLogin(username, password);
        navigate("/home", { replace: true });
      } else {
        const result = await handleRegister(name, username, password);
        setUsername(""); setPassword(""); setName("");
        setMessage(result || "Registered successfully");
        setOpen(true);
        setFormState(0);
      }
    } catch (err) {
      setError(err?.response?.data?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 4000);
    return () => clearTimeout(t);
  }, [open]);

  const isLogin = formState === 0;

  return (
    <div className="au-root">

      <div className="au-bg" aria-hidden />

      <aside className="au-hero" aria-hidden>
        <div className="au-hero-inner">
          <div className="au-hero-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
                stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
            <span>SkyMeetAI</span>
          </div>

          <div className="au-hero-content">
            <div className="au-hero-badge">
              <span className="au-hero-badge-dot" />
              Real-time AI Meeting Platform
            </div>
            <h2 className="au-hero-heading">
              Meetings that<br />
              <span className="au-hero-accent">understand you.</span>
            </h2>
            <p className="au-hero-lead">
              Emotion-aware transcription, live AI insights,
              and crystal-clear WebRTC — all in one place.
            </p>

            <div className="au-hero-stats">
              <div className="au-hero-stat">
                <span className="au-stat-val">Instant</span>
                <span className="au-stat-label">WebRTC real-time streaming</span>
              </div>

              <div className="au-hero-stat">
                <span className="au-stat-val">Live AI</span>
                <span className="au-stat-label">Emotion insights (~1s updates)</span>
              </div>

              <div className="au-hero-stat">
                <span className="au-stat-val">Whisper</span>
                <span className="au-stat-label">Accurate transcripts</span>
              </div>
            </div>
          </div>

          <div className="au-hero-card" aria-hidden>
            <div className="au-hero-card-top">
              <span className="au-hero-card-label">AI POWERED SESSION</span>
              <div className="au-hero-card-dots">
                <span className="au-dot au-dot-r" />
                <span className="au-dot au-dot-y" />
                <span className="au-dot au-dot-g" />
              </div>
            </div>
            <div className="au-hero-avatars">
              {["A", "P", "R"].map((l, i) => (
                <div key={i} className={`au-av au-av-${i + 1}`}>{l}</div>
              ))}
            </div>
            <div className="au-hero-chips">
              <span className="au-chip au-chip-sky">● Live Emotion AI</span>
              <span className="au-chip au-chip-gold">✦ Smart Transcript</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── RIGHT PANEL ── */}
      <main className="au-panel">
        <div className="au-form-card">

          <div className="au-form-brand">
            <div className="au-form-brand-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
                  stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="au-form-brand-name">SkyMeetAI</span>
          </div>

          {/* Heading */}
          <h1 className="au-form-title">
            {isLogin ? "Welcome back" : "Create account"}
          </h1>
          <p className="au-form-sub">
            {isLogin
              ? "Sign in to your SkyMeetAI account"
              : "Join the intelligent meeting platform"}
          </p>

          {/* Toggle tabs */}
          <div className="au-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={isLogin}
              className={`au-tab ${isLogin ? "au-tab-active" : ""}`}
              onClick={() => { setFormState(0); setError(""); }}
              type="button"
            >
              Sign In
            </button>
            <button
              role="tab"
              aria-selected={!isLogin}
              className={`au-tab ${!isLogin ? "au-tab-active" : ""}`}
              onClick={() => { setFormState(1); setError(""); }}
              type="button"
            >
              Sign Up
            </button>
          </div>

          {/* Form */}
          <form className="au-form" onSubmit={handleAuth} noValidate>

            {!isLogin && (
              <div className="au-field au-field-animate">
                <label className="au-label" htmlFor="au-name">Full Name</label>
                <input
                  id="au-name"
                  className="au-input"
                  type="text"
                  placeholder="e.g. Alex Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
            )}

            <div className="au-field">
              <label className="au-label" htmlFor="au-username">Username</label>
              <input
                id="au-username"
                className="au-input"
                type="text"
                placeholder="your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>

            <div className="au-field">
              <label className="au-label" htmlFor="au-password">Password</label>
              <input
                id="au-password"
                className="au-input"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isLogin ? "current-password" : "new-password"}
                required
              />
            </div>

            {/* Error */}
            {error && (
              <div className="au-error" role="alert">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              className="au-submit"
              disabled={loading}
            >
              {loading ? (
                <span className="au-spinner" aria-hidden />
              ) : (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {isLogin
                      ? <><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" /></>
                      : <><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></>
                    }
                  </svg>
                  {isLogin ? "Sign In" : "Create Account"}
                </>
              )}
            </button>

          </form>

          {/* Footer note */}
          <p className="au-form-foot">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              className="au-form-foot-link"
              onClick={() => { setFormState(isLogin ? 1 : 0); setError(""); }}
            >
              {isLogin ? "Sign up" : "Sign in"}
            </button>
          </p>

        </div>
      </main>

      {open && (
        <div className="au-snack" role="status" aria-live="polite">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {message}
        </div>
      )}
    </div>
  );
}