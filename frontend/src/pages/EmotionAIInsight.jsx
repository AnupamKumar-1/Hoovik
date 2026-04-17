import React, { useMemo } from "react";
import styles from "../styles/videoComponent.module.css";
import { formatTopEmotion } from "./emotionHelpers";

const NEGATIVE = ["sad", "angry", "fearful", "disgust"];

export default function EmotionAIInsight({ emotionsMap, participantsMeta }) {
    const insight = useMemo(() => {
        const rows = Object.entries(emotionsMap || {});
        if (rows.length === 0) return null;

        const now = Date.now();
        const WINDOW_MS = 30000;

        let total = 0;
        let negative = 0;
        const participantStates = [];

        rows.forEach(([pid, history]) => {
            if (!Array.isArray(history) || history.length === 0) return;

            const meta = participantsMeta.find((p) => p.id === pid);
            const name =
                meta?.meta?.name ||
                meta?.meta?.displayName ||
                (pid ? `User-${pid.slice(0, 4)}` : "Unknown");

            const recent = history.filter((e) => now - e.ts <= WINDOW_MS);
            if (recent.length === 0) return;

            let localCounts = {};
            let localScore = 0;

            recent.forEach((e) => {
                const t = formatTopEmotion(e);
                if (!t) return;

                localCounts[t.label] = (localCounts[t.label] || 0) + 1;
                localScore += t.score;

                total++;
                if (NEGATIVE.includes(t.label)) negative++;
            });

            const dominant = Object.entries(localCounts).sort(
                (a, b) => b[1] - a[1]
            )[0]?.[0];

            const avgScore = localScore / recent.length;

            participantStates.push({
                name,
                dominant,
                avgScore,
            });
        });

        if (participantStates.length === 0) return "Analyzing emotional signals...";

        const negRatio = total > 0 ? negative / total : 0;

        const strongNegative = participantStates.filter(
            (p) => NEGATIVE.includes(p.dominant) && p.avgScore > 0.65
        );

        const strongPositive = participantStates.filter(
            (p) => p.dominant === "happy" && p.avgScore > 0.65
        );

        if (strongNegative.length >= 2) {
            return `${strongNegative.length} participants showing sustained ${strongNegative[0].dominant} over the last few moments. Consider adjusting the conversation.`;
        }

        if (strongNegative.length === 1) {
            return `${strongNegative[0].name} shows consistent ${strongNegative[0].dominant} signals. Might be worth checking in.`;
        }

        if (strongPositive.length >= 2 && negRatio < 0.2) {
            return "Group appears engaged and positive. Interaction is flowing well.";
        }

        const unique = new Set(participantStates.map((p) => p.dominant));
        if (unique.size >= 3) {
            return "Emotional signals are mixed across participants. Conversation dynamics may be shifting.";
        }

        if (negRatio < 0.25) {
            return "Overall emotional state appears stable and neutral.";
        }

        return "Monitoring emotional trends in real time.";
    }, [emotionsMap, participantsMeta]);

    if (!insight) return null;

    return (
        <div className={styles.emotionInsightCard}>
            <div className={styles.emotionInsightLabel}>✦ AI Insight</div>
            <div className={styles.emotionInsightText}>{insight}</div>
        </div>
    );
}