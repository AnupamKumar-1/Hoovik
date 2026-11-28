// Network witness. Measures, from inside the page, the outbound requests made while a summary is
// generated, and turns the measurement into a receipt.
//
// What it is: a count of requests this page made during one window, grouped by destination.
// What it is not: a guarantee. It cannot see requests made by the browser itself (for example
// Chrome downloading the on-device model), browser extensions, WebSocket connections, or anything
// outside this page. See WITNESS_BLIND_SPOTS, which the UI shows next to every receipt.
//
// Privacy rules enforced here:
//  - only hosts and counts leave this module; full URLs, paths, query strings and request or
//    response bodies are never stored, returned or put in a receipt (a Firebase request URL can
//    carry an API key in its query string);
//  - recording a request can never change or break the request itself.
//
// Two sources are merged so that one blind spot does not hide a request:
//  - a thin wrapper around fetch and XMLHttpRequest.open, active only while a window is open;
//  - Resource Timing entries delivered by a PerformanceObserver during the window.
// Per URL (origin + path) the larger of the two counts is used, so a request seen by both is
// counted once.

import { MODES, POLICIES, SOURCES, normalizeSource } from "./policy.js";

export const RECEIPT_VERSION = 1;

export const REQUEST_CLASSES = Object.freeze({
  SAME_ORIGIN: "same-origin", // this app: the page's own origin or its own server
  FIREBASE: "firebase", // Firebase and App Check housekeeping (tokens, installation, reCAPTCHA)
  AI: "ai-endpoint", // a generative-AI service
  OTHER: "other",
});

// The one place the host lists live. Matching is by whole host names: an entry matches the host
// itself and its subdomains (never a look-alike such as "googleapis.com.example.net").
export const HOST_RULES = Object.freeze({
  ai: Object.freeze({
    // Firebase AI Logic calls firebasevertexai.googleapis.com (DEFAULT_DOMAIN in @firebase/ai).
    hosts: Object.freeze([
      "firebasevertexai.googleapis.com",
      "firebaseai.googleapis.com",
      "generativelanguage.googleapis.com",
      "aiplatform.googleapis.com",
      "api.groq.com",
      "api.openai.com",
    ]),
    // Regional Vertex AI hosts look like us-central1-aiplatform.googleapis.com.
    hostSuffixes: Object.freeze(["-aiplatform.googleapis.com"]),
  }),
  firebase: Object.freeze({
    hosts: Object.freeze([
      "firebaseinstallations.googleapis.com",
      "firebase.googleapis.com",
      "firebaseappcheck.googleapis.com",
      "content-firebaseappcheck.googleapis.com",
      "identitytoolkit.googleapis.com",
      "securetoken.googleapis.com",
      "www.google.com", // reCAPTCHA for App Check; host-level, so coarse
      "www.gstatic.com",
      "www.recaptcha.net",
    ]),
  }),
});

export const WITNESS_BLIND_SPOTS = Object.freeze([
  "Requests made by the browser itself, such as Chrome downloading the on-device model.",
  "Browser extensions and anything running outside this page.",
  "WebSocket connections.",
  "Requests still in flight when the measurement ended may be missing from the browser's timing data.",
  "This is a measurement taken inside the page, not a guarantee.",
]);

export const VERDICTS = Object.freeze({
  LOCAL_VERIFIED: "local-verified",
  CLOUD: "cloud",
  VIOLATION: "violation",
  INCONCLUSIVE: "inconclusive",
  NO_AI_REQUESTS: "no-ai-requests",
});

const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const MAX_HOSTS = 10;
const MAX_HOST_CHARS = 60; // keeps a worst-case receipt well under the server's 4 KB limit
const MAX_TEXT_CHARS = 300;

// ---- classification ---------------------------------------------------------------------------

const normHost = (h) => String(h).toLowerCase().replace(/\.$/, "");
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Parse a request URL (string, URL or Request-like) into the parts the witness may keep.
 * Returns null for URLs that are not network requests (data:, blob:, about:...), and
 * { unparseable: true } when the value cannot be read as a URL.
 */
export function parseRequestUrl(raw, base) {
  let s = raw;
  if (raw !== null && typeof raw === "object") s = typeof raw.href === "string" ? raw.href : raw.url;
  if (typeof s !== "string" || !s) return { unparseable: true };
  let u;
  try {
    u = base ? new URL(s, base) : new URL(s);
  } catch {
    return { unparseable: true };
  }
  if (!WEB_PROTOCOLS.has(u.protocol)) return null;
  return { host: normHost(u.hostname), origin: u.origin, key: `${u.origin}${u.pathname}` };
}

/**
 * Classify one request. Returns { cls, host, key } or null when it is not a network request.
 * Order matters: the AI list wins over everything else, so an AI host is never hidden by a
 * broader rule.
 */
export function classifyUrl(raw, { origin, base, ownHosts = [], rules = HOST_RULES } = {}) {
  const p = parseRequestUrl(raw, base ?? origin);
  if (p === null) return null;
  if (p.unparseable) return { cls: REQUEST_CLASSES.OTHER, host: "unparseable", key: "unparseable" };
  const { host } = p;
  if (hostIn(host, rules.ai.hosts) || rules.ai.hostSuffixes.some((s) => host.endsWith(s))) return { cls: REQUEST_CLASSES.AI, host, key: p.key };
  if (hostIn(host, rules.firebase.hosts)) return { cls: REQUEST_CLASSES.FIREBASE, host, key: p.key };
  if ((origin && p.origin === origin) || ownHosts.map(normHost).includes(host)) return { cls: REQUEST_CLASSES.SAME_ORIGIN, host, key: p.key };
  return { cls: REQUEST_CLASSES.OTHER, host, key: p.key };
}

// ---- request hub: one wrapper per window object, shared by every open observation window -------

const hubs = new WeakMap();

function hubFor(win) {
  const existing = hubs.get(win);
  if (existing) return existing;

  const listeners = new Set();
  let capabilities = { fetch: false, xhr: false };
  let undo = null;
  const emit = (kind, raw) => {
    for (const fn of [...listeners]) {
      try {
        fn(kind, raw);
      } catch {
        /* recording must never affect a request */
      }
    }
  };

  function install() {
    let active = true;
    const restores = [];
    const caps = { fetch: false, xhr: false };

    const origFetch = win.fetch;
    if (typeof origFetch === "function") {
      const wrapped = function (...args) {
        if (active) emit("fetch", args[0]);
        return origFetch.apply(win, args);
      };
      win.fetch = wrapped;
      caps.fetch = true;
      restores.push(() => {
        if (win.fetch === wrapped) win.fetch = origFetch;
      });
    }

    const proto = win.XMLHttpRequest?.prototype;
    const origOpen = proto?.open;
    if (typeof origOpen === "function") {
      const wrappedOpen = function (...args) {
        if (active) emit("xhr", args[1]);
        return origOpen.apply(this, args);
      };
      proto.open = wrappedOpen;
      caps.xhr = true;
      restores.push(() => {
        if (proto.open === wrappedOpen) proto.open = origOpen;
      });
    }

    capabilities = caps;
    // If something else wrapped fetch on top of ours, we cannot unwind it; going inactive makes our
    // wrapper a pass-through so a later window installs a fresh one without double counting.
    undo = () => {
      active = false;
      restores.forEach((r) => r());
    };
  }

  const hub = {
    add(fn) {
      if (listeners.size === 0) install();
      listeners.add(fn);
      return {
        capabilities,
        remove() {
          listeners.delete(fn);
          if (listeners.size === 0 && undo) {
            undo();
            undo = null;
          }
        },
      };
    },
  };
  hubs.set(win, hub);
  return hub;
}

// ---- observation window -----------------------------------------------------------------------

const EMPTY_OBSERVATION = () => ({
  methods: { fetch: false, xhr: false, resourceTiming: false },
  durationMs: 0,
  startedAt: null,
  counts: { total: 0, sameOrigin: 0, firebase: 0, ai: 0, other: 0 },
  hosts: { firebase: [], ai: [], other: [] },
});

const defaultWin = () => (typeof window !== "undefined" ? window : undefined);

/**
 * createWitness().start() opens a window and returns { stop() }. stop() closes it and returns the
 * observation (counts and hosts only). start() and stop() never throw. Windows may overlap or nest;
 * each one sees the requests made while it was open.
 */
export function createWitness({ win = defaultWin(), ownHosts = [], rules = HOST_RULES, clock = () => Date.now() } = {}) {
  return {
    start() {
      if (!win) return { stop: EMPTY_OBSERVATION };
      try {
        return openWindow({ win, ownHosts, rules, clock });
      } catch {
        return { stop: EMPTY_OBSERVATION };
      }
    },
  };
}

function openWindow({ win, ownHosts, rules, clock }) {
  const perf = win.performance;
  const nowMs = () => (typeof perf?.now === "function" ? perf.now() : 0);
  const startMark = nowMs();
  const startedAt = new Date(clock()).toISOString();
  const classifyOpts = { origin: win.location?.origin, base: win.location?.href, ownHosts, rules };

  const seen = new Map(); // key -> { host, cls, wrapped, timing }
  const add = (c, field) => {
    const k = `${c.cls}|${c.key}`;
    const entry = seen.get(k) ?? { host: c.host, cls: c.cls, wrapped: 0, timing: 0 };
    entry[field] += 1;
    seen.set(k, entry);
  };

  const sub = hubFor(win).add((_kind, raw) => {
    const c = classifyUrl(raw, classifyOpts);
    if (c) add(c, "wrapped");
  });
  const methods = { fetch: !!sub.capabilities.fetch, xhr: !!sub.capabilities.xhr, resourceTiming: false };

  const ingest = (entries) => {
    for (const e of entries || []) {
      if (typeof e?.startTime === "number" && e.startTime < startMark) continue; // started before the window
      const c = classifyUrl(e?.name, classifyOpts);
      if (c) add(c, "timing");
    }
  };

  let observer = null;
  if (typeof win.PerformanceObserver === "function") {
    try {
      observer = new win.PerformanceObserver((list) => ingest(list.getEntries()));
      observer.observe({ type: "resource" });
      methods.resourceTiming = true;
    } catch {
      observer = null;
    }
  }

  let result = null;
  return {
    stop() {
      if (result) return result;
      const endMark = nowMs();
      try {
        if (observer) {
          ingest(observer.takeRecords());
          observer.disconnect();
        }
      } catch {
        /* keep what was collected */
      }
      sub.remove();

      const counts = { total: 0, sameOrigin: 0, firebase: 0, ai: 0, other: 0 };
      const hosts = { firebase: new Set(), ai: new Set(), other: new Set() };
      for (const e of seen.values()) {
        const n = Math.max(e.wrapped, e.timing);
        counts.total += n;
        if (e.cls === REQUEST_CLASSES.SAME_ORIGIN) counts.sameOrigin += n;
        else if (e.cls === REQUEST_CLASSES.FIREBASE) { counts.firebase += n; hosts.firebase.add(e.host); }
        else if (e.cls === REQUEST_CLASSES.AI) { counts.ai += n; hosts.ai.add(e.host); }
        else { counts.other += n; hosts.other.add(e.host); }
      }
      const list = (s) => [...s].sort().slice(0, MAX_HOSTS).map((h) => h.slice(0, MAX_HOST_CHARS));
      result = {
        methods,
        durationMs: Math.max(0, Math.round(endMark - startMark)),
        startedAt,
        counts,
        hosts: { firebase: list(hosts.firebase), ai: list(hosts.ai), other: list(hosts.other) },
      };
      return result;
    },
  };
}

// ---- verdict and receipt ----------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinHosts = (hosts) => (hosts.length ? hosts.join(", ") : "unknown host");

/** Plain-language sentence for a verdict. Deterministic, so a stored receipt can be re-read safely. */
export function describeVerdict(verdict, { status, counts, aiHosts = [] } = {}) {
  const ai = counts?.ai ?? 0;
  switch (verdict) {
    case VERDICTS.LOCAL_VERIFIED:
      return "Analysed on this device. No requests to AI services were observed while it ran.";
    case VERDICTS.VIOLATION:
      return `Expected on-device inference, but ${plural(ai, "request", "requests")} to AI services ${ai === 1 ? "was" : "were"} observed (${joinHosts(aiHosts)}).`;
    case VERDICTS.CLOUD:
      return status === "done"
        ? `Sent to a cloud AI service (${joinHosts(aiHosts)}). ${plural(ai, "request", "requests")} observed.`
        : `A request was sent to a cloud AI service (${joinHosts(aiHosts)}), but no usable result came back.`;
    case VERDICTS.NO_AI_REQUESTS:
      return "No analysis was produced. No requests to AI services were observed.";
    default:
      return "The measurement could not confirm where this ran.";
  }
}

/** Pure decision. Inputs are plain values, so every branch is testable without a browser. */
export function decideVerdict({ status, source, mode, policy, counts, methods }) {
  const measured = !!(methods?.fetch || methods?.xhr || methods?.resourceTiming);
  if (!measured) return VERDICTS.INCONCLUSIVE;
  const ai = counts?.ai ?? 0;
  const expectLocal = policy === POLICIES.LOCAL_ONLY || mode === MODES.ONLY_ON_DEVICE || source === SOURCES.ON_DEVICE;
  if (expectLocal && ai > 0) return VERDICTS.VIOLATION;
  if (status !== "done") return ai > 0 ? VERDICTS.CLOUD : VERDICTS.NO_AI_REQUESTS;
  if (source === SOURCES.ON_DEVICE) return VERDICTS.LOCAL_VERIFIED;
  if (source === SOURCES.CLOUD && ai > 0) return VERDICTS.CLOUD;
  return VERDICTS.INCONCLUSIVE; // cloud result with no AI request seen, or no source reported
}

const isKnown = (list, v) => typeof v === "string" && Object.values(list).includes(v);

/**
 * Build the receipt stored in `provenance.receipt`. Flat on purpose: primitives, small counts
 * and short arrays of host names, which fits the server's receipt limits (depth 3, 40 keys, 4 KB).
 * It contains no URLs, request bodies, transcript text or speaker names.
 */
export function buildReceipt({ observation, policy, mode, source, status }) {
  const obs = observation ?? EMPTY_OBSERVATION();
  const src = normalizeSource(source);
  const verdict = decideVerdict({ status, source: src, mode, policy, counts: obs.counts, methods: obs.methods });
  const aiHosts = obs.hosts.ai;
  return {
    version: RECEIPT_VERSION,
    verdict,
    verdictText: describeVerdict(verdict, { status, counts: obs.counts, aiHosts }).slice(0, MAX_TEXT_CHARS),
    policy: isKnown(POLICIES, policy) ? policy : null,
    mode: isKnown(MODES, mode) ? mode : null,
    source: src,
    status: typeof status === "string" && /^[a-z-]{1,24}$/.test(status) ? status : null,
    observedAt: obs.startedAt,
    durationMs: obs.durationMs,
    requests: { ...obs.counts },
    aiHosts: [...aiHosts],
    firebaseHosts: [...obs.hosts.firebase],
    otherHosts: [...obs.hosts.other],
    observers: { ...obs.methods },
  };
}

const nonNegInt = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const hostList = (v) => (Array.isArray(v) ? v.filter((h) => typeof h === "string" && h).slice(0, MAX_HOSTS).map((h) => h.slice(0, MAX_HOST_CHARS)) : []);

/**
 * Read a stored receipt for display. Stored data came from a client, so nothing is trusted: the
 * verdict must be known, numbers are coerced, and the wording is regenerated from the verdict
 * instead of being read back. Returns null when there is no usable receipt.
 */
export function readReceipt(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isKnown(VERDICTS, raw.verdict)) return null;
  const r = raw.requests && typeof raw.requests === "object" ? raw.requests : {};
  const requests = { total: nonNegInt(r.total), sameOrigin: nonNegInt(r.sameOrigin), firebase: nonNegInt(r.firebase), ai: nonNegInt(r.ai), other: nonNegInt(r.other) };
  const o = raw.observers && typeof raw.observers === "object" ? raw.observers : {};
  const status = typeof raw.status === "string" && /^[a-z-]{1,24}$/.test(raw.status) ? raw.status : null;
  const aiHosts = hostList(raw.aiHosts);
  return {
    version: nonNegInt(raw.version) || RECEIPT_VERSION,
    verdict: raw.verdict,
    verdictText: describeVerdict(raw.verdict, { status, counts: requests, aiHosts }),
    policy: isKnown(POLICIES, raw.policy) ? raw.policy : null,
    mode: isKnown(MODES, raw.mode) ? raw.mode : null,
    source: normalizeSource(raw.source),
    status,
    observedAt: typeof raw.observedAt === "string" && !Number.isNaN(Date.parse(raw.observedAt)) ? new Date(raw.observedAt).toISOString() : null,
    durationMs: nonNegInt(raw.durationMs),
    requests,
    aiHosts,
    firebaseHosts: hostList(raw.firebaseHosts),
    otherHosts: hostList(raw.otherHosts),
    observers: { fetch: o.fetch === true, xhr: o.xhr === true, resourceTiming: o.resourceTiming === true },
  };
}

/** File content for the receipt export. Built only from the sanitised receipt. */
export function exportReceipt(raw) {
  const receipt = readReceipt(raw);
  if (!receipt) return null;
  const stamp = receipt.observedAt ? receipt.observedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") : "receipt";
  return {
    filename: `hoovik-privacy-receipt-${stamp}.json`,
    mime: "application/json",
    content: JSON.stringify({ ...receipt, blindSpots: [...WITNESS_BLIND_SPOTS] }, null, 2),
  };
}
