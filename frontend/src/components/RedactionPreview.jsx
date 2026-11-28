import React, { useState } from "react";
import "../styles/redaction-preview.css";
import { formatTime } from "../ai/services/prepare.js";
import { LEVELS } from "../ai/services/sensitivity.js";

const CATEGORY_LABEL = {
  email: "Email addresses",
  url: "Links",
  money: "Money amounts",
  phone: "Phone numbers",
  id: "Ids and long numbers",
  person: "Names",
  term: "Listed terms",
};
const LEVEL_TEXT = {
  [LEVELS.LOW]: { glyph: "○", label: "Low sensitivity" },
  [LEVELS.MEDIUM]: { glyph: "!", label: "Medium sensitivity" },
  [LEVELS.HIGH]: { glyph: "!!", label: "High sensitivity" },
};

/**
 * What would leave this device if the person approves a cloud run: the original text next to the
 * redacted text, counts by category, and the sensitivity estimate. `preview` comes from
 * buildCloudPreview (or useHybridSummary().cloudPreview). Purely presentational: the buttons that
 * approve or decline belong to the consent dialog that hosts this component.
 */
export default function RedactionPreview({ preview, maxRows = 200 }) {
  const [showAll, setShowAll] = useState(false);
  if (!preview || !Array.isArray(preview.rows)) return null;
  const { rows, summary, sensitivity } = preview;
  const visible = (showAll ? rows : rows.filter((r) => r.changed)).slice(0, maxRows);
  const hidden = (showAll ? rows.length : preview.changedRows) - visible.length;
  const level = LEVEL_TEXT[sensitivity?.level] ?? LEVEL_TEXT[LEVELS.LOW];
  const categories = Object.entries(summary?.byCategory ?? {});

  return (
    <section className="rp-card" aria-label="What will be sent">
      <div className="tv-card-label">WHAT WILL BE SENT</div>

      {sensitivity && (
        <div className={`rp-sensitivity rp-sensitivity--${sensitivity.level}`} data-level={sensitivity.level}>
          <span className="rp-badge">
            <span aria-hidden="true" className="rp-glyph">{level.glyph}</span>
            {level.label}
          </span>
          {sensitivity.level !== LEVELS.LOW && (
            <p className="rp-warning">
              This transcript looks sensitive{sensitivity.reasons.length ? ` (${sensitivity.reasons.join(", ")})` : ""}. Keeping it on this device is the safer choice.
            </p>
          )}
          <p className="rp-note">{preview.sensitivityNote}</p>
        </div>
      )}

      <p className="rp-summary">
        {summary.total === 0
          ? "Nothing was found to remove. The text below is sent as it is."
          : `${summary.total} item${summary.total === 1 ? "" : "s"} replaced with placeholders before sending.`}
      </p>
      {categories.length > 0 && (
        <ul className="rp-counts" aria-label="Replaced by category">
          {categories.map(([c, n]) => (
            <li key={c}><span>{CATEGORY_LABEL[c] ?? c}</span><span className="rp-count">{n}</span></li>
          ))}
        </ul>
      )}
      <p className="rp-note">{preview.note}</p>

      <div className="rp-controls">
        <button type="button" className="rp-toggle" onClick={() => setShowAll((v) => !v)} aria-pressed={showAll}>
          {showAll ? "Show changed lines only" : `Show all ${rows.length} lines`}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="rp-empty">No lines changed.</p>
      ) : (
        <div className="rp-table" role="table" aria-label="Original and redacted text">
          <div className="rp-row rp-row--head" role="row">
            <div role="columnheader">Original (stays here)</div>
            <div role="columnheader">Sent to the cloud</div>
          </div>
          {visible.map((r) => (
            <div className={`rp-row${r.changed ? " rp-row--changed" : ""}`} role="row" key={r.index}>
              <div role="cell" className="rp-cell">
                <span className="rp-time">[{formatTime(r.start)}]</span> <strong>{r.original.speaker}:</strong> {r.original.text}
              </div>
              <div role="cell" className="rp-cell">
                <span className="rp-time">[{formatTime(r.start)}]</span> <strong>{r.redacted.speaker}:</strong> {r.redacted.text}
              </div>
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && <p className="rp-note">{hidden} more line{hidden === 1 ? "" : "s"} not shown.</p>}
    </section>
  );
}
