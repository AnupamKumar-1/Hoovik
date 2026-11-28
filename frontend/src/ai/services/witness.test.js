import { describe, it, expect, vi } from "vitest";
import {
  HOST_RULES, REQUEST_CLASSES as C, VERDICTS as V, WITNESS_BLIND_SPOTS, RECEIPT_VERSION,
  buildReceipt, classifyUrl, createWitness, decideVerdict, describeVerdict, exportReceipt, parseRequestUrl, readReceipt,
} from "./witness.js";
import { MODES, POLICIES } from "./policy.js";

const ORIGIN = "https://app.test";
const AI = "https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent";
const classify = (u, o = {}) => classifyUrl(u, { origin: ORIGIN, ...o });

// A fake browser window: fetch, XMLHttpRequest, performance and PerformanceObserver.
function makeWin({ observer = true, xhr = true, fetch = true } = {}) {
  let t = 1000;
  const win = { location: { origin: ORIGIN, href: `${ORIGIN}/` }, performance: { now: () => t }, observers: [], tick: (ms) => { t += ms; } };
  if (fetch) {
    win.fetch = vi.fn(async () => ({ ok: true }));
    win.originalFetch = win.fetch;
  }
  if (xhr) {
    win.XMLHttpRequest = function FakeXHR() {};
    win.XMLHttpRequest.prototype.open = vi.fn(function open(method, url) {
      this.opened = [method, url];
      return "opened";
    });
    win.originalOpen = win.XMLHttpRequest.prototype.open;
  }
  if (observer) {
    win.PerformanceObserver = class FakePO {
      constructor(cb) {
        this.cb = cb;
        this.pending = [];
        this.disconnected = false;
        win.observers.push(this);
      }
      observe(opts) { this.opts = opts; }
      takeRecords() { const p = this.pending; this.pending = []; return p; }
      disconnect() { this.disconnected = true; }
      deliver(entries) { this.cb({ getEntries: () => entries }); }
    };
  }
  return win;
}
const entry = (url, startTime = 1001) => ({ name: url, startTime });

describe("parseRequestUrl", () => {
  it("keeps only host, origin and a query-free key", () => {
    const p = parseRequestUrl("https://Example.COM/a/b?key=SECRET#frag");
    expect(p).toEqual({ host: "example.com", origin: "https://example.com", key: "https://example.com/a/b" });
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });
  it("accepts URL objects and Request-like objects", () => {
    expect(parseRequestUrl(new URL("https://a.test/x")).host).toBe("a.test");
    expect(parseRequestUrl({ url: "https://b.test/y" }).host).toBe("b.test");
  });
  it("resolves relative URLs against a base", () => {
    expect(parseRequestUrl("/api/x", `${ORIGIN}/page`).origin).toBe(ORIGIN);
  });
  it("is null for non-network URLs and flags unreadable values", () => {
    expect(parseRequestUrl("data:text/plain;base64,AAAA")).toBeNull();
    expect(parseRequestUrl("blob:https://app.test/uuid")).toBeNull();
    for (const bad of [undefined, null, "", 42, {}, "/relative-without-base"]) expect(parseRequestUrl(bad)).toEqual({ unparseable: true });
  });
});

describe("classifyUrl", () => {
  it("classifies generative-AI endpoints", () => {
    for (const u of [AI, "https://generativelanguage.googleapis.com/v1/x", "https://us-central1-aiplatform.googleapis.com/v1/x", "https://aiplatform.googleapis.com/v1/x", "https://api.groq.com/openai/v1/chat", "https://api.openai.com/v1/x"]) {
      expect(classify(u).cls, u).toBe(C.AI);
    }
  });
  it("classifies Firebase and App Check housekeeping", () => {
    for (const u of ["https://firebaseinstallations.googleapis.com/v1/projects/p/installations", "https://content-firebaseappcheck.googleapis.com/v1/projects/p:exchange", "https://www.google.com/recaptcha/enterprise.js", "https://securetoken.googleapis.com/v1/token"]) {
      expect(classify(u).cls, u).toBe(C.FIREBASE);
    }
  });
  it("classifies this app by origin and by configured own hosts", () => {
    expect(classify(`${ORIGIN}/assets/a.js`).cls).toBe(C.SAME_ORIGIN);
    expect(classify("/api/v1/transcripts", { base: `${ORIGIN}/x` }).cls).toBe(C.SAME_ORIGIN);
    expect(classify("https://api.hoovik.test/v1/x", { ownHosts: ["API.hoovik.test"] }).cls).toBe(C.SAME_ORIGIN);
    expect(classify("https://api.hoovik.test/v1/x").cls).toBe(C.OTHER);
  });
  it("sends everything else to other", () => {
    expect(classify("https://fonts.googleapis.com/css").cls).toBe(C.OTHER);
    expect(classify("https://cdn.example.net/x.js").host).toBe("cdn.example.net");
  });
  it("does not accept look-alike hosts", () => {
    for (const u of [
      "https://firebasevertexai.googleapis.com.evil.example/v1/x",
      "https://evilfirebasevertexai.googleapis.com.example/x",
      "https://notfirebasevertexai.googleapis.com/x",
      "https://firebasevertexai.googleapis.com@evil.example/x",
      "https://evil.example/firebasevertexai.googleapis.com/x",
      "https://us-central1-aiplatform.googleapis.com.evil.example/x",
      "https://firebaseinstallations.googleapis.com.evil.example/x",
    ]) {
      expect(classify(u).cls, u).toBe(C.OTHER);
    }
  });
  it("still recognises a real AI host with odd casing, a trailing dot or a port", () => {
    expect(classify("https://FirebaseVertexAI.GoogleAPIs.com./v1/x").cls).toBe(C.AI);
    expect(classify("https://firebasevertexai.googleapis.com:443/v1/x").cls).toBe(C.AI);
    expect(classify("wss://firebasevertexai.googleapis.com/ws").cls).toBe(C.AI);
  });
  it("lets the AI list win when a host is in several lists", () => {
    const rules = { ai: { hosts: ["both.test"], hostSuffixes: [] }, firebase: { hosts: ["both.test"] } };
    expect(classify("https://both.test/x", { rules }).cls).toBe(C.AI);
  });
  it("ignores non-network URLs and counts unreadable ones as other", () => {
    expect(classify("data:text/plain,hi")).toBeNull();
    expect(classify(undefined)).toMatchObject({ cls: C.OTHER, host: "unparseable" });
  });
  it("keeps every host list in one frozen place", () => {
    expect(Object.isFrozen(HOST_RULES)).toBe(true);
    expect(HOST_RULES.ai.hosts).toContain("firebasevertexai.googleapis.com");
  });
});

describe("observation window", () => {
  it("captures requests inside the window and excludes those before start and after stop", async () => {
    const win = makeWin();
    await win.fetch(`${ORIGIN}/before`);
    const w = createWitness({ win }).start();
    await win.fetch(AI);
    await win.fetch("https://cdn.example.net/x.js");
    const obs = w.stop();
    await win.fetch(AI);
    expect(obs.counts).toEqual({ total: 2, sameOrigin: 0, firebase: 0, ai: 1, other: 1 });
    expect(obs.hosts).toEqual({ firebase: [], ai: ["firebasevertexai.googleapis.com"], other: ["cdn.example.net"] });
    expect(obs.methods).toEqual({ fetch: true, xhr: true, resourceTiming: true });
    expect(win.fetch).toBe(win.originalFetch); // wrapper removed
    expect(win.XMLHttpRequest.prototype.open).toBe(win.originalOpen);
  });

  it("passes arguments and results through unchanged", async () => {
    const win = makeWin();
    win.fetch.mockResolvedValue("RESULT");
    const w = createWitness({ win }).start();
    const init = { method: "POST", body: "BODY" };
    await expect(win.fetch(`${ORIGIN}/x`, init)).resolves.toBe("RESULT");
    expect(win.originalFetch).toHaveBeenCalledWith(`${ORIGIN}/x`, init);
    w.stop();
  });

  it("propagates a rejected fetch untouched", async () => {
    const win = makeWin();
    win.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const w = createWitness({ win }).start();
    await expect(win.fetch(AI)).rejects.toThrow("Failed to fetch");
    expect(w.stop().counts.ai).toBe(1); // a request that failed was still attempted
  });

  it("never breaks a request when recording fails", async () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    const hostile = { get url() { throw new Error("boom"); } };
    await expect(win.fetch(hostile)).resolves.toEqual({ ok: true });
    expect(w.stop().counts.total).toBe(0);
  });

  it("observes XMLHttpRequest.open with this and the return value intact", () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    const x = new win.XMLHttpRequest();
    expect(x.open("POST", AI, true)).toBe("opened");
    expect(x.opened).toEqual(["POST", AI]);
    expect(w.stop().counts.ai).toBe(1);
  });

  it("counts a request seen by both the wrapper and Resource Timing once, and timing-only requests too", async () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    await win.fetch(AI);
    win.observers[0].deliver([entry(AI), entry(`${ORIGIN}/assets/chunk-1.js`)]);
    const obs = w.stop();
    expect(obs.counts).toMatchObject({ ai: 1, sameOrigin: 1, total: 2 });
  });

  it("uses the larger of the two counts per URL", async () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    await win.fetch(AI);
    await win.fetch(`${AI}?second=1`); // same origin and path, different query
    win.observers[0].deliver([entry(AI)]);
    expect(w.stop().counts.ai).toBe(2);
  });

  it("ignores timing entries that started before the window and flushes pending records at stop", () => {
    const win = makeWin();
    win.tick(500);
    const w = createWitness({ win }).start();
    win.observers[0].pending.push(entry("https://late.example/x", 1600), entry("https://early.example/x", 900));
    const obs = w.stop();
    expect(obs.hosts.other).toEqual(["late.example"]);
    expect(win.observers[0].disconnected).toBe(true);
    expect(win.observers[0].opts).toEqual({ type: "resource" });
  });

  it("measures duration from the window's own clock and stamps the start", () => {
    const win = makeWin();
    const w = createWitness({ win, clock: () => Date.parse("2026-11-28T10:00:00.000Z") }).start();
    win.tick(1234.6);
    const obs = w.stop();
    expect(obs.durationMs).toBe(1235);
    expect(obs.startedAt).toBe("2026-11-28T10:00:00.000Z");
  });

  it("is idempotent: a second stop returns the same observation", () => {
    const w = createWitness({ win: makeWin() }).start();
    expect(w.stop()).toBe(w.stop());
  });

  it("handles nested and concurrent windows, each seeing only its own period", async () => {
    const win = makeWin();
    const witness = createWitness({ win });
    const a = witness.start();
    await win.fetch("https://one.example/1");
    const b = witness.start();
    await win.fetch("https://two.example/2");
    const aObs = a.stop();
    expect(win.fetch).not.toBe(win.originalFetch); // b still needs the wrapper
    await win.fetch("https://three.example/3");
    const bObs = b.stop();
    expect(aObs.hosts.other).toEqual(["one.example", "two.example"]);
    expect(bObs.hosts.other).toEqual(["three.example", "two.example"]);
    expect(win.fetch).toBe(win.originalFetch);
  });

  it("does not double count after something else wrapped fetch on top of the witness", async () => {
    const win = makeWin();
    const witness = createWitness({ win });
    const w1 = witness.start();
    const ours = win.fetch;
    const other = vi.fn((...a) => ours(...a));
    win.fetch = other; // e.g. a mocking library installed after us
    await win.fetch("https://one.example/1");
    expect(w1.stop().counts.total).toBe(1);
    await win.fetch("https://after.example/x"); // goes through the inert wrapper
    const w2 = witness.start();
    await win.fetch("https://two.example/2");
    expect(w2.stop().counts.total).toBe(1);
  });

  it("works with whatever the environment offers", async () => {
    const noObserver = makeWin({ observer: false });
    const w = createWitness({ win: noObserver }).start();
    await noObserver.fetch(AI);
    const obs = w.stop();
    expect(obs.methods).toEqual({ fetch: true, xhr: true, resourceTiming: false });
    expect(obs.counts.ai).toBe(1);

    const bare = makeWin({ fetch: false, xhr: false, observer: false });
    expect(createWitness({ win: bare }).start().stop().methods).toEqual({ fetch: false, xhr: false, resourceTiming: false });

    const noPerf = makeWin();
    delete noPerf.performance;
    expect(createWitness({ win: noPerf }).start().stop().durationMs).toBe(0);
  });

  it("falls back to the wrapper when the PerformanceObserver cannot be used", async () => {
    const win = makeWin();
    win.PerformanceObserver = class { constructor() { throw new Error("unsupported"); } };
    const w = createWitness({ win }).start();
    await win.fetch(AI);
    const obs = w.stop();
    expect(obs.methods.resourceTiming).toBe(false);
    expect(obs.counts.ai).toBe(1);
  });

  it("survives an observer that fails while stopping", async () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    await win.fetch(AI);
    win.observers[0].takeRecords = () => { throw new Error("gone"); };
    expect(w.stop().counts.ai).toBe(1);
  });

  it("returns an empty observation without a window, and never throws on a broken one", () => {
    const empty = createWitness({ win: null }).start().stop();
    expect(empty.counts.total).toBe(0);
    expect(empty.methods).toEqual({ fetch: false, xhr: false, resourceTiming: false });
    const broken = makeWin();
    Object.defineProperty(broken, "performance", { get() { throw new Error("no"); } });
    expect(createWitness({ win: broken }).start().stop().counts.total).toBe(0);
  });

  it("works against the default window", () => {
    const obs = createWitness().start().stop();
    expect(obs.counts.total).toBe(0);
  });

  it("classifies own-server requests as this app", async () => {
    const win = makeWin();
    const w = createWitness({ win, ownHosts: ["api.hoovik.test"] }).start();
    await win.fetch("https://api.hoovik.test/api/v1/transcripts");
    expect(w.stop().counts).toMatchObject({ sameOrigin: 1, other: 0 });
  });

  it("caps host lists and keeps only host names, never URLs or query strings", async () => {
    const win = makeWin();
    const w = createWitness({ win }).start();
    for (let i = 0; i < 15; i++) await win.fetch(`https://h${String(i).padStart(2, "0")}.example/p?key=SECRET-CANARY`);
    await win.fetch(`${AI}?key=SECRET-CANARY`);
    const obs = w.stop();
    expect(obs.hosts.other).toHaveLength(10);
    expect(JSON.stringify(obs)).not.toMatch(/SECRET-CANARY|\/p\?|generateContent/);
  });
});

describe("decideVerdict", () => {
  const ok = { fetch: true, xhr: true, resourceTiming: true };
  const counts = (ai = 0) => ({ total: ai, sameOrigin: 0, firebase: 0, ai, other: 0 });
  const verdict = (o) => decideVerdict({ status: "done", source: "on-device", mode: MODES.ONLY_ON_DEVICE, policy: POLICIES.LOCAL_ONLY, counts: counts(), methods: ok, ...o });

  it("local run with zero AI requests is verified local", () => {
    expect(verdict({})).toBe(V.LOCAL_VERIFIED);
  });
  it("any AI request under a local expectation is a violation", () => {
    expect(verdict({ counts: counts(1) })).toBe(V.VIOLATION);
    expect(verdict({ policy: POLICIES.ASK_BEFORE_CLOUD, counts: counts(2) })).toBe(V.VIOLATION);
    expect(verdict({ status: "failed", source: null, counts: counts(1) })).toBe(V.VIOLATION);
    expect(verdict({ policy: POLICIES.LOCAL_ONLY, mode: null, source: null, status: "failed", counts: counts(1) })).toBe(V.VIOLATION);
  });
  it("a cloud result with AI requests is the cloud verdict", () => {
    expect(verdict({ source: "cloud", mode: MODES.ONLY_IN_CLOUD, policy: POLICIES.CLOUD_ONLY, counts: counts(1) })).toBe(V.CLOUD);
  });
  it("a cloud result with no AI request observed is inconclusive, not local", () => {
    expect(verdict({ source: "cloud", mode: MODES.ONLY_IN_CLOUD, policy: POLICIES.CLOUD_ONLY })).toBe(V.INCONCLUSIVE);
    expect(verdict({ source: null, mode: MODES.PREFER_ON_DEVICE, policy: POLICIES.AUTO_FALLBACK })).toBe(V.INCONCLUSIVE);
  });
  it("without any working observer nothing can be confirmed", () => {
    expect(verdict({ methods: { fetch: false, xhr: false, resourceTiming: false } })).toBe(V.INCONCLUSIVE);
    expect(verdict({ methods: undefined })).toBe(V.INCONCLUSIVE);
  });
  it("one working observer is enough to measure", () => {
    expect(verdict({ methods: { fetch: false, xhr: false, resourceTiming: true } })).toBe(V.LOCAL_VERIFIED);
  });
  it("runs that produced no analysis say what was observed", () => {
    const base = { status: "unsupported", source: null, mode: MODES.ONLY_IN_CLOUD, policy: POLICIES.CLOUD_ONLY };
    expect(verdict({ ...base })).toBe(V.NO_AI_REQUESTS);
    expect(verdict({ ...base, counts: counts(1) })).toBe(V.CLOUD);
    expect(verdict({ ...base, status: "consent-required", mode: MODES.ONLY_ON_DEVICE, policy: POLICIES.ASK_BEFORE_CLOUD })).toBe(V.NO_AI_REQUESTS);
  });
  it("tolerates missing counts", () => {
    expect(decideVerdict({ status: "done", source: "on-device", methods: ok })).toBe(V.LOCAL_VERIFIED);
  });
});

describe("describeVerdict", () => {
  it("writes plain language for every verdict", () => {
    const counts = { ai: 1 };
    expect(describeVerdict(V.LOCAL_VERIFIED)).toMatch(/on this device/i);
    expect(describeVerdict(V.VIOLATION, { counts, aiHosts: ["a.test"] })).toBe("Expected on-device inference, but 1 request to AI services was observed (a.test).");
    expect(describeVerdict(V.VIOLATION, { counts: { ai: 3 } })).toMatch(/3 requests to AI services were observed \(unknown host\)/);
    expect(describeVerdict(V.CLOUD, { status: "done", counts: { ai: 2 }, aiHosts: ["a.test", "b.test"] })).toBe("Sent to a cloud AI service (a.test, b.test). 2 requests observed.");
    expect(describeVerdict(V.CLOUD, { status: "failed", counts, aiHosts: ["a.test"] })).toMatch(/no usable result/);
    expect(describeVerdict(V.NO_AI_REQUESTS)).toMatch(/No analysis was produced/);
    expect(describeVerdict(V.INCONCLUSIVE)).toMatch(/could not confirm/);
    expect(describeVerdict("nonsense")).toMatch(/could not confirm/);
    expect(describeVerdict(V.VIOLATION)).toMatch(/0 requests/);
  });
});

describe("buildReceipt", () => {
  const observation = (over = {}) => ({
    methods: { fetch: true, xhr: true, resourceTiming: true },
    durationMs: 812,
    startedAt: "2026-11-28T10:00:00.000Z",
    counts: { total: 3, sameOrigin: 1, firebase: 2, ai: 0, other: 0 },
    hosts: { firebase: ["content-firebaseappcheck.googleapis.com"], ai: [], other: [] },
    ...over,
  });

  it("local run: verified, with the counts and what was observed", () => {
    const r = buildReceipt({ observation: observation(), policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on_device", status: "done" });
    expect(r).toMatchObject({
      version: RECEIPT_VERSION, verdict: V.LOCAL_VERIFIED, policy: "local-only", mode: "only_on_device", source: "on-device", status: "done",
      observedAt: "2026-11-28T10:00:00.000Z", durationMs: 812, requests: { total: 3, sameOrigin: 1, firebase: 2, ai: 0, other: 0 },
      aiHosts: [], firebaseHosts: ["content-firebaseappcheck.googleapis.com"], otherHosts: [], observers: { fetch: true, xhr: true, resourceTiming: true },
    });
    expect(r.verdictText).toBe(describeVerdict(V.LOCAL_VERIFIED));
  });

  it("any AI request under a local policy is a violation", () => {
    const r = buildReceipt({
      observation: observation({ counts: { total: 1, sameOrigin: 0, firebase: 0, ai: 1, other: 0 }, hosts: { firebase: [], ai: ["firebasevertexai.googleapis.com"], other: [] } }),
      policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done",
    });
    expect(r.verdict).toBe(V.VIOLATION);
    expect(r.verdictText).toContain("firebasevertexai.googleapis.com");
  });

  it("cloud run: the cloud verdict names the host", () => {
    const r = buildReceipt({
      observation: observation({ counts: { total: 1, sameOrigin: 0, firebase: 0, ai: 1, other: 0 }, hosts: { firebase: [], ai: ["firebasevertexai.googleapis.com"], other: [] } }),
      policy: POLICIES.ASK_BEFORE_CLOUD, mode: MODES.ONLY_IN_CLOUD, source: "in_cloud", status: "done",
    });
    expect(r).toMatchObject({ verdict: V.CLOUD, source: "cloud" });
    expect(r.verdictText).toMatch(/Sent to a cloud AI service \(firebasevertexai\.googleapis\.com\)/);
  });

  it("a missing observation gives an inconclusive receipt", () => {
    const r = buildReceipt({ observation: null, policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done" });
    expect(r.verdict).toBe(V.INCONCLUSIVE);
    expect(r.observers).toEqual({ fetch: false, xhr: false, resourceTiming: false });
    expect(r.observedAt).toBeNull();
  });

  it("does not trust odd inputs", () => {
    const r = buildReceipt({ observation: observation(), policy: "yolo", mode: "mode-x", source: "somewhere", status: "Not A Status!" });
    expect(r).toMatchObject({ policy: null, mode: null, source: null, status: null });
  });

  it("holds no URLs, bodies, transcript text or speaker names", () => {
    const r = buildReceipt({ observation: observation(), policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done" });
    expect(JSON.stringify(r)).not.toMatch(/https?:\/\/|body|transcript|speaker/i);
  });

  // Mirrors the server's receipt limits (clientSummary.utils.js): depth 3, 40 keys, 300-char strings, 4000 bytes.
  it("fits the server's receipt limits even in the worst case", () => {
    const hosts = Array.from({ length: 10 }, (_, i) => `${"x".repeat(55)}${i}.example`);
    const r = buildReceipt({
      observation: observation({ counts: { total: 99, sameOrigin: 9, firebase: 30, ai: 30, other: 30 }, hosts: { firebase: hosts, ai: hosts, other: hosts } }),
      policy: POLICIES.AUTO_FALLBACK, mode: MODES.PREFER_ON_DEVICE, source: "cloud", status: "consent-required",
    });
    const walk = (v, depth, f) => {
      f(v, depth);
      if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1, f));
      else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => { f(k, depth, true); walk(x, depth + 1, f); });
    };
    let maxObjectDepth = 0;
    walk(r, 0, (v, d, isKey) => {
      if (isKey) return expect(v.length).toBeLessThanOrEqual(40);
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(300);
      if (v && typeof v === "object") {
        maxObjectDepth = Math.max(maxObjectDepth, d);
        expect(Object.keys(v).length).toBeLessThanOrEqual(40);
      }
    });
    expect(maxObjectDepth).toBeLessThanOrEqual(2);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThan(4000);
  });
});

describe("readReceipt", () => {
  const good = () => buildReceipt({
    observation: { methods: { fetch: true, xhr: false, resourceTiming: true }, durationMs: 50, startedAt: "2026-11-28T10:00:00.000Z", counts: { total: 1, sameOrigin: 1, firebase: 0, ai: 0, other: 0 }, hosts: { firebase: [], ai: [], other: [] } },
    policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done",
  });

  it("round-trips a receipt built here", () => {
    expect(readReceipt(good())).toEqual(good());
  });
  it("rejects anything without a known verdict", () => {
    for (const bad of [undefined, null, "x", 5, [], {}, { verdict: "great" }, { verdict: 3 }]) expect(readReceipt(bad)).toBeNull();
  });
  it("coerces numbers and lists and ignores stored wording", () => {
    const r = readReceipt({
      verdict: V.LOCAL_VERIFIED, verdictText: "Totally private, trust us", requests: { total: -4, ai: "9", sameOrigin: 2.7, firebase: NaN, other: Infinity },
      aiHosts: ["ok.test", 5, "", null], otherHosts: "nope", firebaseHosts: Array.from({ length: 30 }, (_, i) => `h${i}.test`),
      observers: { fetch: "yes", xhr: true }, observedAt: "not a date", durationMs: -1, policy: "x", mode: "y", source: "mars", status: "bad status", version: "2",
    });
    expect(r.requests).toEqual({ total: 0, sameOrigin: 2, firebase: 0, ai: 0, other: 0 });
    expect(r.verdictText).toBe(describeVerdict(V.LOCAL_VERIFIED));
    expect(r.aiHosts).toEqual(["ok.test"]);
    expect(r.otherHosts).toEqual([]);
    expect(r.firebaseHosts).toHaveLength(10);
    expect(r.observers).toEqual({ fetch: false, xhr: true, resourceTiming: false });
    expect(r).toMatchObject({ observedAt: null, durationMs: 0, policy: null, mode: null, source: null, status: null, version: RECEIPT_VERSION });
  });
  it("tolerates a receipt with no requests or observers block", () => {
    expect(readReceipt({ verdict: V.INCONCLUSIVE }).requests.total).toBe(0);
  });
});

describe("exportReceipt", () => {
  it("is null for an unusable receipt", () => {
    expect(exportReceipt(null)).toBeNull();
  });
  it("exports only the sanitised receipt plus the blind spots", () => {
    const raw = { verdict: V.LOCAL_VERIFIED, observedAt: "2026-11-28T10:00:00.000Z", requests: { total: 1 }, transcript: "CANARY transcript text", note: "CANARY" };
    const f = exportReceipt(raw);
    expect(f.filename).toBe("hoovik-privacy-receipt-20261128T100000Z.json");
    expect(f.mime).toBe("application/json");
    const parsed = JSON.parse(f.content);
    expect(parsed.verdict).toBe(V.LOCAL_VERIFIED);
    expect(parsed.blindSpots).toEqual([...WITNESS_BLIND_SPOTS]);
    expect(f.content).not.toContain("CANARY");
  });
  it("uses a neutral file name without a timestamp", () => {
    expect(exportReceipt({ verdict: V.INCONCLUSIVE }).filename).toBe("hoovik-privacy-receipt-receipt.json");
  });
});
