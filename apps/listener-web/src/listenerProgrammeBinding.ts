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
  event: GeneratedAudioReadyEvent,
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
  state: Pick<MediaStateEvent, 'processingSessionId' | 'streamStatus'>,
  activeSessionId: string | null,
): boolean {
  const incomingSessionId = state.processingSessionId ?? null;
  if (!incomingSessionId) return true;
  if (!activeSessionId) return !isTerminalMediaState(state);
  if (incomingSessionId === activeSessionId) return true;
  return !isTerminalMediaState(state);
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
