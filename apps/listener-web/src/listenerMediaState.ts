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
