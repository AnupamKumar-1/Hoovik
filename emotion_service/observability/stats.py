"""
stats.py — Live inference latency stats endpoint for the emotion service.

Exposes two routes mounted on the FastAPI app:

    GET /stats       — HTML dashboard (browser-friendly, auto-refreshes every 5 s).
    GET /stats/json  — Raw JSON snapshot for programmatic access.

Usage
-----
In app.py, after creating the FastAPI instance::

    from stats import stats_router, set_tracker

    set_tracker(_latency_tracker)          # wire up the shared tracker instance
    app.include_router(stats_router)       # register /stats and /stats/json

The router is fully self-contained; it imports nothing from app.py. The
caller is responsible for calling ``set_tracker`` before the first request.
"""

from __future__ import annotations

import math
import time
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse

stats_router = APIRouter()

_tracker = None


def set_tracker(tracker) -> None:
    """Wire the shared _LatencyTracker instance from app.py into this module.

    Must be called once during application startup before any request hits
    /stats or /stats/json.

    Args:
        tracker: The _LatencyTracker instance created in app.py.
    """
    global _tracker
    _tracker = tracker


def _percentile(sorted_data: list[float], p: float) -> float:
    """Compute the p-th percentile of a pre-sorted list using linear interpolation.

    Args:
        sorted_data: Ascending-sorted list of floats.
        p: Percentile in [0, 100].

    Returns:
        Interpolated percentile value, or NaN when the list is empty.
    """
    if not sorted_data:
        return math.nan
    n = len(sorted_data)
    k = (n - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, n - 1)
    return sorted_data[lo] + (sorted_data[hi] - sorted_data[lo]) * (k - lo)


def _build_snapshot() -> dict:
    """Read current samples from the tracker and compute per-modality percentiles.

    Returns:
        Dict with keys ``generated_at``, ``modalities``, and ``overall``.
        Each modality entry contains n, min, mean, p50, p90, p95, max (all ms).
        Returns an empty snapshot dict when no tracker is wired.
    """
    if _tracker is None:
        return {"generated_at": time.time(), "modalities": {}, "overall": {}}

    with _tracker._lock:
        raw: dict[str, list[float]] = {
            k: sorted(v) for k, v in _tracker._samples.items() if v
        }

    def stats(vals: list[float]) -> dict:
        if not vals:
            return {}
        return {
            "n": len(vals),
            "min": round(vals[0], 1),
            "mean": round(sum(vals) / len(vals), 1),
            "p50": round(_percentile(vals, 50), 1),
            "p90": round(_percentile(vals, 90), 1),
            "p95": round(_percentile(vals, 95), 1),
            "max": round(vals[-1], 1),
        }

    modalities = {k: stats(v) for k, v in raw.items() if k != "overall"}
    overall = stats(raw.get("overall", []))

    return {
        "generated_at": time.time(),
        "modalities": modalities,
        "overall": overall,
    }


@stats_router.get("/stats/json", response_class=JSONResponse)
def stats_json() -> JSONResponse:
    """Return the current latency snapshot as JSON.

    Returns:
        JSONResponse containing the snapshot dict produced by _build_snapshot.
    """
    return JSONResponse(_build_snapshot())


@stats_router.get("/stats", response_class=HTMLResponse)
def stats_html() -> HTMLResponse:
    """Render a live HTML latency dashboard that auto-refreshes every 5 seconds.

    The page fetches /stats/json on load and on each 5-second tick, then
    re-renders the stat cards without a full page reload.

    Returns:
        HTMLResponse containing the self-contained dashboard page.
    """
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Emotion Service — Latency Stats</title>
<link rel="preconnect" href="https://fonts.googleapis.com">

<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #09090f;
    --surface:   #111118;
    --border:    #1e1e2e;
    --accent:    #7c6af7;
    --accent2:   #34d4a0;
    --accent3:   #f76a6a;
    --text:      #e2e2f0;
    --muted:     #5a5a7a;
    --mono:      'IBM Plex Mono', monospace;
    --display:   'Syne', sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono);
    min-height: 100vh;
    padding: 2.5rem 2rem;
  }

  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding-bottom: 1.25rem;
    margin-bottom: 2.5rem;
  }

  h1 {
    font-family: var(--display);
    font-size: clamp(1.4rem, 3vw, 2rem);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #fff;
  }

  h1 span { color: var(--accent); }

  #status {
    font-size: 0.72rem;
    color: var(--muted);
    text-align: right;
    line-height: 1.6;
  }

  #dot {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--accent2);
    margin-right: 5px;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }

  .section-label {
    font-size: 0.65rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 1rem;
  }

  .overall-card {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 1.5rem 2rem;
    margin-bottom: 2.5rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 1.5rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
    margin-bottom: 2.5rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1.25rem 1.5rem;
    transition: border-color 0.2s;
  }

  .card:hover { border-color: var(--accent); }

  .card-title {
    font-family: var(--display);
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin-bottom: 1.1rem;
    color: #fff;
  }

  .card-title .badge {
    display: inline-block;
    font-family: var(--mono);
    font-size: 0.6rem;
    font-weight: 400;
    background: var(--border);
    color: var(--muted);
    padding: 1px 6px;
    border-radius: 2px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .stats-row {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
  }

  .stat-label { color: var(--muted); }

  .stat-value {
    font-weight: 600;
    color: var(--text);
  }

  .stat-value.p50  { color: var(--accent2); }
  .stat-value.p90  { color: var(--accent); }
  .stat-value.p95  { color: var(--accent3); }

  .bar-wrap {
    height: 2px;
    background: var(--border);
    border-radius: 1px;
    margin-top: 3px;
  }

  .bar {
    height: 100%;
    border-radius: 1px;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  .overall-stat { text-align: center; }

  .overall-stat .val {
    font-family: var(--display);
    font-size: 1.6rem;
    font-weight: 700;
    display: block;
  }

  .overall-stat .lbl {
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .overall-stat .val.p50  { color: var(--accent2); }
  .overall-stat .val.p90  { color: var(--accent); }
  .overall-stat .val.p95  { color: var(--accent3); }
  .overall-stat .val.muted { color: var(--muted); }

  #empty {
    display: none;
    color: var(--muted);
    font-size: 0.85rem;
    padding: 3rem 0;
    text-align: center;
  }

  footer {
    font-size: 0.65rem;
    color: var(--muted);
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    letter-spacing: 0.06em;
  }
</style>
</head>
<body>

<header>
  <h1>emotion<span> / </span>stats</h1>
  <div id="status">
    <span id="dot"></span><span id="ts">fetching…</span><br>
    refreshes every 5 s
  </div>
</header>

<p class="section-label">Overall</p>
<div class="overall-card" id="overall-card">
  <div class="overall-stat"><span class="val muted" id="ov-n">—</span><span class="lbl">samples</span></div>
  <div class="overall-stat"><span class="val muted" id="ov-min">—</span><span class="lbl">min ms</span></div>
  <div class="overall-stat"><span class="val p50"   id="ov-p50">—</span><span class="lbl">p50 ms</span></div>
  <div class="overall-stat"><span class="val p90"   id="ov-p90">—</span><span class="lbl">p90 ms</span></div>
  <div class="overall-stat"><span class="val p95"   id="ov-p95">—</span><span class="lbl">p95 ms</span></div>
  <div class="overall-stat"><span class="val muted" id="ov-max">—</span><span class="lbl">max ms</span></div>
</div>

<p class="section-label">Per Modality</p>
<div class="grid" id="grid"></div>
<p id="empty">No inference data yet — waiting for participants…</p>

<footer>emotion-service · latency window: 500 samples · endpoint: /stats/json</footer>

<script>
const MOD_LABELS = {
  audio_only: 'Audio Only',
  video_only: 'Video Only',
  both:       'Both',
};

function fmt(v) { return v == null || isNaN(v) ? '—' : v.toFixed(1); }

function card(mod, s, maxP95) {
  const pct = maxP95 > 0 ? Math.min(100, (s.p95 / maxP95) * 100) : 0;
  return `
    <div class="card">
      <div class="card-title">
        ${MOD_LABELS[mod] || mod}
        <span class="badge">n=${s.n}</span>
      </div>
      <div class="stats-row">
        <div class="stat"><span class="stat-label">min</span>   <span class="stat-value">${fmt(s.min)} ms</span></div>
        <div class="stat"><span class="stat-label">mean</span>  <span class="stat-value">${fmt(s.mean)} ms</span></div>
        <div class="stat"><span class="stat-label">p50</span>   <span class="stat-value p50">${fmt(s.p50)} ms</span></div>
        <div class="stat"><span class="stat-label">p90</span>   <span class="stat-value p90">${fmt(s.p90)} ms</span></div>
        <div class="stat"><span class="stat-label">p95</span>   <span class="stat-value p95">${fmt(s.p95)} ms</span></div>
        <div class="stat"><span class="stat-label">max</span>   <span class="stat-value">${fmt(s.max)} ms</span></div>
      </div>
      <div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
}

async function refresh() {
  try {
    const res  = await fetch('/stats/json');
    const data = await res.json();

    const ts = new Date(data.generated_at * 1000).toLocaleTimeString();
    document.getElementById('ts').textContent = 'last update ' + ts;

    const ov = data.overall;
    if (ov && ov.n) {
      document.getElementById('ov-n').textContent   = ov.n;
      document.getElementById('ov-min').textContent = fmt(ov.min);
      document.getElementById('ov-p50').textContent = fmt(ov.p50);
      document.getElementById('ov-p90').textContent = fmt(ov.p90);
      document.getElementById('ov-p95').textContent = fmt(ov.p95);
      document.getElementById('ov-max').textContent = fmt(ov.max);
    }

    const mods = data.modalities || {};
    const maxP95 = Math.max(...Object.values(mods).map(s => s.p95 || 0));
    const order = ['audio_only', 'video_only', 'both'];
    const keys = [...order.filter(k => mods[k]), ...Object.keys(mods).filter(k => !order.includes(k))];

    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');

    if (keys.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      grid.innerHTML = keys.map(k => card(k, mods[k], maxP95)).join('');
    }
  } catch (e) {
    document.getElementById('ts').textContent = 'fetch error — retrying…';
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>"""
    return HTMLResponse(html)
