const PLACEHOLDER_WIDTH = 16;
const PLACEHOLDER_HEIGHT = 12;
const PLACEHOLDER_FPS = 1;
const SAFARI_PREVIEW_REFRESH_DELAY_MS = 16;

export function isSafari() {
    return (
        typeof navigator === "object" &&
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
    );
}

export function safePlay(el) {
    if (!el) return;
    try {
        const p = el.play?.();
        if (p && typeof p.then === "function") p.catch(() => { });
    } catch { }
}

export function enforceVideoMirrorBehavior(el, { mirror = false } = {}) {
    if (!el || typeof el.style === "undefined") return;
    try {
        const val = mirror ? "scaleX(-1)" : "none";
        el.style.transform = val;
        el.style.webkitTransform = val;
    } catch { }
}

export function syncPreview({
    localVideoEl,
    localStream,
    placeholderStream,
    localMirrorEnabled,
}) {
    if (!localVideoEl) return;
    try {
        const src = placeholderStream ?? localStream ?? null;
        if (localVideoEl.srcObject !== src) localVideoEl.srcObject = src;
        enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
        safePlay(localVideoEl);
    } catch { }
}

export function createPlaceholderVideoTrack() {
    try {
        const canvas = Object.assign(document.createElement("canvas"), {
            width: PLACEHOLDER_WIDTH,
            height: PLACEHOLDER_HEIGHT,
        });
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT);
        const stream = canvas.captureStream(PLACEHOLDER_FPS);
        const [track] = stream.getVideoTracks();
        if (!track) return null;
        track.__isPlaceholder = true;
        track.__placeholderCanvas = canvas;
        track.__placeholderStream = stream;
        return track;
    } catch {
        return null;
    }
}

export function stopAndCleanupPlaceholder(track) {
    if (!track) return;
    try { track.stop(); } catch { }
    try {
        if (track.__placeholderCanvas) {
            track.__placeholderCanvas.width = 0;
            track.__placeholderCanvas = null;
        }
    } catch { }
    try {
        if (track.__placeholderStream) {
            track.__placeholderStream.getTracks().forEach((t) => {
                try { t.stop(); } catch { }
            });
            track.__placeholderStream = null;
        }
    } catch { }
}

export function attachTrackEndHandler(
    track,
    kind,
    { socketRef, getLocalStream, localVideoEl, localMirrorEnabled }
) {
    if (!track) return;
    const handler = () => {
        try {
            const stream = typeof getLocalStream === "function" ? getLocalStream() : null;
            const present = stream?.getTracks().some((t) => t.id === track.id);
            if (!present) return;
        } catch { }
        if (kind === "audio") {
            socketRef?.emit?.("update-participant-state", { muted: true });
        } else if (kind === "video") {
            socketRef?.emit?.("update-participant-state", { video: false });
            enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
        }
    };
    try {
        track.addEventListener("ended", handler);
    } catch {
        try { track.onended = handler; } catch { }
    }
}

async function _replaceViaSender(pc, track, kind) {
    const sender = pc.getSenders?.().find((s) => s.track?.kind === kind) ?? null;
    if (!sender) return false;
    await sender.replaceTrack(track);
    return true;
}

async function _replaceViaTransceiver(pc, track, kind) {
    const txs = pc.getTransceivers?.() ?? [];
    const tx =
        txs.find((t) => {
            try {
                return (
                    t.sender?.track?.kind === kind ||
                    t.receiver?.track?.kind === kind ||
                    t.kind === kind
                );
            } catch {
                return false;
            }
        }) ?? null;
    if (!tx) return false;
    try { tx.direction = "sendrecv"; } catch { }
    if (tx.sender && typeof tx.sender.replaceTrack === "function") {
        await tx.sender.replaceTrack(track);
        return true;
    }
    return false;
}

async function _replaceViaNewTransceiver(pc, track, kind) {
    const tx = pc.addTransceiver?.(kind, { direction: "sendrecv" });
    if (!tx?.sender) return false;
    await tx.sender.replaceTrack(track);
    return true;
}

async function _replaceViaAddTrack(pc, track, localStream) {
    if (!track || !localStream) return false;
    const newSender = pc.addTrack(track, localStream);
    const allSenders = pc.getSenders?.() ?? [];
    allSenders.forEach((s) => {
        try {
            if (!s || s === newSender) return;
            if (s.track?.kind === track.kind) {
                try { s.replaceTrack(null); } catch { }
                try { if (!s.track.__isPlaceholder) s.track.stop(); } catch { }
            }
        } catch { }
    });
    return true;
}

async function _nullifyTrackInPeer(pc, kind) {
    try {
        const senders = pc.getSenders?.() ?? [];
        for (const s of senders) {
            try {
                if (s?.track?.kind === kind) {
                    const track = s.track;
                    try { await s.replaceTrack(null); } catch { }
                    try { if (track && !track.__isPlaceholder) track.stop(); } catch { }
                }
            } catch { }
        }
    } catch { }

    try {
        const txs = pc.getTransceivers?.() ?? [];
        for (const tx of txs) {
            try {
                if (tx.kind === kind || tx.sender?.track?.kind === kind) {
                    try { tx.direction = "recvonly"; } catch { }
                }
            } catch { }
        }
    } catch { }
}

export async function replaceTrackInPeers(track, kind, { pcsRef, localStream }) {
    const pcs = Object.values(pcsRef ?? {}).filter(
        (pc) => pc && pc.connectionState !== "closed"
    );
    for (const pc of pcs) {
        try {
            if (track === null) {
                await _nullifyTrackInPeer(pc, kind);
                continue;
            }
            if (await _replaceViaSender(pc, track, kind)) continue;
            if (await _replaceViaTransceiver(pc, track, kind)) continue;
            if (await _replaceViaNewTransceiver(pc, track, kind)) continue;
            await _replaceViaAddTrack(pc, track, localStream);
        } catch { }
    }
}

export async function stopOutgoingVideoToPeers({ pcsRef }) {
    await replaceTrackInPeers(null, "video", { pcsRef, localStream: null });
}

export async function restoreOutgoingVideoToPeers(realTrack, { pcsRef }) {
    if (!realTrack) return;
    await replaceTrackInPeers(realTrack, "video", { pcsRef, localStream: null });
    const pcs = Object.values(pcsRef ?? {}).filter(
        (pc) => pc && pc.connectionState !== "closed"
    );
    for (const pc of pcs) {
        try {
            const txs = pc.getTransceivers?.() ?? [];
            for (const tx of txs) {
                try {
                    if (tx.kind === "video" || tx.sender?.track?.kind === "video") {
                        try { tx.direction = "sendrecv"; } catch { }
                    }
                } catch { }
            }
        } catch { }
    }
}

export function replaceLocalTrack(
    newTrack,
    kind,
    { getLocalStream, localVideoEl, localMirrorEnabled, socketRef }
) {
    const localStream = typeof getLocalStream === "function" ? getLocalStream() : null;
    if (!localStream) {
        try { newTrack?.stop(); } catch { }
        return;
    }
    try {
        localStream
            .getTracks()
            .filter((t) => t.kind === kind)
            .forEach((t) => {
                try { t.stop(); } catch { }
                try { localStream.removeTrack(t); } catch { }
            });
    } catch { }
    try {
        localStream.addTrack(newTrack);
        attachTrackEndHandler(newTrack, kind, {
            socketRef,
            getLocalStream,
            localVideoEl,
            localMirrorEnabled,
        });
    } catch {
        try { newTrack.stop(); } catch { }
        return;
    }
    if (kind === "video") {
        syncPreview({ localVideoEl, localStream, placeholderStream: null, localMirrorEnabled });
    }
    if (isSafari()) {
        refreshSafariPreview({ localVideoEl, localStream, placeholderStream: null, localMirrorEnabled });
    }
}

export function stopAndRemoveTracks(
    kind,
    { localStream, pcsRef, localVideoEl, localMirrorEnabled }
) {
    if (!localStream) return;
    try {
        localStream
            .getTracks()
            .filter((t) => t.kind === kind)
            .forEach((t) => {
                try { t.stop(); } catch { }
                try { localStream.removeTrack(t); } catch { }
            });
    } catch { }

    const pcs = Object.values(pcsRef ?? {}).filter(
        (pc) => pc && pc.connectionState !== "closed"
    );
    for (const pc of pcs) {
        try {
            const txs = pc.getTransceivers?.() ?? [];
            const matched = txs.filter((t) => {
                try {
                    return (
                        t.sender?.track?.kind === kind ||
                        t.receiver?.track?.kind === kind ||
                        t.kind === kind
                    );
                } catch {
                    return false;
                }
            });
            if (matched.length > 0) {
                matched.forEach((t) => {
                    try { t.direction = "recvonly"; } catch { }
                    try { t.sender?.replaceTrack(null); } catch { }
                    try { if (!t.sender?.track?.__isPlaceholder) t.sender?.track?.stop(); } catch { }
                });
                continue;
            }
            pc.getSenders?.()
                .filter((s) => s.track?.kind === kind)
                .forEach((s) => {
                    try { s.replaceTrack(null); } catch { }
                    try { if (!s.track.__isPlaceholder) s.track.stop(); } catch { }
                });
        } catch { }
    }
    if (isSafari()) clearPreviewIfNoTracks({ localStream, localVideoEl });
    enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
}

export function clearPreviewIfNoTracks({ localStream, localVideoEl }) {
    if (!isSafari() || !localStream || !localVideoEl) return;
    try {
        const active = localStream.getTracks().filter((t) => t.readyState === "live");
        if (active.length === 0) {
            try { localVideoEl.srcObject = null; } catch { }
        }
    } catch { }
}

export function refreshSafariPreview({
    localVideoEl,
    localStream,
    placeholderStream,
    localMirrorEnabled,
}) {
    if (!isSafari() || !localVideoEl) return;
    try {
        localVideoEl.srcObject = null;
        const token = setTimeout(() => {
            try {
                const src = placeholderStream ?? localStream ?? null;
                if (localVideoEl.srcObject !== src) localVideoEl.srcObject = src;
                enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
                safePlay(localVideoEl);
            } catch { }
        }, SAFARI_PREVIEW_REFRESH_DELAY_MS);
        return token;
    } catch { }
}

export function runExternalCleaners(kind, { externalCleaners, localStream }) {
    if (kind === "audio") {
        try {
            const ac = externalCleaners.audioContextRef?.current;
            if (ac && typeof ac.close === "function") {
                try { ac.close().catch(() => { }); } catch { }
                try { externalCleaners.audioContextRef.current = null; } catch { }
            }
        } catch { }
        try {
            if (typeof externalCleaners.removeAnalyzerFn === "function") {
                try { externalCleaners.removeAnalyzerFn("audio"); } catch { }
            }
        } catch { }
    }

    try {
        const prev = externalCleaners.prevLocalStreamRef?.current;
        if (prev && typeof prev.getTracks === "function") {
            if (prev !== localStream) {
                prev
                    .getTracks()
                    .filter((t) => !t.__isPlaceholder && t.kind === kind)
                    .forEach((t) => {
                        try { t.stop(); } catch { }
                    });
            }
            try { externalCleaners.prevLocalStreamRef.current = null; } catch { }
        }
    } catch { }
}