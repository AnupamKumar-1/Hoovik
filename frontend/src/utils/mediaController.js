import {
  isSafari,
  safePlay,
  enforceVideoMirrorBehavior,
  syncPreview,
  createPlaceholderVideoTrack,
  stopAndCleanupPlaceholder,
  attachTrackEndHandler,
  replaceTrackInPeers,
  stopOutgoingVideoToPeers,
  restoreOutgoingVideoToPeers,
  replaceLocalTrack,
  stopAndRemoveTracks,
  clearPreviewIfNoTracks,
  refreshSafariPreview,
  runExternalCleaners,
} from "./mediaControllerUtils";

const TOGGLE_TIMEOUT_MS = 15_000;

// ─── Module-level state ───────────────────────────────────────────────────────
// All state lives here so it survives across React re-renders but is fully
// reset by resetMediaController() on unmount (Bug 2).

let localStream = null;
let socketRef = null;
let pcsRef = {};
let localVideoEl = null;
let localMirrorEnabled = false;
let preferPeerPlaceholder = false;
let togglingAudio = false;
let togglingVideo = false;
let _placeholderTrack = null;
let _placeholderStream = null;

const remoteVideoEls = new Map();

let externalCleaners = {
  recordersRef: null,
  audioContextRef: null,
  removeAnalyzerFn: null,
  prevLocalStreamRef: null,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Bug 9: provide a getter instead of snapshotting localStream at call time,
// so track-end handlers always read the current stream reference.
function _getLocalStream() {
  return localStream;
}

function _ctx() {
  return {
    localStream,
    getLocalStream: _getLocalStream,
    pcsRef,
    localVideoEl,
    localMirrorEnabled,
    socketRef,
    externalCleaners,
  };
}

function _safeEmit(event, payload) {
  try {
    if (!socketRef) return;
    socketRef.emit?.(event, payload);
  } catch { }
}

// Bug 18: wraps a getUserMedia call with an AbortController-backed timeout.
// If the permission dialog is never resolved, the toggle guard is released
// after TOGGLE_TIMEOUT_MS and the UI becomes responsive again.
async function _getUserMediaWithTimeout(constraints) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOGGLE_TIMEOUT_MS);
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return stream;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public setters ───────────────────────────────────────────────────────────

export function setExternalCleaners(refs = {}) {
  externalCleaners.recordersRef = refs.recordersRef ?? null;
  externalCleaners.audioContextRef = refs.audioContextRef ?? null;
  externalCleaners.removeAnalyzerFn = refs.removeAnalyzerFn ?? null;
  externalCleaners.prevLocalStreamRef = refs.prevLocalStreamRef ?? null;
}

export function setPreferPeerPlaceholder(enabled = false) {
  preferPeerPlaceholder = !!enabled;
}

export function setSocketRef(socket) {
  socketRef = socket ?? null;
}

export function setPeerConnections(peerConnections) {
  if (!peerConnections || typeof peerConnections !== "object") {
    pcsRef = {};
    return;
  }
  pcsRef = peerConnections;
}

export function setLocalMirrorEnabled(enabled) {
  localMirrorEnabled = !!enabled;
  enforceVideoMirrorBehavior(localVideoEl, { mirror: localMirrorEnabled });
}

// Bug 3: always use syncPreview so placeholder is never overwritten by a raw
// srcObject assignment racing with an async toggleVideo.
export function setLocalStream(stream) {
  localStream = stream ?? null;
  if (!localVideoEl) return;
  try {
    syncPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  } catch (err) {
    console.warn(
      "[mediaController] setLocalStream: failed to update preview:",
      err
    );
  }
  if (isSafari()) {
    refreshSafariPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }
}

// Bug 16: guard against re-registering the same element so StrictMode double
// invocation and ref re-fires don't interrupt active playback.
export function setVideoElement(videoEl) {
  if (videoEl && videoEl === localVideoEl) return;
  localVideoEl = videoEl ?? null;
  if (!localVideoEl) return;
  try {
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;
    syncPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
    safePlay(localVideoEl);
  } catch (err) {
    console.warn("[mediaController] setVideoElement: attach failed:", err);
  }
  if (isSafari()) {
    refreshSafariPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }
}

// ─── initMediaController ──────────────────────────────────────────────────────
// Bug 1: guard each assignment individually — only overwrite when the value
// has actually changed. This silences the spurious re-init warning that fired
// whenever the parent hook re-ran with the same arguments.

export function initMediaController(
  stream,
  socket,
  peerConnections = {},
  videoElement = null
) {
  const incomingStream = stream ?? null;
  const incomingSocket = socket ?? null;
  const incomingPcs = peerConnections ?? {};
  const incomingEl = videoElement ?? null;

  if (localStream && localStream !== incomingStream) {
    console.warn(
      "[mediaController] re-initializing with a different stream — previous state overwritten"
    );
  }

  if (localStream !== incomingStream) localStream = incomingStream;
  if (socketRef !== incomingSocket) socketRef = incomingSocket;
  if (pcsRef !== incomingPcs) pcsRef = incomingPcs;

  if (process.env.NODE_ENV !== "production") {
    window.__MEDIA_CTRL = {
      getLocalStream: _getLocalStream,
      stopAll: stopAllVideoAndCleanup,
      forceRelease: forceReleaseEverything,
    };
  }

  // Bug 16: re-use setVideoElement's same-element guard
  if (incomingEl !== localVideoEl) {
    setVideoElement(incomingEl);
  } else if (localVideoEl) {
    syncPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
    if (isSafari()) {
      refreshSafariPreview({
        localVideoEl,
        localStream,
        placeholderStream: _placeholderStream,
        localMirrorEnabled,
      });
    }
  }
}

// ─── resetMediaController ─────────────────────────────────────────────────────
// Bug 2: call this from the React hook's cleanup so stale module-level state
// does not leak into a subsequent mount.

export function resetMediaController() {
  if (_placeholderTrack) {
    stopAndCleanupPlaceholder(_placeholderTrack);
    _placeholderTrack = null;
  }
  _placeholderStream = null;
  localStream = null;
  socketRef = null;
  pcsRef = {};
  localVideoEl = null;
  localMirrorEnabled = false;
  preferPeerPlaceholder = false;
  togglingAudio = false;
  togglingVideo = false;
  remoteVideoEls.clear();
  externalCleaners = {
    recordersRef: null,
    audioContextRef: null,
    removeAnalyzerFn: null,
    prevLocalStreamRef: null,
  };
}

// ─── Remote video elements ────────────────────────────────────────────────────

export function registerRemoteVideoElement(peerId, videoEl) {
  if (!peerId || !videoEl) return;
  remoteVideoEls.set(peerId, videoEl);
  try {
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    enforceVideoMirrorBehavior(videoEl, { mirror: false });
  } catch (err) {
    console.warn("[mediaController] registerRemoteVideoElement failed:", err);
  }
}

export function unregisterRemoteVideoElement(peerId) {
  if (!peerId) return;
  try {
    const el = remoteVideoEls.get(peerId);
    if (el) try { el.srcObject = null; } catch { }
  } catch { }
  remoteVideoEls.delete(peerId);
}

export function attachRemoteStream(peerId, stream) {
  const el = remoteVideoEls.get(peerId);
  if (!el) return;
  try {
    const hasVideo =
      typeof stream?.getVideoTracks === "function" &&
      stream.getVideoTracks().length > 0;
    if (hasVideo) {
      el.srcObject = stream;
      el.style.display = "block";
    } else {
      el.srcObject = null;
      el.style.display = "none";
      const ph = document.querySelector(`#placeholder-${peerId}`);
      if (ph) ph.style.display = "flex";
    }
    enforceVideoMirrorBehavior(el, { mirror: false });
  } catch (err) {
    console.warn("[mediaController] attachRemoteStream failed:", err);
  }
}

// ─── toggleAudio ─────────────────────────────────────────────────────────────

export async function toggleAudio(currentMuted) {
  if (togglingAudio) return currentMuted;
  togglingAudio = true;
  try {
    const newMuted = !currentMuted;

    if (!navigator?.mediaDevices || !localStream) {
      _safeEmit("update-participant-state", { muted: newMuted });
      return newMuted;
    }

    if (newMuted) {
      stopAndRemoveTracks("audio", _ctx());
      runExternalCleaners("audio", { externalCleaners, localStream });
      _safeEmit("update-participant-state", { muted: true });
      if (isSafari()) {
        refreshSafariPreview({
          localVideoEl,
          localStream,
          placeholderStream: _placeholderStream,
          localMirrorEnabled,
        });
      }
      return true;
    }

    let acquired;
    try {
      acquired = await _getUserMediaWithTimeout({ audio: true });
    } catch (err) {
      console.warn(
        "[mediaController] toggleAudio: getUserMedia(audio) failed:",
        err
      );
      return currentMuted;
    }

    const newTrack = acquired.getAudioTracks()[0];
    if (!newTrack) {
      acquired.getTracks().forEach((t) => { try { t.stop(); } catch { } });
      return currentMuted;
    }

    try {
      await replaceTrackInPeers(newTrack, "audio", { pcsRef, localStream });
      replaceLocalTrack(newTrack, "audio", _ctx());
      _safeEmit("update-participant-state", { muted: false });
      if (isSafari()) {
        refreshSafariPreview({
          localVideoEl,
          localStream,
          placeholderStream: _placeholderStream,
          localMirrorEnabled,
        });
      }
      return false;
    } catch (err) {
      console.warn("[mediaController] toggleAudio: attach failed:", err);
      try { newTrack.stop(); } catch { }
      return currentMuted;
    } finally {
      acquired.getTracks().forEach((t) => {
        const present = localStream?.getTracks().some((lt) => lt.id === t.id);
        if (!present) try { t.stop(); } catch { }
      });
    }
  } finally {
    togglingAudio = false;
  }
}

// ─── toggleVideo ─────────────────────────────────────────────────────────────

export async function toggleVideo(currentVideoOff, { usePlaceholder = false } = {}) {
  if (togglingVideo) return currentVideoOff;
  togglingVideo = true;
  try {
    const newVideoOff = !currentVideoOff;

    if (!navigator?.mediaDevices || !localStream) {
      _safeEmit("update-participant-state", { video: !newVideoOff });
      return newVideoOff;
    }

    if (newVideoOff) {
      return await _turnVideoOff({ usePlaceholder });
    }

    return await _turnVideoOn(currentVideoOff);
  } finally {
    togglingVideo = false;
  }
}

// ─── _turnVideoOff ────────────────────────────────────────────────────────────

async function _turnVideoOff({ usePlaceholder }) {
  // Bug 17: guard against null localStream
  if (!localStream) {
    _safeEmit("update-participant-state", { video: false });
    return true;
  }

  if (_placeholderTrack) {
    stopAndCleanupPlaceholder(_placeholderTrack);
    _placeholderTrack = null;
    _placeholderStream = null;
  }

  // Bug 4: createPlaceholderVideoTrack may return null — use null (not undefined)
  _placeholderTrack = createPlaceholderVideoTrack();
  _placeholderStream = _placeholderTrack?.__placeholderStream ?? null;

  if (_placeholderStream && localVideoEl) {
    syncPreview({
      localVideoEl,
      localStream: null,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }

  const shouldUsePlaceholder = usePlaceholder || preferPeerPlaceholder;

  if (shouldUsePlaceholder && _placeholderTrack) {
    try {
      await replaceTrackInPeers(_placeholderTrack, "video", { pcsRef, localStream });
    } catch {
      await stopOutgoingVideoToPeers({ pcsRef });
    }
  } else {
    await stopOutgoingVideoToPeers({ pcsRef });
  }

  if (isSafari()) {
    await _safariMicSwap();
  }

  try {
    localStream.getVideoTracks?.().forEach((t) => {
      try { t.stop(); } catch { }
      try { localStream.removeTrack(t); } catch { }
    });
  } catch { }

  runExternalCleaners("video", { externalCleaners, localStream });

  if (isSafari()) {
    clearPreviewIfNoTracks({ localStream, localVideoEl });
    refreshSafariPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }

  _safeEmit("update-participant-state", { video: false });
  return true;
}

// ─── _turnVideoOn ─────────────────────────────────────────────────────────────

async function _turnVideoOn(currentVideoOff) {
  let acquired = null;
  try {
    acquired = await _getUserMediaWithTimeout({ video: true });
  } catch (err) {
    console.warn("[mediaController] toggleVideo ON: getUserMedia failed:", err);
    return currentVideoOff;
  }

  const newTrack = acquired.getVideoTracks()[0];
  if (!newTrack) {
    acquired.getTracks().forEach((t) => { try { t.stop(); } catch { } });
    return currentVideoOff;
  }

  try {
    if (_placeholderTrack) {
      stopAndCleanupPlaceholder(_placeholderTrack);
      _placeholderTrack = null;
    }
    if (_placeholderStream && localVideoEl) {
      try { localVideoEl.srcObject = null; } catch { }
    }
    _placeholderStream = null;

    // Bug 5: build the merged stream BEFORE calling replaceTrackInPeers so the
    // stream reference passed to _replaceViaAddTrack is the final live one.
    let mergedStream;
    try {
      if (localStream?.getAudioTracks?.().length > 0) {
        try {
          localStream.addTrack(newTrack);
          mergedStream = localStream;
        } catch {
          mergedStream = new MediaStream([
            ...localStream.getAudioTracks(),
            newTrack,
          ]);
        }
      } else {
        mergedStream = new MediaStream([newTrack]);
      }
    } catch (err) {
      console.warn(
        "[mediaController] toggleVideo ON: building merged stream failed:",
        err
      );
      try { newTrack.stop(); } catch { }
      return currentVideoOff;
    }

    localStream = mergedStream;
    attachTrackEndHandler(newTrack, "video", _ctx());

    await replaceTrackInPeers(newTrack, "video", { pcsRef, localStream });

    Object.values(pcsRef ?? {})
      .filter((pc) => pc && pc.connectionState !== "closed")
      .forEach((pc) => {
        try {
          pc.getTransceivers?.().forEach((tx) => {
            try {
              if (
                tx.kind === "video" ||
                tx.sender?.track?.kind === "video"
              ) {
                try { tx.direction = "sendrecv"; } catch { }
              }
            } catch { }
          });
        } catch { }
      });

    // Bug 6: use syncPreview once — do not assign srcObject again after this.
    // setLocalStream calls syncPreview internally.
    setLocalStream(localStream);

    if (isSafari()) {
      refreshSafariPreview({
        localVideoEl,
        localStream,
        placeholderStream: null,
        localMirrorEnabled,
      });
    }

    _safeEmit("update-participant-state", { video: true });
    return false;
  } catch (err) {
    console.warn("[mediaController] toggleVideo ON: failed:", err);
    try { newTrack.stop(); } catch { }
    return currentVideoOff;
  } finally {
    acquired.getTracks().forEach((t) => {
      const present = localStream?.getTracks().some((lt) => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

// ─── _safariMicSwap ───────────────────────────────────────────────────────────

async function _safariMicSwap() {
  if (!localStream?.getAudioTracks?.().length) return;
  let acquired = null;
  try {
    acquired = await _getUserMediaWithTimeout({ audio: true });
    const micTrack = acquired.getAudioTracks()[0];
    if (micTrack) {
      await replaceTrackInPeers(micTrack, "audio", { pcsRef, localStream });
      replaceLocalTrack(micTrack, "audio", _ctx());
    }
  } catch (err) {
    console.warn("[mediaController] Safari mic swap failed (non-fatal):", err);
  } finally {
    acquired?.getTracks().forEach((t) => {
      const present = localStream?.getTracks().some((lt) => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

// ─── stopAllVideoAndCleanup ───────────────────────────────────────────────────
// Bug 13: removed document.querySelectorAll("video") — that kills remote streams.
// Only stop the local stream's video tracks and null the local preview element.

function _stopAllVideoTracks() {
  try {
    localStream?.getVideoTracks?.().forEach((t) => {
      if (!t.__isPlaceholder) try { t.stop(); } catch { }
    });
  } catch { }

  if (localVideoEl) {
    try { localVideoEl.srcObject = null; } catch { }
  }

  try {
    Object.values(pcsRef ?? {})
      .filter((pc) => pc && pc.connectionState !== "closed")
      .forEach((pc) => {
        pc.getSenders?.().forEach((s) => {
          try {
            if (s?.track?.kind === "video") {
              try { s.track.stop(); } catch { }
              try { s.replaceTrack(null); } catch { }
            }
          } catch { }
        });
      });
  } catch { }

  try { externalCleaners.removeAnalyzerFn?.("video"); } catch { }
}

export function stopAllVideoAndCleanup() {
  _stopAllVideoTracks();
}

// ─── forceReleaseEverything ───────────────────────────────────────────────────
// Bug 12: delete pcsRef entries after closing so subsequent replaceTrackInPeers
// calls don't iterate closed PCs.

export function forceReleaseEverything() {
  try {
    Object.entries(pcsRef ?? {}).forEach(([peerId, pc]) => {
      try {
        pc.getSenders?.().forEach((s) => {
          try {
            if (s?.track?.kind === "video") {
              try { s.track.stop(); } catch { }
              try { s.replaceTrack(null); } catch { }
            }
          } catch { }
        });
        try { pc.close(); } catch { }
      } catch { }
      delete pcsRef[peerId];
    });
  } catch { }

  runExternalCleaners("video", { externalCleaners, localStream });

  // Bug 13: only null the local preview element, not all <video> in document
  if (localVideoEl) {
    try {
      localStream?.getTracks?.().forEach((t) => {
        try { if (t.kind === "video") t.stop(); } catch { }
      });
      try { localVideoEl.srcObject = null; } catch { }
    } catch { }
  }
}

export {
  replaceTrackInPeers,
  stopOutgoingVideoToPeers,
  restoreOutgoingVideoToPeers,
  stopAndRemoveTracks,
};