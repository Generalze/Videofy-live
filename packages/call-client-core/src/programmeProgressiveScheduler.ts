/**
 * Progressive translated speech, scheduled against the PROGRAMME clock.
 *
 * THE TRAP THIS EXISTS TO AVOID. "Progressive" means audio is available before
 * synthesis finishes. It does NOT mean "play it the instant the network hands
 * it over". A programme viewer is watching a person on screen; translated
 * speech that arrives early and plays immediately is an interpreted voice
 * several seconds ahead of the speaker's lips. That is a faster pipeline and a
 * worse product, and it would benchmark beautifully.
 *
 * The existing finished-file queue already schedules against the viewer clock
 * and drops segments that missed their window. This applies the SAME policy to
 * frames:
 *
 *   early            hold until the segment's presentation window opens
 *   in window        release, and let every later frame of that segment pass
 *                    straight through -- that is the progressive part
 *   late, recoverable release now; the viewer hears it slightly behind rather
 *                    than not at all
 *   late, past end   drop the segment. Speech for a moment that has visibly
 *                    passed is worse than silence: it describes something the
 *                    audience already watched happen.
 *   source ended     no clock left to sync to; release everything owed
 *
 * A CALL DOES NOT USE THIS. There is no shared timeline in a conversation --
 * the "presentation window" for a caller's sentence is as soon as possible.
 * Scheduling a call against a clock would add latency to the one case that
 * cannot afford any.
 */
import type { ProgressiveTranslatedAudioFrame } from './progressiveTranslatedAudio';

export interface ProgrammeScheduleOptions {
  /** The synchronized viewer clock, in programme media milliseconds. */
  readonly clockMs: () => number;
  /**
   * How far past a segment's own window it may still be played.
   *
   * Beyond this the segment is dropped rather than played late. The same
   * judgement the finished-file queue already makes, and for the same reason.
   */
  readonly lateDropToleranceMs: number;
  /** Estimated duration of a segment, when the platform does not say. */
  readonly assumedSegmentMs?: number;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called when a segment's frames are cleared to play. */
  readonly release: (frame: ProgressiveTranslatedAudioFrame) => void;
  readonly onDrop?: (
    frame: ProgressiveTranslatedAudioFrame,
    reason: 'late-past-window' | 'stale-source' | 'reset',
  ) => void;
}

export type ProgrammeScheduleOutcome =
  /** Playing now: either the window is open or this segment already started. */
  | 'released'
  /** Held. It will be released when its window opens. */
  | 'scheduled'
  /** Its moment has visibly passed. */
  | 'dropped-late';

interface HeldSegment {
  readonly frames: ProgressiveTranslatedAudioFrame[];
  timer: unknown;
  started: boolean;
}

const DEFAULT_ASSUMED_SEGMENT_MS = 4_000;

function segmentKey(frame: ProgressiveTranslatedAudioFrame): string {
  return `${frame.targetLanguage}\u0000${frame.segmentId}`;
}

export class ProgrammeProgressiveScheduler {
  private readonly held = new Map<string, HeldSegment>();
  private sourceEnded = false;
  private readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ProgrammeScheduleOptions) {
    this.setTimer = options.setTimer ?? ((handler, delay) => setTimeout(handler, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  get heldSegments(): number {
    return this.held.size;
  }

  accept(frame: ProgressiveTranslatedAudioFrame): ProgrammeScheduleOutcome {
    const key = segmentKey(frame);
    const existing = this.held.get(key);

    // Once a segment has started, every later frame goes straight through. THIS
    // is the progressive part: the viewer hears the sentence continue as it is
    // synthesised, having waited only for its opening moment.
    if (existing?.started === true) {
      this.options.release(frame);
      return 'released';
    }

    // No clock left to synchronise against. Everything owed is released.
    if (this.sourceEnded) {
      this.startSegment(key, [frame]);
      return 'released';
    }

    const clockMs = this.options.clockMs();
    const assumedEndMs =
      frame.segmentStartMs + (this.options.assumedSegmentMs ?? DEFAULT_ASSUMED_SEGMENT_MS);
    if (clockMs - assumedEndMs > this.options.lateDropToleranceMs) {
      // The moment has visibly passed. Speech about it now describes something
      // the audience already watched happen.
      this.options.onDrop?.(frame, 'late-past-window');
      return 'dropped-late';
    }

    const delayMs = frame.segmentStartMs - clockMs;
    if (delayMs <= 0) {
      // In window, or recoverably late. Either way it plays now.
      this.startSegment(key, [...(existing?.frames ?? []), frame]);
      return 'released';
    }

    if (existing !== undefined) {
      existing.frames.push(frame);
      return 'scheduled';
    }
    const segment: HeldSegment = { frames: [frame], timer: null, started: false };
    this.held.set(key, segment);
    segment.timer = this.setTimer(() => {
      const current = this.held.get(key);
      if (current === undefined || current.started) return;
      this.startSegment(key, current.frames);
    }, delayMs);
    return 'scheduled';
  }

  /** The programme source ended; nothing further can be synchronised. */
  endSource(): void {
    this.sourceEnded = true;
    for (const [key, segment] of [...this.held]) {
      if (segment.started) continue;
      this.startSegment(key, segment.frames);
    }
  }

  /**
   * Drop everything, because what it belonged to is gone.
   *
   * Used on a source switch, a revision change, and a language change. Frames
   * held for the previous programme state must never be released into the new
   * one: the viewer has moved on, and audio from before the move is not late,
   * it is wrong.
   */
  reset(reason: 'stale-source' | 'reset' = 'reset'): void {
    for (const segment of this.held.values()) {
      if (segment.timer !== null) this.clearTimer(segment.timer);
      for (const frame of segment.frames) this.options.onDrop?.(frame, reason);
    }
    this.held.clear();
    this.sourceEnded = false;
  }

  /** Drop only one language's held audio, for a viewer language switch. */
  resetLanguage(targetLanguage: string): void {
    const prefix = `${targetLanguage}\u0000`;
    for (const [key, segment] of [...this.held]) {
      if (!key.startsWith(prefix)) continue;
      if (segment.timer !== null) this.clearTimer(segment.timer);
      for (const frame of segment.frames) this.options.onDrop?.(frame, 'reset');
      this.held.delete(key);
    }
  }

  private startSegment(key: string, frames: readonly ProgressiveTranslatedAudioFrame[]): void {
    const existing = this.held.get(key);
    if (existing?.timer != null) this.clearTimer(existing.timer);
    this.held.set(key, { frames: [], timer: null, started: true });
    for (const frame of frames) this.options.release(frame);
  }
}
