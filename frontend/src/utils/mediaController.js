import {
  isSafari,
  isMobileBrowser,
  refreshMobilePreview,
  safePlay,
  enforceVideoMirrorBehavior,
  syncPreview,
  createPlaceholderVideoTrack,
  stopAndCleanupPlaceholder,
  attachTrackEndHandler,
  replaceTrackInPeers,
  stopOutgoingVideoToPeers,
  restoreOutgoingVideoToPeers,
  stopAndRemoveTracks,
  clearPreviewIfNoTracks,
  refreshSafariPreview,
  runExternalCleaners,
} from "./mediaControllerUtils";

const TOGGLE_TIMEOUT_MS = 12_000;

let localStream = null;
let socketRef = null;
let pcsRef = {};
let localVideoEl = null;
let localMirrorEnabled = false;
let togglingAudio = false;
let togglingVideo = false;
let _placeholderTrack = null;
let _placeholderStream = null;
let _onLocalStreamChange = null;

const remoteVideoEls = new Map();

let externalCleaners = {
  recordersRef: null,
  audioContextRef: null,
  removeAnalyzerFn: null,
  prevLocalStreamRef: null,
};

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

function _notifyStreamChange(stream) {
  try {
    if (_onLocalStreamChange) _onLocalStreamChange(stream);
  } catch { }
}

function _applyStreamToPreview() {
  if (!localVideoEl) return;
  try {
    syncPreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  } catch { }
  if (isMobileBrowser()) {
    refreshMobilePreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }
}

function _safeEmit(event, payload) {
  try {
    if (!socketRef) return;
    socketRef.emit?.(event, payload);
  } catch { }
}

async function _getUserMediaWithTimeout(constraints) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("getUserMedia timeout")), TOGGLE_TIMEOUT_MS)
  );
  const safeConstraints =
    constraints.audio && !("video" in constraints)
      ? { ...constraints, video: false }
      : constraints;
  return Promise.race([navigator.mediaDevices.getUserMedia(safeConstraints), timeout]);
}

function _getTrack(kind) {
  if (!localStream) return null;
  const tracks = kind === "audio"
    ? localStream.getAudioTracks()
    : localStream.getVideoTracks();
  return tracks[0] ?? null;
}

function _setTransceiversSendrecv() {
  Object.values(pcsRef ?? {})
    .filter((pc) => pc && pc.connectionState !== "closed")
    .forEach((pc) => {
      try {
        pc.getTransceivers?.().forEach((tx) => {
          try {
            if (tx.kind === "video" || tx.sender?.track?.kind === "video") {
              try { tx.direction = "sendrecv"; } catch { }
            }
          } catch { }
        });
      } catch { }
    });
}

function _cleanupPlaceholder() {
  if (_placeholderTrack) {
    stopAndCleanupPlaceholder(_placeholderTrack);
    _placeholderTrack = null;
  }
  _placeholderStream = null;
}

export function setOnLocalStreamChange(cb) {
  _onLocalStreamChange = typeof cb === "function" ? cb : null;
}

export function setExternalCleaners(refs = {}) {
  externalCleaners.recordersRef = refs.recordersRef ?? null;
  externalCleaners.audioContextRef = refs.audioContextRef ?? null;
  externalCleaners.removeAnalyzerFn = refs.removeAnalyzerFn ?? null;
  externalCleaners.prevLocalStreamRef = refs.prevLocalStreamRef ?? null;
}

export function setSocketRef(socket) {
  socketRef = socket ?? null;
}

export function setPeerConnections(peerConnections) {
  pcsRef = peerConnections && typeof peerConnections === "object" ? peerConnections : {};
}

export function setLocalMirrorEnabled(enabled) {
  localMirrorEnabled = !!enabled;
  enforceVideoMirrorBehavior(localVideoEl, { mirror: localMirrorEnabled });
}

export function setLocalStream(stream) {
  localStream = stream ?? null;
  _notifyStreamChange(localStream);
  _applyStreamToPreview();
}

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
  } catch { }
  if (isMobileBrowser()) {
    refreshMobilePreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }
}

export function initMediaController(stream, socket, peerConnections = {}, videoElement = null) {
  localStream = stream ?? null;
  socketRef = socket ?? null;
  pcsRef = peerConnections ?? {};
  if (process.env.NODE_ENV !== "production") {
    window.__MEDIA_CTRL = {
      getLocalStream: _getLocalStream,
      stopAll: stopAllVideoAndCleanup,
      forceRelease: forceReleaseEverything,
    };
  }
  if (videoElement) setVideoElement(videoElement);
}

export function resetMediaController() {
  _cleanupPlaceholder();
  localStream = null;
  socketRef = null;
  pcsRef = {};
  localVideoEl = null;
  localMirrorEnabled = false;
  togglingAudio = false;
  togglingVideo = false;
  _onLocalStreamChange = null;
  remoteVideoEls.clear();
  externalCleaners = {
    recordersRef: null,
    audioContextRef: null,
    removeAnalyzerFn: null,
    prevLocalStreamRef: null,
  };
}

export function registerRemoteVideoElement(peerId, videoEl) {
  if (!peerId || !videoEl) return;
  remoteVideoEls.set(peerId, videoEl);
  try {
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    enforceVideoMirrorBehavior(videoEl, { mirror: false });
  } catch { }
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
  } catch { }
}

export async function toggleAudio(currentMuted) {
  if (togglingAudio) return currentMuted;
  togglingAudio = true;
  try {
    const wantMuted = !currentMuted;

    if (wantMuted) {
      return await _turnAudioOff();
    } else {
      return await _turnAudioOn(currentMuted);
    }
  } finally {
    togglingAudio = false;
  }
}

async function _turnAudioOff() {
  const track = _getTrack("audio");
  if (track) {
    try { track.stop(); } catch { }
    try { localStream?.removeTrack(track); } catch { }
  }

  await replaceTrackInPeers(null, "audio", { pcsRef, localStream });

  runExternalCleaners("audio", { externalCleaners, localStream });

  if (isMobileBrowser()) _applyStreamToPreview();

  _safeEmit("update-participant-state", { muted: true });
  return true;
}

async function _turnAudioOn(currentMuted) {
  let acquired;
  try {
    acquired = await _getUserMediaWithTimeout({ audio: true });
  } catch {
    return currentMuted;
  }

  const newTrack = acquired.getAudioTracks()[0];
  if (!newTrack) {
    acquired.getTracks().forEach((t) => { try { t.stop(); } catch { } });
    return currentMuted;
  }

  try {
    const stale = _getTrack("audio");
    if (stale) {
      try { stale.stop(); } catch { }
      try { localStream?.removeTrack(stale); } catch { }
    }

    if (!localStream) {
      localStream = new MediaStream([newTrack]);
      _notifyStreamChange(localStream);
    } else {
      try {
        localStream.addTrack(newTrack);
      } catch {
        localStream = new MediaStream([...localStream.getVideoTracks(), newTrack]);
        _notifyStreamChange(localStream);
      }
    }

    newTrack.enabled = true;
    attachTrackEndHandler(newTrack, "audio", _ctx());
    await replaceTrackInPeers(newTrack, "audio", { pcsRef, localStream });

    if (isMobileBrowser()) _applyStreamToPreview();

    _safeEmit("update-participant-state", { muted: false });
    return false;
  } catch {
    try { newTrack.stop(); } catch { }
    return currentMuted;
  } finally {
    acquired.getTracks().forEach((t) => {
      const present = localStream?.getTracks().some((lt) => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

export async function toggleVideo(currentVideoOff, { usePlaceholder = false } = {}) {
  if (togglingVideo) return currentVideoOff;
  togglingVideo = true;
  try {
    const wantVideoOff = !currentVideoOff;
    if (!navigator?.mediaDevices) {
      _safeEmit("update-participant-state", { video: !wantVideoOff });
      return wantVideoOff;
    }
    return wantVideoOff
      ? await _turnVideoOff()
      : await _turnVideoOn(currentVideoOff);
  } finally {
    togglingVideo = false;
  }
}

async function _turnVideoOff() {
  const track = _getTrack("video");
  if (track && !track.__isPlaceholder) {
    try { track.stop(); } catch { }
    try { localStream?.removeTrack(track); } catch { }
  }

  _cleanupPlaceholder();

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

  try {
    await replaceTrackInPeers(_placeholderTrack, "video", { pcsRef, localStream });
  } catch {
    await stopOutgoingVideoToPeers({ pcsRef });
  }

  if (isMobileBrowser()) {
    if (isSafari()) await _safariMicSwap();
    clearPreviewIfNoTracks({ localStream, localVideoEl });
    refreshMobilePreview({
      localVideoEl,
      localStream,
      placeholderStream: _placeholderStream,
      localMirrorEnabled,
    });
  }

  runExternalCleaners("video", { externalCleaners, localStream });
  _safeEmit("update-participant-state", { video: false });
  return true;
}

async function _turnVideoOn(currentVideoOff) {
  let acquired = null;
  try {
    acquired = await _getUserMediaWithTimeout({ video: true });
  } catch {
    return currentVideoOff;
  }

  const newTrack = acquired.getVideoTracks()[0];
  if (!newTrack) {
    acquired.getTracks().forEach((t) => { try { t.stop(); } catch { } });
    return currentVideoOff;
  }

  try {
    _cleanupPlaceholder();

    if (localVideoEl) {
      try { localVideoEl.srcObject = null; } catch { }
    }

    const existingVideo = _getTrack("video");
    if (existingVideo) {
      try { existingVideo.stop(); } catch { }
      try { localStream?.removeTrack(existingVideo); } catch { }
    }

    if (!localStream) {
      localStream = new MediaStream([newTrack]);
      _notifyStreamChange(localStream);
    } else {
      try {
        localStream.addTrack(newTrack);
      } catch {
        localStream = new MediaStream([...localStream.getAudioTracks(), newTrack]);
        _notifyStreamChange(localStream);
      }
    }

    newTrack.enabled = true;
    attachTrackEndHandler(newTrack, "video", _ctx());

    await replaceTrackInPeers(newTrack, "video", { pcsRef, localStream });
    _setTransceiversSendrecv();

    syncPreview({
      localVideoEl,
      localStream,
      placeholderStream: null,
      localMirrorEnabled,
    });

    if (isMobileBrowser()) {
      refreshMobilePreview({
        localVideoEl,
        localStream,
        placeholderStream: null,
        localMirrorEnabled,
      });
    }

    _safeEmit("update-participant-state", { video: true });
    return false;
  } catch {
    try { newTrack.stop(); } catch { }
    return currentVideoOff;
  } finally {
    acquired.getTracks().forEach((t) => {
      const present = localStream?.getTracks().some((lt) => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

async function _safariMicSwap() {
  if (!localStream?.getAudioTracks?.().length) return;
  let acquired = null;
  try {
    acquired = await _getUserMediaWithTimeout({ audio: true });
    const micTrack = acquired.getAudioTracks()[0];
    if (micTrack) {
      const old = _getTrack("audio");
      if (old) {
        try { old.stop(); } catch { }
        try { localStream.removeTrack(old); } catch { }
      }
      try { localStream.addTrack(micTrack); } catch { }
      micTrack.enabled = true;
      await replaceTrackInPeers(micTrack, "audio", { pcsRef, localStream });
      attachTrackEndHandler(micTrack, "audio", _ctx());
    }
  } catch { }
  finally {
    acquired?.getTracks().forEach((t) => {
      const present = localStream?.getTracks().some((lt) => lt.id === t.id);
      if (!present) try { t.stop(); } catch { }
    });
  }
}

export function stopAllVideoAndCleanup() {
  try {
    localStream?.getVideoTracks?.().forEach((t) => {
      if (!t.__isPlaceholder) try { t.stop(); } catch { }
    });
  } catch { }
  if (localVideoEl) try { localVideoEl.srcObject = null; } catch { }
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