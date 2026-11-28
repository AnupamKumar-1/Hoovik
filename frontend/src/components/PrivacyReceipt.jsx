import React from "react";
import "../styles/privacy-receipt.css";
import { POLICY_INFO } from "../ai/services/policy.js";
import { VERDICTS, WITNESS_BLIND_SPOTS, exportReceipt, readReceipt } from "../ai/services/witness.js";

// Wording is deliberately a measurement, never a guarantee. Colour is never the only signal:
// each verdict has its own glyph and badge text.
const BADGES = {
  [VERDICTS.LOCAL_VERIFIED]: { glyph: "✓", label: "Stayed on this device" },
  [VERDICTS.NO_AI_REQUESTS]: { glyph: "○", label: "Nothing sent to AI" },
  [VERDICTS.CLOUD]: { glyph: "↗", label: "Sent to the cloud" },
  [VERDICTS.VIOLATION]: { glyph: "!", label: "Check failed" },
  [VERDICTS.INCONCLUSIVE]: { glyph: "?", label: "Could not confirm" },
};
const SOURCE_LABEL = { "on-device": "This device", cloud: "Cloud (Google Gemini)" };

const stamp = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "Not recorded");
const observerList = (o) => {
  const names = [o.fetch && "fetch", o.xhr && "XMLHttpRequest", o.resourceTiming && "Resource Timing"].filter(Boolean);
  return names.length ? names.join(", ") : "none available";
};

/** Save the receipt as a JSON file. Returns false when there is no usable receipt. */
export function downloadReceipt(raw, { doc = document, urlApi = URL } = {}) {
  const file = exportReceipt(raw);
  if (!file) return false;
  const href = urlApi.createObjectURL(new Blob([file.content], { type: file.mime }));
  const a = doc.createElement("a");
  a.href = href;
  a.download = file.filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => urlApi.revokeObjectURL(href), 0);
  return true;
}

function HostList({ title, hosts }) {
  if (!hosts.length) return null;
  return (
    <div className="pr-hosts">
      <div className="pr-hosts-title">{title}</div>
      <ul>{hosts.map((h) => <li key={h}>{h}</li>)}</ul>
    </div>
  );
}

/** Shows what the network witness measured while a summary was made. `receipt` is provenance.receipt. */
export default function PrivacyReceipt({ receipt }) {
  const r = readReceipt(receipt);
  if (!r) return null;
  const badge = BADGES[r.verdict];
  const fact = (label, value, key) => (
    <div className="pr-fact" key={key ?? label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

  return (
    <section className={`pr-card pr-card--${r.verdict}`} aria-label="Privacy receipt" data-verdict={r.verdict}>
      <div className="tv-card-label pr-label">PRIVACY RECEIPT</div>
      <div className="pr-head">
        <span className={`pr-badge pr-badge--${r.verdict}`}>
          <span aria-hidden="true" className="pr-glyph">{badge.glyph}</span>
          {badge.label}
        </span>
      </div>
      <p className="pr-verdict">{r.verdictText}</p>
      <p className="pr-note">Measured inside this page; not a guarantee.</p>

      <dl className="pr-facts">
        {fact("Policy", r.policy ? POLICY_INFO[r.policy].label : "Not recorded")}
        {fact("Ran on", r.source ? SOURCE_LABEL[r.source] : "Not reported")}
        {fact("Requests to AI services", r.requests.ai)}
        {fact("Firebase and App Check", r.requests.firebase)}
        {fact("This app", r.requests.sameOrigin)}
        {fact("Other hosts", r.requests.other)}
      </dl>

      <details className="pr-details">
        <summary>Details and what this cannot see</summary>
        <dl className="pr-facts">
          {fact("Measured at", stamp(r.observedAt))}
          {fact("Window", `${r.durationMs} ms`)}
          {fact("Observed with", observerList(r.observers))}
        </dl>
        <HostList title="AI service hosts" hosts={r.aiHosts} />
        <HostList title="Firebase and App Check hosts" hosts={r.firebaseHosts} />
        <HostList title="Other hosts" hosts={r.otherHosts} />
        <div className="pr-hosts-title">What this cannot see</div>
        <ul className="pr-blind">
          {WITNESS_BLIND_SPOTS.map((s) => <li key={s}>{s}</li>)}
        </ul>
      </details>

      <button type="button" className="pr-export" onClick={() => downloadReceipt(receipt)}>
        Download receipt (JSON)
      </button>
    </section>
  );
}
