/** @author masterzee001 */
/**
 * The thing that decides WHEN the audience receives what.
 *
 * Until now every part of a broadcast reached listeners the instant it was
 * produced: a caption when the recogniser finalised it, translated speech when
 * the synthesiser finished, an advert whenever the browser asked for one. That
 * works only because everything was live at once. A safety buffer makes it
 * false in the worst way -- the operator is told the programme is forty-five
 * seconds behind while the audience is hearing it now.
 *
 * So production output stops being "emit when ready" and becomes "emit when
 * the cursor reaches it". The timeline says what happened and in what order;
 * the buffer says how much of it the audience may have; this carries the
 * payloads across that line.
 *
 * WHY PAYLOADS ARE HELD HERE AND NOT ON THE TIMELINE. A timeline that carried
 * audio would be a media store with an ordering problem, and the two have
 * completely different retention rules. The timeline holds a reference; this
 * holds what that reference means, only until the audience has had it.
 *
 * AN UNBUFFERED PROGRAMME IS NOT A SPECIAL CASE. With no delay configured the
 * cursor sits at the live edge, so everything is released on the next tick and
 * behaviour is what it always was. There is one path, not two.
 */

import type { ProgrammeOutputBuffer, ProgrammeTimelineEvent } from '@videofy-live/programme-timeline';

/** What the audience is eventually sent, keyed by the reference on its event. */
export interface PendingPayload {
  readonly kind: ProgrammeTimelineEvent['kind'];
  readonly emit: () => void;
}

/**
 * How many payloads one broadcast may hold before something is wrong.
 *
 * A payload is held only until the cursor reaches its event, so the steady
 * state is roughly the buffer depth in events. A number far above that means
 * the cursor has stopped moving, and dropping the oldest is better than a
 * service that runs out of memory during a programme -- but it is a loss, and
 * it is reported rather than absorbed.
 */
export const MAX_PENDING_PAYLOADS = 5_000;

export class ProgrammeOutputPump {
  private readonly pending = new Map<string, PendingPayload>();
  private dropped = 0;

  constructor(
    private readonly buffer: ProgrammeOutputBuffer,
    private readonly onDrop?: (droppedTotal: number) => void,
  ) {}

  /**
   * Hold what an event refers to, until the audience is allowed to have it.
   *
   * Called as the payload is produced, with the same reference the timeline
   * event carries. A payload with no matching event is never released -- which
   * is correct: if it is not on the timeline it is not part of the broadcast.
   */
  hold(reference: string, payload: PendingPayload): void {
    this.pending.set(reference, payload);
    if (this.pending.size <= MAX_PENDING_PAYLOADS) return;
    const oldest = this.pending.keys().next();
    if (oldest.done === true) return;
    this.pending.delete(oldest.value);
    this.dropped += 1;
    // Loud, because a dropped payload is a hole in somebody's broadcast.
    this.onDrop?.(this.dropped);
  }

  /**
   * Let the cursor advance, and send whatever that released.
   *
   * Everything released is emitted in programme order, because that is the
   * order the buffer returns it in and the order the audience must experience
   * it in -- a translation after the sentence it translates, an advert between
   * the segments it was placed between.
   */
  tick(): readonly ProgrammeTimelineEvent[] {
    const released = this.buffer.advance();
    for (const event of released) {
      const payload = this.pending.get(event.reference);
      if (payload === undefined) continue;
      this.pending.delete(event.reference);
      payload.emit();
    }
    return released;
  }

  /** How much is waiting on the cursor. For diagnostics, never for a decision. */
  get pendingCount(): number {
    return this.pending.size;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * The broadcast is ending: let the audience have what is still held.
   *
   * Without this, a programme with a forty-five second buffer would simply
   * stop, and its last forty-five seconds -- which were produced, paid for and
   * promised -- would never be heard.
   */
  drain(): void {
    this.buffer.drain();
    for (const payload of this.pending.values()) payload.emit();
    this.pending.clear();
  }
}
