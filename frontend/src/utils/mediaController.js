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

function _ctx() {
  return { localStream, pcsRef, localVideoEl, localMirrorEnabled, socketRef, externalCleaners };
}

function _safeEmit(event, payload) {
  try {
    if (!socketRef) return;
    socketRef.emit?.(event, payload);
  } catch { }
}

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

export function setLocalStream(stream) {
  localStream = stream ?? null;
  if (!localVideoEl) return;
  try {
    if (!_placeholderStream) {
      localVideoEl.srcObject = localStream ?? null;
      safePlay(localVideoEl);
    }
    enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
  } catch (err) {
    console.warn("[mediaController] setLocalStream: failed to update preview:", err);
  }
  if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
}

export function setVideoElement(videoEl) {
  localVideoEl = videoEl ?? null;
  if (!localVideoEl) return;
  try {
    localVideoEl.autoplay = true;
    localVideoEl.playsInline = true;
    localVideoEl.muted = true;
    if (!_placeholderStream) localVideoEl.srcObject = localStream ?? null;
    enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
    safePlay(localVideoEl);
  } catch (err) {
    console.warn("[mediaController] setVideoElement: attach failed:", err);
  }
  if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
}

export function initMediaController(stream, socket, peerConnections = {}, videoElement = null) {
  if (localStream && localStream !== stream) {
    console.warn("[mediaController] re-initializing with a different stream — previous state overwritten");
  }
  localStream = stream ?? null;
  socketRef = socket ?? null;
  pcsRef = peerConnections ?? {};
  localVideoEl = videoElement ?? null;

  if (process.env.NODE_ENV !== "production") {
    window.__MEDIA_CTRL = {
      getLocalStream: () => localStream,
      stopAll: stopAllVideoAndCleanup,
      forceRelease: forceReleaseEverything,
    };
  }

  if (localVideoEl) {
    try {
      localVideoEl.autoplay = true;
      localVideoEl.playsInline = true;
      localVideoEl.muted = true;
      if (!_placeholderStream) localVideoEl.srcObject = localStream ?? null;
      enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
      safePlay(localVideoEl);
    } catch (err) {
      console.warn("[mediaController] initMediaController: localVideoEl attach failed:", err);
    }
    if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
  }
}

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
    if (stream?.getVideoTracks().length > 0) {
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
      if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
      return true;
    }

    let acquired;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("[mediaController] toggleAudio: getUserMedia(audio) failed:", err);
      return currentMuted;
    }

    const newTrack = acquired.getAudioTracks()[0];
    if (!newTrack) {
      acquired.getTracks().forEach(t => { try { t.stop(); } catch { } });
      return currentMuted;
    }

    try {
      await replaceTrackInPeers(newTrack, "audio", { pcsRef, localStream });
      replaceLocalTrack(newTrack, "audio", _ctx());
      _safeEmit("update-participant-state", { muted: false });
      if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
      return false;
    } catch (err) {
      console.warn("[mediaController] toggleAudio: attach failed:", err);
      try { newTrack.stop(); } catch { }
      return currentMuted;
    } finally {
      acquired.getTracks().forEach(t => {
        const present = localStream?.getTracks().some(lt => lt.id === t.id);
        if (!present) try { t.stop(); } catch { }
      });
    }
  } finally {
    togglingAudio = false;
  }
}

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

async function _turnVideoOff({ usePlaceholder }) {
  if (_placeholderTrack) {
    stopAndCleanupPlaceholder(_placeholderTrack);
    _placeholderTrack = null;
    _placeholderStream = null;
  }

  _placeholderTrack = createPlaceholderVideoTrack();
  _placeholderStream = _placeholderTrack?.__placeholderStream ?? null;

  if (_placeholderStream && localVideoEl) {
    syncPreview({ localVideoEl, localStream: null, placeholderStream: _placeholderStream, localMirrorEnabled });
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
    localStream.getVideoTracks?.().forEach(t => {
      try { t.stop(); } catch { }
      try { localStream.removeTrack(t); } catch { }
    });
  } catch { }

  runExternalCleaners("video", { externalCleaners, localStream });

  if (isSafari()) {
    clearPreviewIfNoTracks({ localStream, localVideoEl });
    refreshSafariPreview({ localVideoEl, localStream, placeholderStream: _placeholderStream, localMirrorEnabled });
  }

  _safeEmit("update-participant-state", { video: false });
  return true;
}

async function _turnVideoOn(currentVideoOff) {
  let acquired = null;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    console.warn("[mediaController] toggleVideo ON: getUserMedia failed:", err);
    return currentVideoOff;
  }

  const newTrack = acquired.getVideoTracks()[0];
  if (!newTrack) {
    acquired.getTracks().forEach(t => { try { t.stop(); } catch { } });
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

    await replaceTrackInPeers(newTrack, "video", { pcsRef, localStream });

    Object.values(pcsRef ?? {}).forEach(pc => {
      try {
        pc.getTransceivers?.().forEach(tx => {
          try {
            if (tx.kind === "video" || tx.sender?.track?.kind === "video") {
              try { tx.direction = "sendrecv"; } catch { }
            }
          } catch { }
        });
      } catch { }
    });

    try {
      if (localStream?.getAudioTracks?.().length > 0) {
        try {
          localStream.addTrack(newTrack);
          attachTrackEndHandler(newTrack, "video", _ctx());
          setLocalStream(localStream);
        } catch {
          const merged = new MediaStream([...localStream.getAudioTracks(), newTrack]);
          attachTrackEndHandler(newTrack, "video", _ctx());
          localStream = merged;
          setLocalStream(localStream);
        }
      } else {
        const merged = new MediaStream([newTrack]);
        attachTrackEndHandler(newTrack, "video", _ctx());
        localStream = merged;
        setLocalStream(localStream);
      }
    } catch (err) {
      console.warn("[mediaController] toggleVideo ON: attach to localStream failed:", err);
      try { newTrack.stop(); } catch { }
      return currentVideoOff;
    }

    if (localVideoEl) {
      try {
        localVideoEl.srcObject = null;
        localVideoEl.srcObject = localStream;
        enforceVideoMirrorBehavior(localVideoEl, { mirror: !!localMirrorEnabled });
        safePlay(localVideoEl);
      } catch { }
    }

    if (isSafari()) refreshSafariPreview({ localVideoEl, localStream, placeholderStream: null, localMirrorEnabled });

    _safeEmit("update-participant-state", { video: true });
    return false;
  } catch (err) {
    console.warn("[mediaController] toggleVideo ON: failed:", err);
    try { newTrack.stop(); } catch { }
    return currentVideoOff;
  } finally {
    acquired.getTracks().forEach(t => {
      const present = localStream?.getTracks().some(lt => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

async function _safariMicSwap() {
  if (!localStream?.getAudioTracks?.().length) return;
  let acquired = null;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    const micTrack = acquired.getAudioTracks()[0];
    if (micTrack) {
      await replaceTrackInPeers(micTrack, "audio", { pcsRef, localStream });
      replaceLocalTrack(micTrack, "audio", _ctx());
    }
  } catch (err) {
    console.warn("[mediaController] Safari mic swap failed (non-fatal):", err);
  } finally {
    acquired?.getTracks().forEach(t => {
      const present = localStream?.getTracks().some(lt => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

function _stopAllVideoTracks() {
  try {
    localStream?.getVideoTracks?.().forEach(t => {
      if (!t.__isPlaceholder) try { t.stop(); } catch { }
    });
  } catch { }
  try {
    document.querySelectorAll("video").forEach(el => {
      try {
        el.srcObject?.getVideoTracks?.().forEach(t => {
          if (!t.__isPlaceholder) try { t.stop(); } catch { }
        });
        if (el.srcObject !== localStream && el.srcObject !== _placeholderStream) {
          try { el.srcObject = null; } catch { }
        }
      } catch { }
    });
  } catch { }
  try {
    Object.values(pcsRef ?? {}).forEach(pc => {
      pc.getSenders?.().forEach(s => {
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

export function forceReleaseEverything() {
  try {
    Object.values(pcsRef ?? {}).forEach(pc => {
      try {
        pc.getSenders?.().forEach(s => {
          try {
            if (s?.track?.kind === "video") {
              try { s.track.stop(); } catch { }
              try { s.replaceTrack(null); } catch { }
            }
          } catch { }
        });
        try { pc.close(); } catch { }
      } catch { }
    });
  } catch { }

  runExternalCleaners("video", { externalCleaners, localStream });

  try {
    document.querySelectorAll("video").forEach(el => {
      try {
        el.srcObject?.getTracks?.().forEach(t => {
          try { if (t.kind === "video") t.stop(); } catch { }
        });
        try { el.srcObject = null; } catch { }
      } catch { }
    });
  } catch { }
}

export { replaceTrackInPeers, stopOutgoingVideoToPeers, restoreOutgoingVideoToPeers, stopAndRemoveTracks };