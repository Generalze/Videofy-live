/** @author masterzee001 */
/**
 * The advert this viewer is currently in, decided by C7 and delivered by the cursor.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. The sponsored slot used to be filled by
 * asking a service what to show. That is a client choosing an advert -- and a
 * client that chooses can be given a different answer from its neighbour, can
 * be told a different answer on a reload, and can be persuaded by anybody with
 * developer tools. None of that is compatible with selling an impression.
 *
 * So the advert arrives as an event on the programme timeline, released at the
 * cursor like a caption or a piece of translated speech. Two viewers forty
 * seconds apart meet it at the same programme moment, which is the only sense
 * in which "this advert ran in this programme" is a true statement.
 *
 * THE HOUSE CREATIVE IS STILL THE FALLBACK, and still not chosen here: the
 * slot shows it whenever C7 has decided nothing, which is a state, not a
 * decision this module makes.
 *
 * NOTHING COMMERCIAL ARRIVES. An id and a duration. A viewer is not an
 * authorised reader of what a break is worth, and a browser is a public place.
 */

/** What the gateway forwards when the cursor releases an advert. */
export interface ProgrammeAdvertEvent {
  readonly runId: string;
  readonly decisionId: string;
  readonly creativeId: string;
  readonly programmeTimeMs: number;
  readonly durationMs: number;
}

export interface ActiveAdvert {
  readonly decisionId: string;
  readonly creativeId: string;
  /** When this viewer's playback of it began, on their own clock. */
  readonly startedAtMs: number;
  readonly durationMs: number;
}

/**
 * Whether an advert event belongs to the broadcast this viewer is watching.
 *
 * A viewer who switched channels mid-advert must not keep the previous
 * programme's, and a stray event for another run must not displace theirs --
 * which is a tenancy question, not a tidiness one.
 */
export function advertBelongsToRun(
  event: Pick<ProgrammeAdvertEvent, 'runId'>,
  runId: string | null,
): boolean {
  return runId !== null && event.runId === runId;
}

/**
 * Take an advert as current, or decline it.
 *
 * A DECISION ID ARRIVING TWICE IS THE SAME ADVERT. Reconnects replay, and
 * restarting the countdown each time would stretch one advert across the rest
 * of the programme -- and, worse, would look to anybody counting like a second
 * impression.
 */
export function acceptAdvert(
  current: ActiveAdvert | null,
  event: ProgrammeAdvertEvent,
  nowMs: number,
): ActiveAdvert | null {
  if (current !== null && current.decisionId === event.decisionId) return current;
  if (event.durationMs <= 0) return current;
  return {
    decisionId: event.decisionId,
    creativeId: event.creativeId,
    startedAtMs: nowMs,
    durationMs: event.durationMs,
  };
}

/** Whether an advert's own duration has elapsed for this viewer. */
export function advertStillRunning(advert: ActiveAdvert | null, nowMs: number): boolean {
  if (advert === null) return false;
  return nowMs - advert.startedAtMs < advert.durationMs;
}

/**
 * What the slot should show right now.
 *
 * `house` is not a failure state. It is the ordinary condition of a programme
 * with nothing sold into this moment, and showing an advert that is not
 * currently sold would be worse than showing ours.
 */
export function slotContent(
  advert: ActiveAdvert | null,
  nowMs: number,
): { readonly kind: 'c7'; readonly creativeId: string } | { readonly kind: 'house' } {
  return advertStillRunning(advert, nowMs)
    ? { kind: 'c7', creativeId: (advert as ActiveAdvert).creativeId }
    : { kind: 'house' };
}
