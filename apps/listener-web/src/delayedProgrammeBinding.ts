/** @author masterzee001 */
/**
 * Which programme this viewer should be playing, and by which path.
 *
 * The decision itself, with no React and no browser in it, because it is the
 * one place a mistake is silent: attaching the wrong path does not throw, it
 * just shows the viewer something they should not be seeing, or nothing at
 * all.
 *
 * THE RUN DECIDES. This reads the delivery answer the run published and does
 * not form a second opinion from a delay figure, a configuration value or the
 * presence of a manifest URL. A viewer who could choose would be a viewer who
 * could choose the undelayed one.
 */

import type { MediaStateEvent, ProgrammeMediaDelivery } from '@videofy-live/shared-types';

export type DelayedPlaybackDecision =
  /** Play the cursor-governed segments. Realtime must not be attached. */
  | { readonly kind: 'delayed'; readonly manifestUrl: string; readonly programmeRunId: string }
  /**
   * Protected, and not yet playable. NOT a licence to use realtime: the
   * viewer waits and is told why.
   */
  | { readonly kind: 'delayed-unavailable'; readonly reason: string; readonly programmeRunId: string }
  /** Ordinary realtime delivery. */
  | { readonly kind: 'realtime' };

export function decideDelayedPlayback(
  delivery: ProgrammeMediaDelivery | undefined,
): DelayedPlaybackDecision {
  /*
   * NO ANSWER MEANS REALTIME. Deliberate, and safe only because the gateway
   * refuses to relay a protected run regardless of what a client believes: a
   * viewer who guesses wrong here receives nothing, rather than receiving the
   * studio. The protection does not depend on the client being correct.
   */
  if (delivery === undefined) return { kind: 'realtime' };
  if (delivery.mode === 'live') return { kind: 'realtime' };
  if (delivery.readiness === 'ready') {
    return {
      kind: 'delayed',
      manifestUrl: delivery.publicManifestUrl,
      programmeRunId: delivery.programmeRunId,
    };
  }
  return {
    kind: 'delayed-unavailable',
    reason: delivery.reason,
    programmeRunId: delivery.programmeRunId,
  };
}

/** The delivery answer carried on a media state, if it has one. */
export function deliveryFromMediaState(
  state: Pick<MediaStateEvent, 'mediaDelivery'> | null | undefined,
): ProgrammeMediaDelivery | undefined {
  return state?.mediaDelivery;
}

/**
 * Should the realtime remote stream be bound to the video element?
 *
 * False for anything protected, including while it is unavailable. Binding it
 * would put realtime media on the element the delayed player owns -- two
 * sources, one element -- and on a protected run the realtime one is exactly
 * what the audience must not have.
 */
export function mayBindRealtimeStream(decision: DelayedPlaybackDecision): boolean {
  return decision.kind === 'realtime';
}

/** What a viewer is told while a protected programme is not yet playable. */
export function unavailableMessage(decision: DelayedPlaybackDecision): string | null {
  if (decision.kind !== 'delayed-unavailable') return null;
  /*
   * The run's own words. Rewriting them here would give a viewer a second
   * vocabulary for the same states, and an operator reading a support message
   * would not be able to match it to anything the console says.
   */
  return decision.reason;
}
