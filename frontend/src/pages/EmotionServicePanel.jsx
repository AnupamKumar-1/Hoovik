import React from "react";
import styles from "../styles/videoComponent.module.css";
import EmotionParticipantCard from "./EmotionParticipantCard";
import EmotionGroupSummary from "./EmotionGroupSummary";
import EmotionAIInsight from "./EmotionAIInsight";

export default function EmotionServicePanel({
  emotionsMap,
  participantsMeta,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE = false,
}) {
  if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return null;

  const rows = Object.entries(emotionsMap || {});

  return (
    <aside className={styles.emotionSidebar} role="region" aria-label="Emotion analysis panel">
      <div className={styles.emotionSidebarHeader}>
        <EmotionIcon />
        <span className={styles.emotionSidebarTitle}>Emotion Timeline</span>
        <span className={styles.emotionSidebarBadge}>LIVE</span>
      </div>

      <div className={styles.emotionSidebarBody}>
        {rows.length === 0 ? (
          <div className={styles.emotionEmpty}>
            <EmotionIcon size={20} />
            <p>Waiting for emotion data…</p>
          </div>
        ) : (
          <>
            <EmotionAIInsight
              emotionsMap={emotionsMap}
              participantsMeta={participantsMeta}
            />

            <div className={styles.emotionSectionHeader}>
              <span className={styles.emotionSectionTitle}>Participants</span>
            </div>

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
              const isParticipantHost = !!meta?.meta?.isHost;
              return (
                <EmotionParticipantCard
                  key={pid}
                  pid={pid}
                  history={safeHistory}
                  displayName={displayName}
                  isHost={isParticipantHost}
                />
              );
            })}

            {rows.length > 1 && (
              <EmotionGroupSummary emotionsMap={emotionsMap} />
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function EmotionIcon({ size = 12 }) {
  return (
    <svg
      width={size}
      height={size}
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