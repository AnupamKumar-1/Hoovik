import React, { useMemo, useRef } from "react";
import styles from "../styles/videoComponent.module.css";
import { formatTopEmotion } from "./emotionHelpers";

const EMOTION_BAR_COLORS = {
    angry: "#ef4444",
    fearful: "#f5a623",
    disgust: "#a78bfa",
    happy: "#3fcf8e",
    sad: "#4d9fff",
    "neutral/calm": "rgba(255,255,255,0.3)",
    neutral: "rgba(255,255,255,0.3)",
};

export default function EmotionGroupSummary({ emotionsMap }) {
    const prevRef = useRef(null);

    const { rows, trend } = useMemo(() => {
        const WINDOW_MS = 30000;
        const now = Date.now();

        const totals = {};
        let total = 0;

        Object.values(emotionsMap || {}).forEach((history) => {
            if (!Array.isArray(history)) return;

            const recent = history.filter((e) => now - e.ts <= WINDOW_MS);

            recent.forEach((e) => {
                const t = formatTopEmotion(e);
                if (t?.label) {
                    totals[t.label] = (totals[t.label] ?? 0) + 1;
                    total++;
                }
            });
        });

        if (total === 0) return { rows: [], trend: null };

        const rows = Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([label, count]) => ({
                label,
                pct: Math.round((count / total) * 100),
                color: EMOTION_BAR_COLORS[label] ?? "rgba(255,255,255,0.3)",
            }));

        let trend = null;

        if (rows.length > 0) {
            const dominant = rows[0].label;
            const dominantPct = rows[0].pct;

            if (prevRef.current) {
                const prev = prevRef.current;

                if (prev.label !== dominant) {
                    trend = `Group mood shifting from ${prev.label} to ${dominant}`;
                } else if (dominantPct > prev.pct + 10) {
                    trend = `${dominant} signals increasing`;
                } else if (dominantPct < prev.pct - 10) {
                    trend = `${dominant} signals decreasing`;
                }
            }

            prevRef.current = {
                label: dominant,
                pct: dominantPct,
            };
        }

        return { rows, trend };
    }, [emotionsMap]);

    if (rows.length === 0) return null;

    return (
        <div className={styles.emotionGroupCard}>
            <div className={styles.emotionGroupTitle}>
                Group Mood (last 30s)
            </div>

            {trend && (
                <div className={styles.emotionTrend}>
                    {trend}
                </div>
            )}

            <div className={styles.emotionBarsSection}>
                {rows.map(({ label, pct, color }) => (
                    <div key={label} className={styles.emotionBarRow}>
                        <span className={styles.emotionBarLabel}>
                            {label.charAt(0).toUpperCase() + label.slice(1)}
                        </span>

                        <div className={styles.emotionBarTrack}>
                            <div
                                className={styles.emotionBarFill}
                                style={{
                                    width: `${pct}%`,
                                    background: color,
                                    transition: "width 0.3s ease",
                                }}
                            />
                        </div>

                        <span className={styles.emotionBarPct}>{pct}%</span>
                    </div>
                ))}
            </div>
        </div>
    );
}