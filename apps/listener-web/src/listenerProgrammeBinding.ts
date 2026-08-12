import type { GeneratedAudioReadyEvent, MediaStateEvent } from '@videofy-live/shared-types';

const PLACEHOLDER_SHAREABLE_IDS = new Set(['broadcast_demo/wrs_demo', 'broadcast_demo:wrs_demo']);

export function isPlaceholderShareableSessionId(shareableSessionId: string | null): boolean {
  return shareableSessionId !== null && PLACEHOLDER_SHAREABLE_IDS.has(shareableSessionId.trim());
}

export function shouldJoinProgrammeSession(
  currentShareableSessionId: string | null,
  nextShareableSessionId: string | null,
): boolean {
  if (!nextShareableSessionId || isPlaceholderShareableSessionId(nextShareableSessionId)) {
    return false;
  }
  return currentShareableSessionId !== nextShareableSessionId;
}

export function shouldReplaceProgrammeSession(
  currentShareableSessionId: string | null,
  nextShareableSessionId: string | null,
): boolean {
  return Boolean(
    currentShareableSessionId &&
      nextShareableSessionId &&
      !isPlaceholderShareableSessionId(nextShareableSessionId) &&
      currentShareableSessionId !== nextShareableSessionId,
  );
}

export function shouldAcceptGeneratedAudioForSession(
  event: Pick<GeneratedAudioReadyEvent, 'sessionId'>,
  activeSessionId: string | null,
): boolean {
  return !activeSessionId || event.sessionId === activeSessionId;
}

export function isTerminalMediaState(state: Pick<MediaStateEvent, 'streamStatus'>): boolean {
  return (
    state.streamStatus === 'completed' ||
    state.streamStatus === 'cancelled' ||
    state.streamStatus === 'failed'
  );
}

export function shouldAcceptMediaStateForListener(
  state: Pick<MediaStateEvent, 'processingSessionId' | 'streamStatus' | 'programmeMediaUrl'>,
  activeSessionId: string | null,
): boolean {
  const incomingSessionId = state.processingSessionId ?? null;
  if (!incomingSessionId) return true;
  if (!activeSessionId) {
    return !isTerminalMediaState(state) || Boolean(state.programmeMediaUrl);
  }
  if (incomingSessionId === activeSessionId) return true;
  return !isTerminalMediaState(state);
}

export function shouldRecoverProgrammeSessionAfterReconnect(input: {
  shareableSessionId: string | null;
  signallingState: string;
}): boolean {
  return Boolean(
    input.shareableSessionId &&
      !isPlaceholderShareableSessionId(input.shareableSessionId) &&
      input.signallingState !== 'idle' &&
      input.signallingState !== 'closed',
  );
}

export function shouldRestartListenerTransport(state: string): boolean {
  // Mirrors the transport's own startWaiting() guard: restarting an active
  // transport throws and force-fails it, so only restart from a resting state.
  // A healthy transport survives socket blips independently.
  return state === 'idle' || state === 'closed' || state === 'failed';
}

export function shouldExposeMediaStateProgrammeSession(
  state: Pick<MediaStateEvent, 'shareableWebRtcSessionId' | 'streamStatus'>,
): boolean {
  return Boolean(
    state.shareableWebRtcSessionId &&
      !isPlaceholderShareableSessionId(state.shareableWebRtcSessionId) &&
      !isTerminalMediaState(state),
  );
}

export function shouldTreatTransportAsSourceEnded(input: {
  state: string;
  remoteAudioTrackReceived: boolean;
  remoteAudioTrackActive: boolean;
  remoteVideoTrackReceived: boolean;
  remoteVideoTrackActive: boolean;
}): boolean {
  if (input.state === 'source-ended') return true;
  const receivedMedia = input.remoteAudioTrackReceived || input.remoteVideoTrackReceived;
  if (!receivedMedia) return false;
  const audioEnded = !input.remoteAudioTrackReceived || !input.remoteAudioTrackActive;
  const videoEnded = !input.remoteVideoTrackReceived || !input.remoteVideoTrackActive;
  return audioEnded && videoEnded;
}

export function shouldInitializeGeneratedAudioClock(clockStatus: string): boolean {
  return clockStatus === 'created';
}

export function shouldRecoverStaleViewerPlayback(input: {
  hasStarted: boolean;
  hasRemoteStream: boolean;
  remoteVideoTrackReceived: boolean;
  remoteVideoTrackActive: boolean;
  streamStatus: string;
  videoPaused: boolean;
  videoReadyState: number;
  currentTimeSeconds: number;
  previousTimeSeconds: number | null;
  stagnantChecks: number;
  minStagnantChecks: number;
  minReadyState: number;
}): boolean {
  if (!input.hasStarted || !input.hasRemoteStream) return false;
  if (!input.remoteVideoTrackReceived || !input.remoteVideoTrackActive) return false;
  if (input.streamStatus !== 'processing') return false;
  if (input.videoPaused) return false;
  if (input.videoReadyState < input.minReadyState) return false;
  if (input.previousTimeSeconds === null) return false;
  if (input.currentTimeSeconds > input.previousTimeSeconds + 0.05) return false;
  return input.stagnantChecks >= input.minStagnantChecks;
}

export function shouldShowHeldViewerFrame(input: {
  hasLastFrame: boolean;
  hasReceivedProgrammeVideo: boolean;
  streamStatus: string;
  remoteVideoTrackActive: boolean;
  viewerVideoStalled: boolean;
}): boolean {
  if (!input.hasLastFrame || !input.hasReceivedProgrammeVideo) return false;
  return (
    input.viewerVideoStalled ||
    input.streamStatus !== 'processing' ||
    !input.remoteVideoTrackActive
  );
}

export function describeProgrammeVideoLabel(input: {
  remoteVideoTrackReceived: boolean;
  remoteAudioTrackReceived: boolean;
  mediaHasVideo: boolean;
  streamStatus: string;
  transportState: string;
  usesMockVideoFeed: boolean;
}): string {
  if (input.remoteVideoTrackReceived || input.mediaHasVideo) {
    return input.streamStatus === 'completed' || input.transportState === 'source-ended'
      ? 'Programme video ended'
      : 'Programme video';
  }
  if (input.remoteAudioTrackReceived) return 'Audio-only programme';
  if (input.usesMockVideoFeed) return 'Mock video source';
  return 'Programme video unavailable';
}
