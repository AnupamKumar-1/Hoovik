import React from "react";
import styles from "../styles/videoComponent.module.css";
import { renderEmojiLabelForEmotion, EMOJI_MAP } from "./emotionHelpers";

const MAX_TIMELINE_DOTS = 8;

export default function EmotionServicePanel({
  emotionsMap,
  participantsMeta,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
}) {
  if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return null;

  const rows = Object.entries(emotionsMap || {});

  if (rows.length === 0) {
    return (
      <div className={styles.emotionPanel} role="region" aria-label="Emotion stream">
        <div className={styles.emotionStreamHeader}>
          <EmotionIcon />
          <span>Emotion Timeline</span>
        </div>
        <p className={styles.emotionEmpty}>Waiting for emotion data…</p>
      </div>
    );
  }

  return (
    <div className={styles.emotionPanel} role="region" aria-label="Emotion stream">
      <div className={styles.emotionStreamHeader}>
        <EmotionIcon />
        <span>Emotion Timeline</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map(([pid, history]) => {
          const safeHistory = Array.isArray(history) ? history : [];
          if (safeHistory.length === 0) return null;

          const meta = participantsMeta.find((p) => p.id === pid);
          const displayName =
            meta?.meta?.name ||
            meta?.meta?.displayName ||
            meta?.meta?.userName ||
            meta?.meta?.username ||
            (pid ? `User-${pid.slice(0, 4)}` : "Unknown");

          const latest = safeHistory[safeHistory.length - 1];
          const currentLabel = renderEmojiLabelForEmotion(latest) || "—";
          const timeline = safeHistory.slice(-MAX_TIMELINE_DOTS);

          const isPositive = /happy|joy|surprise/i.test(latest?.label || "");
          const isNegative = /sad|angry|fear|disgust/i.test(latest?.label || "");
          const badgeClass = isPositive
            ? styles.emotionBadgePositive
            : isNegative
              ? styles.emotionBadgeNegative
              : styles.emotionBadgeNeutral;

          return (
            <div
              key={pid}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 5,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                paddingBottom: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <div
                  className={styles.emotionAvatar}
                  aria-hidden="true"
                  title={displayName}
                >
                  {displayName[0]?.toUpperCase() || "?"}
                </div>

                <div
                  style={{
                    flex: 1,
                    fontSize: "0.8em",
                    fontWeight: 600,
                    color: "var(--vm-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={displayName}
                >
                  {displayName}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {latest?.label && (
                    <span className={`${styles.emotionBadge} ${badgeClass}`}>
                      {latest.label}
                    </span>
                  )}
                  <span
                    className={styles.emotionEmoji}
                    aria-label={latest?.label || "emotion"}
                  >
                    {currentLabel}
                  </span>
                </div>
              </div>

              {timeline.length > 1 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    paddingLeft: 34,
                    flexWrap: "wrap",
                  }}
                  aria-label="Emotion history"
                >
                  {timeline.map((entry, i) => {
                    const emoji = EMOJI_MAP[entry?.label?.toLowerCase()] || "🫥";
                    const isLast = i === timeline.length - 1;
                    const opacity = 0.35 + (i / (timeline.length - 1)) * 0.65;
                    return (
                      <span
                        key={i}
                        title={`${entry.label || "unknown"} — ${new Date(entry.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}`}
                        style={{
                          fontSize: isLast ? "1.1em" : "0.82em",
                          opacity,
                          transition: "opacity 0.3s",
                          cursor: "default",
                          lineHeight: 1,
                        }}
                        aria-hidden="true"
                      >
                        {emoji}
                      </span>
                    );
                  })}
                  <span
                    style={{
                      fontSize: "0.62em",
                      opacity: 0.4,
                      marginLeft: 2,
                      color: "var(--vm-muted-bright)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {safeHistory.length} samples
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmotionIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}