/** @author masterzee001 */
/**
 * THE DUAL CAPTION, and what the wire actually carries.
 *
 * The board asks for one card holding a speaker line, the sentence as it was
 * SAID, and a nested card holding the same sentence TRANSLATED. That needs two
 * texts for one utterance, so the wire was read before the card was drawn.
 *
 * WHAT `call:caption` CARRIES (packages/call-wire wire-types.ts, and the
 * gateway's own `buildCaptionPayload` in services/call-session): `originalText`
 * is on EVERY delivery, including the translated one -- the payload for a
 * translated recipient is built with `originalText: event.originalText` and
 * `translatedText` beside it. `sourceLanguage` is always present;
 * `targetLanguage` and `translatedText` are BOTH null for a same-language
 * caption, where the original transcript is the whole caption. So the dual card
 * is representable, and the nested half is exactly the case where
 * `translatedText` is a non-empty string that differs from the original.
 *
 * WHAT THE PHONE WAS DOING WITH IT: nothing. `callConnection.ts` subscribed to
 * thirteen events and `call:caption` was not one of them -- its own header said
 * so ("Captions and the generated-audio clip queue are still deliberately
 * absent"). Both halves existed and the seam was never joined, which is this
 * repository's signature defect. This module is the join's decision half, kept
 * away from the socket so it can be proven in node.
 *
 * THE MERGE IS NOT RE-DERIVED HERE. `mergeCallCaption` in
 * @videofy-live/call-client-core already owns partial-replaces-partial,
 * final-refuses-a-late-partial and stale-media-revision, with its own tests;
 * a second copy of those rules is a second place to get them wrong, and the
 * copy that is wrong is always the newer one. `nextCaption` asks it the
 * question and keeps the RAW event, because the shared entry folds the
 * original into the translation and drops both language tags -- which is
 * precisely what the nested card needs back.
 */
import {
  callCaptionEntryId,
  captionEntryFromEvent,
  mergeCallCaption,
  type CallCaptionEvent,
} from '@videofy-live/call-client-core';

export interface CaptionTranslation {
  /** The language the engine translated INTO, as the gateway stated it. */
  readonly language: string;
  readonly text: string;
}

export interface CaptionCardModel {
  readonly id: string;
  readonly speaker: string;
  /** The language the words were SPOKEN in. */
  readonly sourceLanguage: string;
  /** The sentence as it was said. */
  readonly original: string;
  /** The nested card, or null when this utterance was never translated. */
  readonly translation: CaptionTranslation | null;
  /** False while the engine is still revising this utterance. */
  readonly isFinal: boolean;
}

/** A string field that is really a string with something in it. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A `call:caption` payload off the socket, or null.
 *
 * Validated rather than cast. A caption reaches the biggest text on the call
 * screen, and the one thing worse than no caption is a confident sentence
 * assembled out of `undefined`. Every field the card or the merge reads has to
 * be the right type; anything else is dropped whole.
 */
export function parseCaption(raw: unknown, callId: string): CallCaptionEvent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const wire = raw as Partial<CallCaptionEvent>;
  // A caption for a call this phone is not on is not this phone's caption.
  if (text(wire.callId) !== callId) return null;
  const speakerParticipantId = text(wire.speakerParticipantId);
  const sourceLanguage = text(wire.sourceLanguage);
  const sequence = whole(wire.sequence);
  const mediaRevision = whole(wire.mediaRevision);
  const languageRevision = whole(wire.languageRevision);
  if (
    speakerParticipantId === null ||
    sourceLanguage === null ||
    sequence === null ||
    mediaRevision === null ||
    languageRevision === null ||
    typeof wire.originalText !== 'string'
  ) {
    return null;
  }
  return {
    callId,
    speakerParticipantId,
    speakerDisplayName: typeof wire.speakerDisplayName === 'string' ? wire.speakerDisplayName : '',
    sourceLanguage,
    targetLanguage: text(wire.targetLanguage),
    originalText: wire.originalText,
    translatedText: typeof wire.translatedText === 'string' ? wire.translatedText : null,
    sequence,
    mediaRevision,
    languageRevision,
    startMs: whole(wire.startMs) ?? 0,
    endMs: whole(wire.endMs) ?? 0,
    isFinal: wire.isFinal === true,
  };
}

/**
 * Which of the two captions belongs on screen -- the one already there, or the
 * one that just arrived.
 *
 * The answer is the shared merge's answer. `mergeCallCaption` returns the SAME
 * array it was given when it refuses an event (a straggler from a superseded
 * media revision, a partial arriving after its own final, an older language
 * revision), so reference identity is the refusal, and nothing about those
 * rules is restated here.
 *
 * ONE RULE THE SHARED MERGE DOES NOT HAVE, AND A SINGLE SLOT NEEDS. The merge
 * keeps a rolling LIST, so an unseen entry id simply appends: for one speaker
 * at one media revision, sequence 9 arriving after sequence 10 has settled is
 * appended out of order, which in a fifty-line transcript is untidy and in a
 * one-line display REPLACES the sentence on screen with an older one. So the
 * slot adds the guard its own shape requires, and nothing else. (Reachability
 * is low -- socket.io delivers in order on one connection -- and it is written
 * down rather than argued about.)
 */
export function nextCaption(
  current: CallCaptionEvent | null,
  incoming: CallCaptionEvent,
): CallCaptionEvent | null {
  const base = current === null ? [] : [captionEntryFromEvent(current)];
  const merged = mergeCallCaption(base, incoming);
  // Refused: the shared rules handed back the array untouched.
  if (merged === base) return current;
  if (current !== null && isSequenceRegression(current, incoming)) return current;
  return incoming;
}

/** An earlier utterance from the same speaker at the same media revision. */
function isSequenceRegression(current: CallCaptionEvent, incoming: CallCaptionEvent): boolean {
  if (current.speakerParticipantId !== incoming.speakerParticipantId) return false;
  // A different media revision is a resume, where the counter legitimately
  // restarts; the shared merge already refuses the OLDER of those two.
  if (current.mediaRevision !== incoming.mediaRevision) return false;
  return incoming.sequence < current.sequence;
}

/** True when the two events are revisions of the SAME utterance. */
export function isSameUtterance(a: CallCaptionEvent | null, b: CallCaptionEvent | null): boolean {
  if (a === null || b === null) return false;
  return callCaptionEntryId(a) === callCaptionEntryId(b);
}

/**
 * The card, or null when there is nothing measured to draw.
 *
 * The nested translation appears ONLY for an utterance that genuinely has one:
 * a non-empty `translatedText`, a `targetLanguage` to label it with, and text
 * that is not simply the original again. A same-language caption arrives with
 * both of those null and gets the outer card alone -- which is the honest
 * picture of a call where nothing was translated.
 */
export function captionCard(event: CallCaptionEvent | null): CaptionCardModel | null {
  if (event === null) return null;
  const original = text(event.originalText);
  if (original === null) return null;
  const translated = text(event.translatedText);
  const target = text(event.targetLanguage);
  const translation: CaptionTranslation | null =
    translated === null || target === null || translated === original
      ? null
      : { language: target, text: translated };
  return {
    id: callCaptionEntryId(event),
    speaker: text(event.speakerDisplayName) ?? '',
    sourceLanguage: event.sourceLanguage,
    original,
    translation,
    isFinal: event.isFinal,
  };
}

/** How long a partial caption keeps counting as somebody speaking. */
export const SPEECH_HOLD_MS = 2500;

/**
 * IS SOMEBODY SPEAKING RIGHT NOW -- measured, not looped.
 *
 * The indicator above the name on the board is the kind of thing that gets
 * built as an `Animated.loop` and then animates through a call in which nobody
 * has said a word. The signal used instead is the caption stream: the engine
 * emits PARTIAL captions while an utterance is still being formed and a FINAL
 * one when it settles, so a partial that arrived a moment ago is evidence of
 * speech in a way a timer never is.
 *
 * Two ways it goes quiet, and both matter. A final caption ends the utterance
 * at once. A partial that stops being revised -- the engine dropped it, the
 * socket went away -- goes quiet after {@link SPEECH_HOLD_MS}, so a stuck
 * partial cannot animate for the rest of the call.
 *
 * `changedAtMs` and `nowMs` are both the PHONE's clock: this measures the age
 * of an arrival at this handset, not a position in the call's timeline, so the
 * server offset has no part in it.
 */
export function captionSpeaking(input: {
  readonly caption: CallCaptionEvent | null;
  /** Phone clock at the moment that caption last changed. */
  readonly changedAtMs: number | null;
  readonly nowMs: number;
  readonly holdMs?: number;
}): boolean {
  const { caption, changedAtMs, nowMs } = input;
  if (caption === null || changedAtMs === null) return false;
  if (caption.isFinal) return false;
  const hold = input.holdMs ?? SPEECH_HOLD_MS;
  return nowMs - changedAtMs < hold;
}
