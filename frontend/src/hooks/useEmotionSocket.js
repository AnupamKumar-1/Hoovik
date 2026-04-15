import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

export default function useEmotionSocket({ setEmotionsMap }) {
    const socketRef = useRef(null);
    const setEmotionsMapRef = useRef(setEmotionsMap);

    useEffect(() => {
        setEmotionsMapRef.current = setEmotionsMap;
    }, [setEmotionsMap]);

    useEffect(() => {
        const socket = io(process.env.REACT_APP_EMOTION_SOCKET_URL, {
            path: "/socket.io",
            transports: ["websocket"],
            timeout: 20000,
            reconnection: true,
            reconnectionAttempts: Infinity,
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

        socket.io.on("reconnect_attempt", () => {
            console.log("Reconnecting to emotion socket...");
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
                    result?.top;

                if (!labelRaw) return;

                const label = String(labelRaw).toLowerCase().trim();

                if (!VALID_EMOTIONS.has(label)) return;

                const scoreRaw =
                    result?.confidence ??
                    result?.score ??
                    result?.probability;

                const score =
                    typeof scoreRaw === "number"
                        ? scoreRaw
                        : Number(scoreRaw) || 0;

                if (score < 0.05) return;

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

        return () => {
            socket.off("emotion.result", handleEmotion);
            socket.disconnect();
        };
    }, []);

    return socketRef;
}