import type { CallCaptionEvent } from './callTypes';

export const MAX_CALL_CAPTION_ENTRIES = 50;

export interface CallCaptionEntry {
  id: string;
  speakerParticipantId: string;
  speakerDisplayName: string;
  /** Translated caption text (falls back to the original transcript for same-language pairs). */
  primaryText: string;
  /** Original transcript when it differs from the primary text; empty otherwise. */
  originalText: string;
  sequence: number;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  mediaRevision: number;
  languageRevision: number;
}

export function callCaptionEntryId(
  event: Pick<CallCaptionEvent, 'speakerParticipantId' | 'mediaRevision' | 'sequence'>,
): string {
  // The media revision is part of the identity: after a resume the sequence
  // counter restarts, and post-resume captions must append instead of
  // replacing earlier entries in place.
  return `${event.speakerParticipantId}:${event.mediaRevision}:${event.sequence}`;
}

export function captionEntryFromEvent(event: CallCaptionEvent): CallCaptionEntry {
  // Same-language captions arrive with translatedText: null — the original
  // transcript is the caption.
  const translated = event.translatedText ?? '';
  const primaryText = translated.trim().length > 0 ? translated : event.originalText;
  return {
    id: callCaptionEntryId(event),
    speakerParticipantId: event.speakerParticipantId,
    speakerDisplayName: event.speakerDisplayName,
    primaryText,
    originalText: event.originalText === primaryText ? '' : event.originalText,
    sequence: event.sequence,
    isFinal: event.isFinal,
    startMs: event.startMs,
    endMs: event.endMs,
    mediaRevision: event.mediaRevision,
    languageRevision: event.languageRevision,
  };
}

/**
 * Merges an incoming caption event into the rolling transcript:
 * - a caption with a known speaker/sequence id replaces the earlier partial in
 *   place (partials grow, then the final revision settles the entry);
 * - late partials arriving after a final for the same revision are ignored;
 * - captions from an older media/language revision are ignored;
 * - new entries append in arrival order, capped to the newest
 *   {@link MAX_CALL_CAPTION_ENTRIES}.
 */
export function mergeCallCaption(
  entries: readonly CallCaptionEntry[],
  event: CallCaptionEvent,
): readonly CallCaptionEntry[] {
  const incoming = captionEntryFromEvent(event);
  const index = entries.findIndex((entry) => entry.id === incoming.id);
  if (index === -1) {
    // A straggler from a superseded media revision would append out of order
    // below newer captions — drop it instead.
    if (hasNewerMediaRevision(entries, incoming)) return entries;
    return [...entries, incoming].slice(-MAX_CALL_CAPTION_ENTRIES);
  }

  const existing = entries[index];
  if (!existing) return entries;

  // The entry id pins the media revision, so only the language revision and
  // partial/final ordering decide in-place replacement.
  const revisionDelta = incoming.languageRevision - existing.languageRevision;
  if (revisionDelta < 0) return entries;
  if (revisionDelta === 0 && existing.isFinal && !incoming.isFinal) return entries;

  const next = [...entries];
  next[index] = incoming;
  return next;
}

function hasNewerMediaRevision(
  entries: readonly CallCaptionEntry[],
  incoming: CallCaptionEntry,
): boolean {
  return entries.some(
    (entry) =>
      entry.speakerParticipantId === incoming.speakerParticipantId &&
      entry.mediaRevision > incoming.mediaRevision,
  );
}
