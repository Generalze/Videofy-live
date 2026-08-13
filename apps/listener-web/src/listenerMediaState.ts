import type { MediaStateEvent } from '@videofy-live/shared-types';

export const UPLOADED_PROGRAMME_AUDIO_WAIT_MS = 15_000;

export interface UploadedProgrammeStartGateInput {
  hasStarted: boolean;
  hasProgrammeMedia: boolean;
  expectsGeneratedAudio: boolean;
  hasGeneratedAudioForLanguage: boolean;
  waitedMs: number;
  maxWaitMs?: number;
}

export interface UploadedProgrammeStartGate {
  start: boolean;
  buffering: boolean;
}

export function uploadedProgrammeStartGate(
  input: UploadedProgrammeStartGateInput,
): UploadedProgrammeStartGate {
  if (!input.hasProgrammeMedia || !input.expectsGeneratedAudio) {
    return { start: true, buffering: false };
  }
  if (
    input.hasGeneratedAudioForLanguage ||
    input.waitedMs >= (input.maxWaitMs ?? UPLOADED_PROGRAMME_AUDIO_WAIT_MS)
  ) {
    return { start: true, buffering: false };
  }
  return { start: false, buffering: input.hasStarted };
}

export interface SourceEndedFromBroadcastInput {
  streamStatus: string;
  programmeMediaMode: MediaStateEvent['programmeMediaMode'];
  videoEnded: boolean;
}

export function sourceEndedFromBroadcast(
  input: SourceEndedFromBroadcastInput,
): boolean {
  if (input.programmeMediaMode === 'uploaded-stems') {
    // The local <video> element is the completion authority for uploaded
    // programmes: "completed" from the server only means processing finished,
    // and a media-state broadcast must never cancel the end-of-video flush
    // once the element has genuinely ended.
    return input.videoEnded;
  }
  return input.streamStatus === 'completed';
}

export function preserveActiveProgrammeMedia(
  next: MediaStateEvent,
  previous: MediaStateEvent | null,
): MediaStateEvent {
  if (
    next.programmeMediaUrl ||
    !previous?.programmeMediaUrl ||
    next.streamStatus === 'cancelled' ||
    next.streamStatus === 'failed'
  ) {
    return next;
  }

  const sameProcessingSession =
    Boolean(next.processingSessionId) &&
    next.processingSessionId === previous.processingSessionId;
  const sameStream = Boolean(next.streamId) && next.streamId === previous.streamId;
  if (!sameProcessingSession && !sameStream) {
    return next;
  }

  return {
    ...next,
    programmeMediaUrl: previous.programmeMediaUrl,
    ...(previous.programmeMediaMode
      ? { programmeMediaMode: previous.programmeMediaMode }
      : {}),
  };
}
