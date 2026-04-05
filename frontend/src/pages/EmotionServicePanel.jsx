import React from "react";
import styles from "../styles/videoComponent.module.css";
import { FaRegComments } from "react-icons/fa";
import { renderEmojiLabelForEmotion } from "./emotionHelpers";

export default function EmotionServicePanel({
  emotionsMap,
  participantsMeta,
  isHost,
  DEBUG_SHOW_EMOTION_FOR_EVERYONE,
}) {
  // hide panel for non-host
  if (!isHost && !DEBUG_SHOW_EMOTION_FOR_EVERYONE) return null;

  const rows = Object.entries(emotionsMap || {});

  return (
    <div className={styles.emotionPanel}>
      <div className={styles.emotionStreamHeader}>
        <FaRegComments /> <span>Emotion Stream</span>
      </div>

      {rows.length === 0 ? (
        <div className={styles.emotionEmpty}>
          No emotion updates yet
        </div>
      ) : (
        rows.map(([pid, em]) => {
          // name resolution
          const nameFromEmotion =
            em?.__name ||
            em?.name ||
            em?.displayName ||
            em?.display_name;

          const meta = participantsMeta.find((p) => p.id === pid);
          const nameFromMeta =
            meta?.meta?.name ||
            meta?.meta?.displayName;

          const displayName =
            nameFromEmotion ||
            nameFromMeta ||
            (pid ? pid.slice(0, 6) : "Unknown");

          const emojiLabel =
            renderEmojiLabelForEmotion(em) || "—";

          const textLabel = em?.label || "";

          console.log("EM PANEL RAW:", em);

          return (
            <div key={pid} className={styles.emotionRow}>
              <div className={styles.emotionName}>
                {displayName}
              </div>

              <div className={styles.emotionEmoji}>
                {textLabel && (
                  <span style={{ marginRight: 6, fontWeight: 500 }}>
                    {textLabel}
                  </span>
                )}
                {emojiLabel}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}