import React, { useMemo } from "react";
import styles from "../styles/videoComponent.module.css";
import { renderEmojiLabelForEmotion, EMOJI_MAP, formatTopEmotion } from "./emotionHelpers";

const AVATAR_COLORS = [
    { bg: "rgba(245,166,35,0.15)", color: "#f5a623", border: "rgba(245,166,35,0.3)" },
    { bg: "rgba(77,159,255,0.15)", color: "#4d9fff", border: "rgba(77,159,255,0.3)" },
    { bg: "rgba(0,229,195,0.12)", color: "#00e5c3", border: "rgba(0,229,195,0.3)" },
    { bg: "rgba(255,95,109,0.1)", color: "#ff5f6d", border: "rgba(255,95,109,0.2)" },
    { bg: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "rgba(167,139,250,0.3)" },
    { bg: "rgba(63,207,142,0.12)", color: "#3fcf8e", border: "rgba(63,207,142,0.3)" },
];

function getAvatarColor(initial) {
    const idx = (initial?.charCodeAt(0) ?? 0) % AVATAR_COLORS.length;
    return AVATAR_COLORS[idx];
}

const EMOTION_BAR_COLORS = {
    angry: "#ef4444",
    fearful: "#f5a623",
    disgust: "#a78bfa",
    happy: "#3fcf8e",
    sad: "#4d9fff",
    "neutral/calm": "rgba(255,255,255,0.3)",
    neutral: "rgba(255,255,255,0.3)",
};

const PILL_STYLES = {
    happy: { bg: "rgba(63,207,142,0.12)", color: "#3fcf8e" },
    sad: { bg: "rgba(77,159,255,0.12)", color: "#4d9fff" },
    angry: { bg: "rgba(239,68,68,0.12)", color: "#ef4444" },
    fearful: { bg: "rgba(245,166,35,0.12)", color: "#f5a623" },
    disgust: { bg: "rgba(167,139,250,0.12)", color: "#a78bfa" },
    "neutral/calm": { bg: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.55)" },
    neutral: { bg: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.55)" },
};

function TrendBars({ history, color }) {
    if (!history || history.length < 2) return null;
    const vals = history.slice(-8).map((e) => {
        const t = formatTopEmotion(e);
        return t ? Math.round((t.score ?? 0) * 100) : 0;
    });
    const max = Math.max(...vals, 1);
    return (
        <div className={styles.emotionTrendBars}>
            {vals.map((v, i) => (
                <div
                    key={i}
                    className={styles.emotionTrendBar}
                    style={{
                        height: `${Math.max(12, Math.round((v / max) * 100))}%`,
                        background: color,
                        opacity: 0.3 + (i / (vals.length - 1)) * 0.7,
                    }}
                />
            ))}
        </div>
    );
}

function EmotionBarRow({ label, pct, color }) {
    return (
        <div className={styles.emotionBarRow}>
            <span className={styles.emotionBarLabel}>{label}</span>
            <div className={styles.emotionBarTrack}>
                <div
                    className={styles.emotionBarFill}
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            <span className={styles.emotionBarPct}>{pct}%</span>
        </div>
    );
}

export default function EmotionParticipantCard({ pid, history, displayName, isHost }) {
    const safeHistory = Array.isArray(history) ? history : [];
    const latest = safeHistory[safeHistory.length - 1];

    const top = useMemo(() => formatTopEmotion(latest), [latest]);
    const topLabel = top?.label ?? "";
    const topScore = top ? Math.round((top.score ?? 0) * 100) : 0;
    const emojiLabel = renderEmojiLabelForEmotion(latest);

    const initial = (displayName?.[0] ?? "?").toUpperCase();
    const avatarColor = getAvatarColor(initial);
    const pillStyle = PILL_STYLES[topLabel] ?? PILL_STYLES.neutral;
    const barColor = EMOTION_BAR_COLORS[topLabel] ?? "rgba(255,255,255,0.3)";

    const allLabels = useMemo(() => {
        const counts = {};
        safeHistory.forEach((e) => {
            const t = formatTopEmotion(e);
            if (t?.label) counts[t.label] = (counts[t.label] ?? 0) + (t.score ?? 0);
        });
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([lbl, score]) => ({
                label: lbl,
                pct: Math.round((score / safeHistory.length) * 100),
                color: EMOTION_BAR_COLORS[lbl] ?? "rgba(255,255,255,0.3)",
            }));
    }, [safeHistory]);

    return (
        <div className={styles.emotionCard}>
            <div className={styles.emotionCardHeader}>
                <div
                    className={styles.emotionCardAvatar}
                    style={{
                        background: avatarColor.bg,
                        color: avatarColor.color,
                        border: `1px solid ${avatarColor.border}`,
                    }}
                >
                    {initial}
                </div>
                <div className={styles.emotionCardInfo}>
                    <div className={styles.emotionCardName}>{displayName}</div>
                    <div className={styles.emotionCardSub}>
                        {isHost ? "Host · " : ""}{safeHistory.length} samples
                    </div>
                </div>
                {emojiLabel && (
                    <div
                        className={styles.emotionScorePill}
                        style={{ background: pillStyle.bg, color: pillStyle.color }}
                    >
                        {emojiLabel}
                    </div>
                )}
            </div>

            {allLabels.length > 0 && (
                <div className={styles.emotionBarsSection}>
                    {allLabels.map(({ label, pct, color }) => (
                        <EmotionBarRow key={label} label={label} pct={pct} color={color} />
                    ))}
                </div>
            )}

            <TrendBars history={safeHistory} color={barColor} />
        </div>
    );
}