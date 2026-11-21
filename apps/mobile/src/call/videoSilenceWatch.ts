/** @author masterzee001 */
/**
 * WHEN IS A VIDEO PEER ACTUALLY SILENT, AND WHEN HAS IT SIMPLY NOT STARTED.
 *
 * MEASURED ON TWO PHONES. Video worked when the camera was turned on about
 * fifty seconds into a settled call -- 52 frames arrived -- and failed when it
 * was turned on early: 621 frames left one side and none reached the other,
 * with the peer closed four times, rebuilt three times, and recovered zero.
 *
 * The watch caused it. It gave a peer two seconds to produce frames and then
 * rebuilt it, testing nothing but `outboundFrames === 0`. A peer still
 * negotiating looks exactly like a peer that is connected and mute, and
 * negotiation through a relay routinely takes longer than two seconds. So the
 * remedy fired on a healthy connection, the rebuild restarted the negotiation
 * it was waiting for, and it did that until it ran out of attempts.
 *
 * It is the house mistake: a number read without the context that gives it
 * meaning. Both signals were already on the row. `connectionState` says
 * whether there is yet anything to be silent about. `measured` says, in its
 * own words, that zero counters can mean NOTHING WAS COUNTED rather than
 * nothing moved.
 *
 * THIS MODULE IS THE DECISION, KEPT AWAY FROM THE TIMERS so it can be proven
 * in node. The watch in callConnection.ts samples and acts; what counts as
 * silence, and what may be rebuilt, is decided here.
 */

/** As much of a peer's stats row as the decision reads. */
export interface VideoPeerSample {
  readonly participantId: string;
  /** `connected` is the only state in which an absence of frames means anything. */
  readonly connectionState: string;
  readonly outboundFrames: number;
  readonly outboundBytes: number;
  /** False means the counters were never read, not that they read zero. */
  readonly measured: boolean;
}

/** How long a relayed peer is given to reach `connected` before we stop waiting. */
export const CONNECT_DEADLINE_SAMPLES = 24;

/**
 * Consecutive CONNECTED, MEASURED samples with no frames before it is a fault.
 *
 * Four samples is the two seconds the old watch used -- the duration was never
 * the bug, the clock starting at the wrong moment was. It now starts when the
 * peer connects rather than when the camera opens.
 */
export const SILENT_SAMPLES = 4;

/** True when this peer is producing video. */
export function isMoving(row: VideoPeerSample): boolean {
  return row.outboundFrames > 0 || row.outboundBytes > 0;
}

/**
 * The silence streak after this sample, given the streak before it.
 *
 * Resets on anything that is not a measured silence from a connected peer, so
 * a peer that drops and returns does not carry half a verdict across the gap.
 */
export function nextSilenceStreak(previous: number, row: VideoPeerSample): number {
  const silent = row.connectionState === 'connected' && row.measured && !isMoving(row);
  return silent ? previous + 1 : 0;
}

/**
 * Which peers may be rebuilt now.
 *
 * ONLY a connected peer that has been measurably silent for long enough, and
 * only once each. A peer short of `connected` is never returned: its fault is
 * negotiation that has not finished, and a rebuild restarts negotiation, which
 * is the thing that already failed.
 */
export function peersToRebuild(
  rows: readonly VideoPeerSample[],
  streaks: ReadonlyMap<string, number>,
  alreadyRebuilt: ReadonlySet<string>,
  threshold: number = SILENT_SAMPLES,
): readonly string[] {
  return rows
    .filter((row) => !alreadyRebuilt.has(row.participantId))
    .filter((row) => row.connectionState === 'connected')
    .filter((row) => (streaks.get(row.participantId) ?? 0) >= threshold)
    .map((row) => row.participantId);
}

/**
 * Peers that never reached `connected` before the deadline.
 *
 * Reported rather than rebuilt, and reported SEPARATELY, because "it connected
 * and sent nothing" and "it never connected" need opposite investigations and
 * the old code could not tell them apart.
 */
export function peersThatNeverConnected(
  rows: readonly VideoPeerSample[],
  everConnected: ReadonlySet<string>,
  alreadyRebuilt: ReadonlySet<string>,
): readonly string[] {
  return rows
    .filter((row) => !alreadyRebuilt.has(row.participantId))
    .filter((row) => !everConnected.has(row.participantId))
    .map((row) => row.participantId);
}

/** Every peer is producing video, so the watch is finished. */
export function allMoving(rows: readonly VideoPeerSample[]): boolean {
  return rows.length > 0 && rows.every(isMoving);
}
