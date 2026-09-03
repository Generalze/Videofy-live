/** @author masterzee001 */
/**
 * One programme, one ordered account of what happened, in programme time.
 *
 * WHY THIS EXISTS. Today a listener assembles a broadcast from parts that
 * arrive independently: audio on one path, captions on another, translated
 * speech on a third, and advertising fetched by the browser on its own
 * initiative. That works only because everything is roughly live at once. The
 * moment the public output is deliberately delayed, those parts stop being
 * roughly anything: the advert plays over content it was never placed against,
 * and a caption describes speech the viewer has not reached.
 *
 * So there is one timeline. Everything that happens in a broadcast is an event
 * on it, ordered by a sequence the platform mints, positioned by a programme
 * time the platform assigns. Delaying the output then means moving one cursor,
 * and everything stays in the order it was authored in, because there is only
 * one order.
 *
 * PROGRAMME TIME IS NOT WALL-CLOCK TIME. It is a position within the broadcast,
 * measured from its start. That distinction is the whole point: two viewers on
 * different delays are at different wall-clock instants and the same programme
 * position, and they must see the same programme.
 */

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';

/**
 * What kind of thing happened.
 *
 * Deliberately a closed set. A new kind is a deliberate decision about what a
 * broadcast contains, not something a producer can invent by writing a string.
 */
export type ProgrammeEventKind =
  /** A stretch of the original programme audio or video. */
  | 'media'
  /** Words recognised from the source, in the source language. */
  | 'caption'
  /** Those words in a target language. */
  | 'translation'
  /** Speech synthesised from a translation. */
  | 'generated-audio'
  /** A C7 advertisement, decided by the platform and placed here. */
  | 'advertisement'
  /** The broadcast itself changing: started, paused, resumed, ended. */
  | 'programme-state';

export interface ProgrammeTimelineEvent {
  readonly runId: string;
  /**
   * Monotonic within a run, minted by the platform, never by a producer.
   *
   * Two events can share a programme time -- a caption and its translation
   * describe the same instant -- so position alone cannot order them. The
   * sequence is what makes the account replayable in exactly the order it was
   * written.
   */
  readonly sequence: number;
  /** Position within the broadcast, in milliseconds from its start. */
  readonly programmeTimeMs: number;
  readonly kind: ProgrammeEventKind;
  /**
   * How long this event occupies, where that means anything.
   *
   * An advert has a duration and a caption does not. Zero means a point in
   * time rather than a stretch of it.
   */
  readonly durationMs: number;
  /**
   * What the event refers to: a segment id, a decision id, a media key.
   *
   * A REFERENCE, never the payload. A timeline that carried audio would be a
   * media store with an ordering problem, and the retention rules for the two
   * are completely different.
   */
  readonly reference: string;
  /** Non-sensitive descriptors: language, voice, state name. Never content. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/** Where the public output has reached, and how far behind the live edge it is. */
export interface OutputCursor {
  /** The furthest programme time that has been authored. */
  readonly programmeTimeMs: number;
  /** The programme time currently being emitted to viewers. */
  readonly publicOutputTimeMs: number;
  /**
   * The gap between them, which is the ACTUAL delay.
   *
   * Not the configured target and not the recommendation: what the buffer is
   * really holding at this instant. A programme still filling has a small
   * depth and is not yet protected, and saying otherwise is the specific lie
   * this field exists to prevent.
   */
  readonly bufferDepthMs: number;
}

export const EMPTY_CURSOR: OutputCursor = {
  programmeTimeMs: 0,
  publicOutputTimeMs: 0,
  bufferDepthMs: 0,
};

/**
 * An append-only account of one broadcast.
 *
 * Append-only because a timeline that could be edited would let a late event
 * change the past a viewer has already been shown, and because recovery after
 * a restart means replaying what was written, not reconstructing what might
 * have been meant.
 */
export class ProgrammeTimeline {
  private readonly events: ProgrammeTimelineEvent[] = [];
  private nextSequence = 1;
  private furthestProgrammeTimeMs = 0;

  /**
   * @param sink Called with every event as it is written, for durability.
   *
   * Fire-and-forget by design: a live broadcast must not wait on a disk. The
   * sink reports its own failure through whatever it was given, and the
   * caller decides whether a safety promise can still be kept -- appending is
   * not the place to discover that, because the words have already been said.
   */
  constructor(
    readonly identity: ProgrammeRunIdentity,
    private readonly sink?: (event: ProgrammeTimelineEvent) => void,
  ) {}

  /**
   * Write an event, receiving the one that was actually written.
   *
   * The sequence is assigned here rather than accepted from the caller: a
   * producer that minted its own would collide with another producer the first
   * time two stages completed together, which on a live programme is
   * constantly.
   */
  append(event: {
    readonly programmeTimeMs: number;
    readonly kind: ProgrammeEventKind;
    readonly reference: string;
    readonly durationMs?: number;
    readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  }): ProgrammeTimelineEvent {
    const written: ProgrammeTimelineEvent = {
      runId: this.identity.runId,
      sequence: this.nextSequence,
      programmeTimeMs: Math.max(0, Math.round(event.programmeTimeMs)),
      kind: event.kind,
      durationMs: Math.max(0, Math.round(event.durationMs ?? 0)),
      reference: event.reference,
      attributes: event.attributes ?? {},
    };
    this.nextSequence += 1;
    this.events.push(written);
    /*
     * The live edge only ever moves FORWARD.
     *
     * Events do not arrive in programme order -- a translation of a sentence
     * lands after later audio has already been written -- so taking the last
     * event's position would make the edge jump backwards and the apparent
     * buffer depth leap. The furthest point authored is the honest edge.
     */
    const end = written.programmeTimeMs + written.durationMs;
    if (end > this.furthestProgrammeTimeMs) this.furthestProgrammeTimeMs = end;
    // Durability, if this deployment has any. Never awaited here.
    this.sink?.(written);
    return written;
  }

  /** Everything authored, in the order it was authored. */
  all(): readonly ProgrammeTimelineEvent[] {
    return this.events;
  }

  /**
   * Everything a viewer at this output position should have received.
   *
   * Inclusive of the position itself, so an advert placed exactly at the
   * cursor plays rather than being perpetually one millisecond away.
   */
  through(publicOutputTimeMs: number): readonly ProgrammeTimelineEvent[] {
    return inProgrammeOrder(
      this.events.filter((event) => event.programmeTimeMs <= publicOutputTimeMs),
    );
  }

  /** Events in a half-open window, for emitting exactly once as the cursor moves. */
  between(fromExclusiveMs: number, toInclusiveMs: number): readonly ProgrammeTimelineEvent[] {
    return inProgrammeOrder(
      this.events.filter(
        (event) => event.programmeTimeMs > fromExclusiveMs && event.programmeTimeMs <= toInclusiveMs,
      ),
    );
  }

  cursorAt(publicOutputTimeMs: number): OutputCursor {
    const clamped = Math.min(Math.max(0, publicOutputTimeMs), this.furthestProgrammeTimeMs);
    return {
      programmeTimeMs: this.furthestProgrammeTimeMs,
      publicOutputTimeMs: clamped,
      bufferDepthMs: this.furthestProgrammeTimeMs - clamped,
    };
  }

  /** The furthest programme time authored so far: the live edge. */
  liveEdgeMs(): number {
    return this.furthestProgrammeTimeMs;
  }

  get length(): number {
    return this.events.length;
  }

  /**
   * Forget everything the public output has passed, keeping a margin.
   *
   * A broadcast runs for hours and the account of its first minute cannot be
   * retained forever. The margin exists because recovery replays from slightly
   * behind the cursor rather than exactly at it.
   */
  pruneBefore(programmeTimeMs: number): number {
    const before = this.events.length;
    const kept = this.events.filter((event) => event.programmeTimeMs >= programmeTimeMs);
    this.events.length = 0;
    this.events.push(...kept);
    return before - this.events.length;
  }
}

/**
 * Authored order is not emission order.
 *
 * A translation of a sentence is written after the audio that follows it, and
 * an advert is placed against a moment that has already been recorded. Emitting
 * in the order things were written would play an advert after the programme it
 * was placed inside. Programme time decides what a viewer sees when; the
 * sequence only breaks ties, so two events at the same instant still emerge in
 * the order they were authored.
 */
function inProgrammeOrder(
  events: readonly ProgrammeTimelineEvent[],
): readonly ProgrammeTimelineEvent[] {
  return [...events].sort((a, b) =>
    a.programmeTimeMs === b.programmeTimeMs
      ? a.sequence - b.sequence
      : a.programmeTimeMs - b.programmeTimeMs,
  );
}

/** Advertising is placed on this timeline and nowhere else. */
export * from './advertising.js';
export * from './store.js';
export * from './media.js';
export * from './lease.js';
export * from './ad-authority.js';
export * from './buffer.js';
