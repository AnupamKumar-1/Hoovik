import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import PrivacyReceipt, { downloadReceipt } from "./PrivacyReceipt.jsx";
import TranscriptViewer from "../pages/TranscriptViewer.jsx";
import { buildReceipt, VERDICTS as V, WITNESS_BLIND_SPOTS } from "../ai/services/witness.js";
import { MODES, POLICIES } from "../ai/services/policy.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const obs = (counts = {}, hosts = {}) => ({
  methods: { fetch: true, xhr: true, resourceTiming: true },
  durationMs: 640,
  startedAt: "2026-11-28T10:00:00.000Z",
  counts: { total: 3, sameOrigin: 1, firebase: 2, ai: 0, other: 0, ...counts },
  hosts: { firebase: ["content-firebaseappcheck.googleapis.com"], ai: [], other: [], ...hosts },
});
const local = () => buildReceipt({ observation: obs(), policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done" });
const cloud = () => buildReceipt({ observation: obs({ ai: 1, total: 4 }, { ai: ["firebasevertexai.googleapis.com"] }), policy: POLICIES.ASK_BEFORE_CLOUD, mode: MODES.ONLY_IN_CLOUD, source: "cloud", status: "done" });
const violation = () => buildReceipt({ observation: obs({ ai: 2, total: 5 }, { ai: ["firebasevertexai.googleapis.com"] }), policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done" });
const nothing = () => buildReceipt({ observation: obs(), policy: POLICIES.ASK_BEFORE_CLOUD, mode: MODES.ONLY_ON_DEVICE, source: null, status: "consent-required" });
const inconclusive = () => buildReceipt({ observation: null, policy: POLICIES.LOCAL_ONLY, mode: MODES.ONLY_ON_DEVICE, source: "on-device", status: "done" });

describe("PrivacyReceipt", () => {
  it("renders nothing without a usable receipt", () => {
    for (const bad of [undefined, null, {}, "x", { verdict: "great" }]) {
      const { container, unmount } = render(<PrivacyReceipt receipt={bad} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it.each([
    ["local-verified", local, "Stayed on this device", /No requests to AI services were observed/],
    ["cloud", cloud, "Sent to the cloud", /Sent to a cloud AI service \(firebasevertexai\.googleapis\.com\)/],
    ["violation", violation, "Check failed", /Expected on-device inference, but 2 requests to AI services were observed/],
    ["no-ai-requests", nothing, "Nothing sent to AI", /No analysis was produced/],
    ["inconclusive", inconclusive, "Could not confirm", /could not confirm/],
  ])("renders the %s verdict", (verdict, make, badge, text) => {
    render(<PrivacyReceipt receipt={make()} />);
    const region = screen.getByRole("region", { name: "Privacy receipt" });
    expect(region).toHaveAttribute("data-verdict", verdict);
    expect(within(region).getByText(badge)).toBeInTheDocument();
    expect(within(region).getByText(text)).toBeInTheDocument();
    expect(within(region).getByText("Measured inside this page; not a guarantee.")).toBeInTheDocument();
  });

  it("shows the policy, the source and the request counts", () => {
    render(<PrivacyReceipt receipt={cloud()} />);
    const term = (label) => screen.getAllByText(label)[0].parentElement;
    expect(term("Policy")).toHaveTextContent("Local, ask before cloud");
    expect(term("Ran on")).toHaveTextContent("Cloud (Google Gemini)");
    expect(term("Requests to AI services")).toHaveTextContent("1");
    expect(term("Firebase and App Check")).toHaveTextContent("2");
    expect(term("This app")).toHaveTextContent("1");
    expect(term("Other hosts")).toHaveTextContent("0");
  });

  it("falls back to plain text when the policy or source is not recorded", () => {
    render(<PrivacyReceipt receipt={{ verdict: V.INCONCLUSIVE }} />);
    expect(screen.getByText("Policy").parentElement).toHaveTextContent("Not recorded");
    expect(screen.getByText("Ran on").parentElement).toHaveTextContent("Not reported");
    fireEvent.click(screen.getByText(/Details and what this cannot see/));
    expect(screen.getByText("Measured at").parentElement).toHaveTextContent("Not recorded");
    expect(screen.getByText("Observed with").parentElement).toHaveTextContent("none available");
  });

  it("lists hosts, observers and what the witness cannot see in a collapsible detail view", () => {
    const { container } = render(<PrivacyReceipt receipt={cloud()} />);
    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Details and what this cannot see"));
    expect(details.open).toBe(true);
    expect(screen.getByText("firebasevertexai.googleapis.com")).toBeInTheDocument();
    expect(screen.getByText("content-firebaseappcheck.googleapis.com")).toBeInTheDocument();
    expect(screen.getByText("Measured at").parentElement).toHaveTextContent("2026-11-28 10:00:00 UTC");
    expect(screen.getByText("Window").parentElement).toHaveTextContent("640 ms");
    expect(screen.getByText("Observed with").parentElement).toHaveTextContent("fetch, XMLHttpRequest, Resource Timing");
    for (const spot of WITNESS_BLIND_SPOTS) expect(screen.getByText(spot)).toBeInTheDocument();
    expect(screen.getByText(/browser extensions/i)).toBeInTheDocument();
  });

  it("does not trust stored wording or odd values", () => {
    render(<PrivacyReceipt receipt={{ verdict: V.LOCAL_VERIFIED, verdictText: "SAFE, trust me", requests: { ai: "9" }, aiHosts: ["<img src=x onerror=alert(1)>"] }} />);
    expect(screen.queryByText(/SAFE, trust me/)).toBeNull();
    expect(screen.getByText("Requests to AI services").parentElement).toHaveTextContent("0");
    fireEvent.click(screen.getByText(/Details and what this cannot see/));
    expect(document.querySelector("img")).toBeNull(); // rendered as text, never as markup
  });

  it("has a keyboard-reachable export button with a visible label", () => {
    render(<PrivacyReceipt receipt={local()} />);
    const btn = screen.getByRole("button", { name: "Download receipt (JSON)" });
    expect(btn).toHaveAttribute("type", "button");
    btn.focus();
    expect(btn).toHaveFocus();
  });

  it("the export button downloads the receipt", async () => {
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => "blob:receipt");
    URL.revokeObjectURL = vi.fn();
    const seen = {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      seen.download = this.download;
      seen.href = this.getAttribute("href");
    });
    try {
      render(<PrivacyReceipt receipt={local()} />);
      fireEvent.click(screen.getByRole("button", { name: "Download receipt (JSON)" }));
      expect(seen).toEqual({ download: "hoovik-privacy-receipt-20261128T100000Z.json", href: "blob:receipt" });
      await new Promise((r) => setTimeout(r, 5)); // the object URL is revoked on the next tick
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});

describe("downloadReceipt", () => {
  it("builds a JSON blob from the sanitised receipt and cleans up", () => {
    vi.useFakeTimers();
    const anchor = { click: vi.fn(), remove: vi.fn() };
    const doc = { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } };
    let blob;
    const urlApi = { createObjectURL: vi.fn((b) => { blob = b; return "blob:x"; }), revokeObjectURL: vi.fn() };
    expect(downloadReceipt({ ...local(), transcript: "CANARY text" }, { doc, urlApi })).toBe(true);
    expect(blob.type).toBe("application/json");
    expect(anchor).toMatchObject({ href: "blob:x", download: "hoovik-privacy-receipt-20261128T100000Z.json" });
    expect(doc.body.appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalled();
    expect(anchor.remove).toHaveBeenCalled();
    vi.runAllTimers();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:x");
    vi.useRealTimers();
  });
  it("does nothing for an unusable receipt", () => {
    const urlApi = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };
    expect(downloadReceipt(null, { urlApi })).toBe(false);
    expect(urlApi.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("receipt in the summary panel", () => {
  const segments = [{ speaker: "Ana", text: "We ship Friday.", start: 0, end: 3, emotion: "neutral" }];
  const open = (aiSummary) => {
    render(<TranscriptViewer t={{ _id: "t1", meetingCode: "ABC", metadata: { segments }, aiSummary }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /AI Summary/ }));
  };

  it("shows the receipt under a local summary", () => {
    open({ summary: "We agreed to ship.", provenance: { source: "on-device", receipt: local() } });
    expect(screen.getByText("We agreed to ship.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Privacy receipt" })).toHaveAttribute("data-verdict", "local-verified");
  });

  it("leaves old Groq summaries, and summaries without a receipt, unchanged", () => {
    open({ summary: "Old Groq summary.", key_points: ["One"], insights: {} });
    expect(screen.getByText("Old Groq summary.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Privacy receipt" })).toBeNull();
    cleanup();
    open({ summary: "Local, no receipt.", provenance: { source: "on-device", receipt: null } });
    expect(screen.queryByRole("region", { name: "Privacy receipt" })).toBeNull();
  });
});
