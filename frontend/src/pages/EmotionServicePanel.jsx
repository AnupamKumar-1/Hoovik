import React from "react";
import styles from "../styles/videoComponent.module.css";
import { renderEmojiLabelForEmotion } from "./emotionHelpers";


export default function EmotionServicePanel({
  emotionsMap,
  participantsMeta,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
}) {
  if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return null;

  const rows = Object.entries(emotionsMap || {});

  return (
    <div className={styles.emotionPanel} role="region" aria-label="Emotion stream">

      {/* Header */}
      <div className={styles.emotionStreamHeader}>
        <EmotionIcon />
        <span>Emotion Stream</span>
      </div>

      {/* Empty state */}
      {rows.length === 0 ? (
        <p className={styles.emotionEmpty}>
          Waiting for emotion data…
        </p>
      ) : (
        <div>
          {rows.map(([pid, em]) => {
            const nameFromEmotion =
              em?.__name ??
              em?.name ??
              em?.displayName ??
              em?.display_name;

            const meta = participantsMeta.find((p) => p.id === pid);
            const nameFromMeta =
              meta?.meta?.name ??
              meta?.meta?.displayName;

            const displayName =
              nameFromEmotion ??
              nameFromMeta ??
              (pid ? pid.slice(0, 6) : "Unknown");

            const emojiLabel = renderEmojiLabelForEmotion(em) || "—";
            const textLabel = em?.label || "";

            const isPositive = /happy|joy|surprise/i.test(textLabel);
            const isNegative = /sad|angry|fear|disgust/i.test(textLabel);

            const badgeClass = isPositive
              ? styles.emotionBadgePositive
              : isNegative
                ? styles.emotionBadgeNegative
                : styles.emotionBadgeNeutral;

            return (
              <div key={pid} className={styles.emotionRow}>

                {/* Avatar initial */}
                <div className={styles.emotionAvatar} aria-hidden="true">
                  {displayName[0]?.toUpperCase() || "?"}
                </div>

                {/* Name */}
                <div className={styles.emotionName} title={displayName}>
                  {displayName}
                </div>

                {/* Badge + emoji */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {textLabel && (
                    <span className={`${styles.emotionBadge} ${badgeClass}`}>
                      {textLabel}
                    </span>
                  )}
                  <span className={styles.emotionEmoji} aria-label={textLabel || "emotion"}>
                    {emojiLabel}
                  </span>
                </div>

              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Emotion smiley icon ── */
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