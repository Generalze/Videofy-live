/**
 * The realtime caption path's missing half.
 *
 * media-ingest's live pipeline recognises speech, opens a segment, commits it
 * and emits `ingest:live-transcript`. The gateway subscribed to a dozen ingest
 * events and never to that one, so on a translated call the recogniser worked,
 * segments committed, and every word was dropped on the floor between the two
 * services. Captions never appeared and no translated audio was ever produced,
 * which reads from outside as "the translation engine is broken".
 *
 * The batch path emits a different event with a different shape, already
 * wired. This translates the live shape into the one the call runtime routes,
 * so both paths converge on a single delivery, dedup and language-settling
 * implementation rather than growing a second one.
 *
 * SEQUENCE IS PER UTTERANCE, NOT PER MESSAGE. A caption's identity on the
 * client is `speaker:mediaRevision:sequence`, and a later caption with the
 * same identity REPLACES the earlier one. That is what makes an interim
 * caption grow in place as somebody speaks instead of stacking a new line per
 * revision. So every partial and the final of one segment must carry the SAME
 * sequence, and a fresh segment must take the next one.
 */
import type { TranscriptionEvent } from '@videofy-live/shared-types';

/** The live event as media-ingest emits it. Structural, to avoid a dependency. */
export interface LiveTranscriptEventLike {
  readonly kind: 'partial' | 'final';
  readonly sessionId: string;
  readonly streamId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly detectedLanguage?: string | undefined;
  readonly provider?: { readonly confidence?: number | null | undefined } | undefined;
}

/**
 * Bounded so a long-running gateway cannot accumulate one entry per utterance
 * for the lifetime of the process. Far more than any call needs in flight;
 * evicting the oldest only risks reusing a sequence for a segment nobody is
 * still amending.
 */
const MAX_TRACKED_SEGMENTS_PER_SESSION = 512;

export function isLiveTranscriptEvent(value: unknown): value is LiveTranscriptEventLike {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    (event['kind'] === 'partial' || event['kind'] === 'final') &&
    typeof event['sessionId'] === 'string' &&
    typeof event['streamId'] === 'string' &&
    typeof event['segmentId'] === 'string' &&
    typeof event['revision'] === 'number' &&
    typeof event['text'] === 'string' &&
    typeof event['startMs'] === 'number' &&
    typeof event['endMs'] === 'number'
  );
}

interface SessionState {
  nextSequence: number;
  /** segmentId -> the sequence every revision of that utterance carries. */
  readonly sequenceBySegment: Map<string, number>;
}

export class LiveTranscriptAdapter {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly now?: () => Date) {}

  /**
   * Convert one live event into the transcription event the call runtime
   * routes. Returns null for anything that carries no words: a segment the
   * provider produced no text for must not become an empty caption.
   */
  toTranscriptionEvent(event: LiveTranscriptEventLike): TranscriptionEvent | null {
    if (event.text.trim().length === 0) return null;

    let session = this.sessions.get(event.sessionId);
    if (!session) {
      session = { nextSequence: 0, sequenceBySegment: new Map() };
      this.sessions.set(event.sessionId, session);
    }

    let sequence = session.sequenceBySegment.get(event.segmentId);
    if (sequence === undefined) {
      sequence = session.nextSequence;
      session.nextSequence += 1;
      session.sequenceBySegment.set(event.segmentId, sequence);
      if (session.sequenceBySegment.size > MAX_TRACKED_SEGMENTS_PER_SESSION) {
        const oldest = session.sequenceBySegment.keys().next();
        if (!oldest.done) session.sequenceBySegment.delete(oldest.value);
      }
    }

    const confidence = event.provider?.confidence;
    return {
      sessionId: event.sessionId,
      streamId: event.streamId,
      // The platform's segment id IS the chunk identity on this path. There is
      // no file, and inventing a second id would break the correspondence
      // between what was committed and what was delivered.
      chunkId: event.segmentId,
      sequence,
      sourceText: event.text,
      // Absent rather than guessed. The runtime only settles a language for
      // participants who joined under auto-detect, and it hands the value to
      // the call core to accept or refuse -- supplying the plan's language
      // here would settle a detection that never happened.
      detectedLanguage: event.detectedLanguage ?? '',
      startMs: event.startMs,
      endMs: event.endMs,
      confidence: typeof confidence === 'number' ? confidence : null,
      // The live path only ever emits text it actually recognised; anything
      // else returned null above.
      status: 'transcribed',
      // When the gateway received it. Injectable so a test does not depend on
      // the wall clock, and so a replayed event keeps its own stamp.
      createdAt: (this.now?.() ?? new Date()).toISOString(),
      // ABSENT means final, per the wire contract. Present-and-false is the
      // only way to say interim, so it must not be emitted on a final.
      ...(event.kind === 'partial' ? { isFinal: false as const, partialSequence: event.revision } : {}),
    };
  }

  /** Drop a finished session's bookkeeping. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get trackedSessionCount(): number {
    return this.sessions.size;
  }
}
