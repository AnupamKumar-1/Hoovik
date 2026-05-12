import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";


export default function useEmotionSocket({ setEmotionsMap, updateParticipantMediaState }) {
    const poolRef = useRef(new Map()); // pid → { socket, connected }
    const setEmotionsMapRef = useRef(setEmotionsMap);
    const serverCapsRef = useRef({ targetFps: 5, suggestedFps: null, modalityStaleSec: 3 });

    useEffect(() => {
        setEmotionsMapRef.current = setEmotionsMap;
    }, [setEmotionsMap]);

    const VALID_EMOTIONS = new Set([
        "angry", "fearful", "disgust", "happy", "sad", "neutral/calm", "neutral",
    ]);

    const handleEmotion = useCallback((payload) => {
        try {
            const participantId =
                payload?.participantId ||
                payload?.participant_id ||
                payload?.from ||
                payload?.userId;
            if (!participantId) return;

            const result = payload?.result;
            if (!result) return;

            const labelRaw = result?.emotion || result?.label || result?.top;
            if (!labelRaw) return;

            const label = String(labelRaw).toLowerCase().trim();
            if (!VALID_EMOTIONS.has(label)) return;

            const scoreRaw = result?.confidence ?? result?.score ?? result?.probability;
            const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw) || 0;
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
                            modality: result?.modality ?? null,
                            anomaly: result?.anomaly ?? false,
                        },
                    ].slice(-20),
                };
            });
        } catch (err) {
            console.error("[EmotionSocket] parse error:", err);
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps


    function _createSocket(participantId) {
        const socket = io(process.env.REACT_APP_EMOTION_SOCKET_URL, {
            path: "/socket.io",
            transports: ["websocket"],
            timeout: 20000,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            auth: { participantId },
        });

        socket.on("connect", () => {
            const entry = poolRef.current.get(participantId);
            if (entry) entry.connected = true;
            console.log(`[EmotionSocket] connected pid=${participantId} sid=${socket.id}`);
        });

        socket.on("connect_error", (err) => {
            console.warn(`[EmotionSocket] connect_error pid=${participantId}:`, err.message);
        });

        socket.on("disconnect", (reason) => {
            const entry = poolRef.current.get(participantId);
            if (entry) entry.connected = false;
            console.warn(`[EmotionSocket] disconnected pid=${participantId}:`, reason);
        });

        socket.on("server.status", (payload) => {
            try {
                const fps = Number(payload?.targetFps);
                const staleSec = Number(payload?.modalityStaleSec);
                if (fps > 0) {
                    serverCapsRef.current.targetFps = fps;
                    serverCapsRef.current.suggestedFps = null;
                }
                if (staleSec > 0) serverCapsRef.current.modalityStaleSec = staleSec;
            } catch { /* ignore */ }
        });

        socket.on("backpressure", (payload) => {
            try {
                const suggested = Number(payload?.suggestedFps);
                if (suggested > 0) serverCapsRef.current.suggestedFps = suggested;
            } catch { /* ignore */ }
        });

        socket.on("emotion.error", (payload) => {
            console.warn(`[EmotionSocket] emotion.error pid=${participantId}:`, payload?.code);
        });

        socket.on("emotion.result", handleEmotion);

        return socket;
    }


    const ensureSocket = useCallback((participantId) => {
        if (!participantId) return null;
        if (poolRef.current.has(participantId)) {
            return poolRef.current.get(participantId).socket;
        }
        const socket = _createSocket(participantId);
        poolRef.current.set(participantId, { socket, connected: false });
        return socket;
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /** Return existing socket (or null if not created). */
    const getSocketForParticipant = useCallback((participantId) => {
        return poolRef.current.get(participantId)?.socket ?? null;
    }, []);

    const releaseSocket = useCallback((participantId) => {
        const entry = poolRef.current.get(participantId);
        if (!entry) return;
        try {
            entry.socket.off("emotion.result", handleEmotion);
            entry.socket.disconnect();
        } catch { /* ignore */ }
        poolRef.current.delete(participantId);
        console.log(`[EmotionSocket] released pid=${participantId}`);
    }, [handleEmotion]);

    /**

     * @param {string}  participantId
     * @param {{ micEnabled: boolean, cameraEnabled: boolean }} state
     */
    const notifyMediaState = useCallback((participantId, { micEnabled, cameraEnabled }) => {
        if (!participantId) return;

        let socket = poolRef.current.get(participantId)?.socket ?? null;

        if (!socket?.connected) {

            for (const [, entry] of poolRef.current) {
                if (entry?.socket?.connected) {
                    socket = entry.socket;
                    break;
                }
            }
        }

        if (!socket?.connected) {
            return;
        }

        socket.emit("participant.media_state", {
            participantId,
            micEnabled: Boolean(micEnabled),
            cameraEnabled: Boolean(cameraEnabled),
        });

        updateParticipantMediaState?.(participantId, { micEnabled, cameraEnabled });

        console.log(
            `[EmotionSocket] media_state pid=${participantId} mic=${micEnabled} cam=${cameraEnabled}`
        );
    }, []);

    // Teardown all on unmount
    useEffect(() => {
        return () => {
            for (const [pid] of poolRef.current) {
                releaseSocket(pid);
            }
        };
    }, [releaseSocket]);

    return {
        ensureSocket,
        getSocketForParticipant,
        releaseSocket,
        notifyMediaState,
        serverCapsRef,
        poolRef,
    };
}