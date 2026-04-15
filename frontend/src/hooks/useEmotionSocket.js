import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

export default function useEmotionSocket({ setEmotionsMap }) {
    const socketRef = useRef(null);
    const setEmotionsMapRef = useRef(setEmotionsMap);

    useEffect(() => {
        setEmotionsMapRef.current = setEmotionsMap;
    }, [setEmotionsMap]);

    useEffect(() => {
        const socket = io("https://skymeetai-production.up.railway.app", {
            path: "/emotion-socket/socket.io",
            transports: ["polling", "websocket"],
            withCredentials: true,
            timeout: 20000,
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

        socketRef.current = socket;

        const VALID_EMOTIONS = new Set([
            "angry",
            "fearful",
            "disgust",
            "happy",
            "sad",
            "neutral/calm",
            "neutral",
        ]);

        socket.on("connect", () => {
            console.log("Emotion socket connected:", socket.id);
        });

        socket.on("connect_error", (err) => {
            console.error("Emotion socket error:", err.message);
        });

        socket.on("disconnect", (reason) => {
            console.warn("Emotion socket disconnected:", reason);
        });

        const handleEmotion = (payload) => {
            try {
                const participantId =
                    payload?.participantId ||
                    payload?.participant_id ||
                    payload?.from ||
                    payload?.userId;

                if (!participantId) return;

                const result = payload?.result;
                if (!result) return;

                const labelRaw =
                    result?.emotion ||
                    result?.label ||
                    result?.top ||
                    null;

                const scoreRaw =
                    result?.confidence ??
                    result?.score ??
                    result?.probability ??
                    null;

                if (!labelRaw) return;

                const label = String(labelRaw).toLowerCase().trim();

                if (!VALID_EMOTIONS.has(label)) return;

                const score =
                    typeof scoreRaw === "number"
                        ? scoreRaw
                        : Number(scoreRaw) || 0;

                if (score < 0.01) return;

                setEmotionsMapRef.current((prev) => {
                    const existing = prev[participantId] || [];
                    return {
                        ...prev,
                        [participantId]: [
                            ...existing,
                            {
                                label,
                                score,
                                ts: Date.now(),
                            },
                        ].slice(-20),
                    };
                });
            } catch (err) {
                console.error("Emotion parse error:", err);
            }
        };

        socket.on("emotion.result", handleEmotion);
        socket.on("emotion.update", handleEmotion);
        socket.on("emotion", handleEmotion);

        return () => {
            socket.off("emotion.result", handleEmotion);
            socket.off("emotion.update", handleEmotion);
            socket.off("emotion", handleEmotion);
            socket.disconnect();
        };
    }, []);

    return socketRef;
}