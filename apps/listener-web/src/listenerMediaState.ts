import type { MediaStateEvent } from '@videofy-live/shared-types';

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
