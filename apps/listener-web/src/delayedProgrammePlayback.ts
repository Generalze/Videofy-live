/** @author masterzee001 */
/**
 * Playing a programme that is deliberately behind the studio.
 *
 * A protected programme reaches its audience as segments the C7 cursor has
 * released, and nothing else. This module is the part of that with no browser
 * in it: which playback strategy a client should use, what state the player is
 * in, and where a returning viewer belongs.
 *
 * THE RESUME RULE IS THE WHOLE POINT, and it is satisfied by construction
 * rather than by arithmetic. The public manifest contains ONLY material the
 * cursor has published, so its live edge IS the public position. A player that
 * resumes at the end of this manifest is resuming where the audience is; there
 * is no separate calculation to get wrong, and no way to ask for the studio's
 * position because the studio's position is not in the document.
 *
 * WHAT MUST NEVER HAPPEN: a protected programme falling back to the realtime
 * WebRTC feed because segmented playback failed. That is not a graceful
 * degradation, it is the safety delay switching itself off at the moment
 * something went wrong -- which is exactly when it is most likely to be
 * needed. Every failure here ends in an explicit unavailable state, and the
 * type system has no branch that returns to realtime.
 *
 * AND NO SECOND CLOCK. The player does not compute programme time, does not
 * schedule against a wall clock, and does not decide when a segment is due.
 * Its clock is the media element's, driven by the segments it is given.
 */

/** How this client can play a segmented programme, if at all. */
export type DelayedPlaybackStrategy =
  /** The browser plays HLS itself: Safari, iOS, some smart TVs. */
  | 'native'
  /** Media Source Extensions, driven by an HLS client. */
  | 'mse'
  /** Neither. The viewer is told, and is not quietly handed the live feed. */
  | 'unsupported';

export interface PlaybackCapabilities {
  /** The media element reports it can play an HLS manifest. */
  readonly canPlayNativeHls: boolean;
  /** MediaSource exists and the codecs we produce are supported. */
  readonly mediaSourceSupported: boolean;
}

/**
 * Choose the strategy for this client.
 *
 * NATIVE FIRST WHERE IT EXISTS. On iOS it is the only option that works at
 * all -- MSE is absent in Safari on iPhone -- and where both exist the
 * platform's own pipeline is hardware-accelerated and better behaved on
 * battery than a JavaScript one doing the same job.
 */
export function chooseDelayedPlaybackStrategy(
  capabilities: PlaybackCapabilities,
): DelayedPlaybackStrategy {
  if (capabilities.canPlayNativeHls) return 'native';
  if (capabilities.mediaSourceSupported) return 'mse';
  return 'unsupported';
}

/**
 * Probe a real browser.
 *
 * Kept beside the decision so the two cannot drift, and separated from it so
 * the decision is testable without a DOM. `maybe` is a legitimate answer from
 * `canPlayType` and is treated as yes: it is what Safari returns for HLS.
 */
export function probePlaybackCapabilities(
  createElement: () => { canPlayType(type: string): string },
  mediaSource: unknown,
): PlaybackCapabilities {
  let canPlayNativeHls = false;
  try {
    const support = createElement().canPlayType('application/vnd.apple.mpegurl');
    canPlayNativeHls = support === 'probably' || support === 'maybe';
  } catch {
    canPlayNativeHls = false;
  }
  const source = mediaSource as { isTypeSupported?: (type: string) => boolean } | undefined;
  const mediaSourceSupported =
    typeof source?.isTypeSupported === 'function' &&
    // The codecs the media origin actually produces. Asking about MSE in the
    // abstract says nothing about whether our segments will decode.
    source.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
  return { canPlayNativeHls, mediaSourceSupported };
}

/**
 * What the player is doing, in the words the viewer is owed.
 *
 * `draining` is separate from `playing` because the end of a protected
 * broadcast is not the end of the programme: the studio has stopped and the
 * audience still has the whole delay left to watch. A player that showed
 * "ended" there would cut off the last forty-five seconds of every protected
 * programme.
 */
export type DelayedPlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'rebuffering'
  | 'draining'
  | 'ended'
  | 'failed';

/** What happened, as the player learns it. */
export type PlaybackSignal =
  | 'load-requested'
  | 'first-media'
  | 'stalled'
  | 'resumed'
  /** The manifest says nothing further will be published. */
  | 'drain-began'
  /** The drain finished: the audience has received everything there was. */
  | 'exhausted'
  /** Unrecoverable: the manifest is gone, refused, or the media will not decode. */
  | 'fatal'
  | 'stopped';

/**
 * The state machine.
 *
 * Explicit rather than a pile of booleans, because the states differ in what
 * the viewer is told and one of them -- `failed` -- must never be reachable
 * from a path that also offers realtime.
 */
export function nextPlaybackState(
  current: DelayedPlaybackState,
  signal: PlaybackSignal,
): DelayedPlaybackState {
  if (signal === 'stopped') return 'idle';
  /*
   * A FATAL ERROR IS TERMINAL AND VISIBLE. Not a silent retry loop, and
   * emphatically not a hand-off to the realtime feed: the delay exists
   * precisely for the moments when something has gone wrong.
   */
  if (signal === 'fatal') return 'failed';
  if (current === 'failed') return 'failed';
  if (current === 'ended') return 'ended';

  switch (signal) {
    case 'load-requested':
      return 'loading';
    case 'first-media':
      // A drain that has started keeps its label: the audience is watching
      // the tail of a broadcast that has already stopped.
      return current === 'draining' ? 'draining' : 'playing';
    case 'stalled':
      return current === 'idle' || current === 'loading' ? current : 'rebuffering';
    case 'resumed':
      return current === 'draining' ? 'draining' : 'playing';
    case 'drain-began':
      return 'draining';
    case 'exhausted':
      return 'ended';
  }
}

/** Whether the viewer should be shown a "we are still trying" affordance. */
export function isRecoverable(state: DelayedPlaybackState): boolean {
  return state === 'loading' || state === 'rebuffering';
}

/**
 * Whether a realtime fallback may be offered.
 *
 * ALWAYS FALSE FOR A PROTECTED PROGRAMME. It exists as a function so the rule
 * has one home and one test, rather than being an absence somebody later fills
 * in with a well-meaning `catch` block.
 */
export function mayFallBackToRealtime(mode: 'live' | 'delayed'): boolean {
  return mode === 'live';
}

export interface PublicWindow {
  /** Segment URIs, in programme order, exactly as the manifest lists them. */
  readonly segmentUris: readonly string[];
  /** Total duration the audience may currently reach, in seconds. */
  readonly durationSeconds: number;
  /** True once the manifest says nothing further will be published. */
  readonly complete: boolean;
  /** The initialisation segment, without which no fragment decodes. */
  readonly initUri: string | null;
}

/**
 * Read the public window out of a manifest.
 *
 * Used to decide what to show, and to assert the resume rule: everything in
 * here is already public, so there is no position in this document a viewer
 * is not allowed to reach. That is the property that makes resume correct by
 * construction rather than by a calculation somebody has to keep right.
 */
export function readPublicWindow(manifest: string): PublicWindow {
  const segmentUris: string[] = [];
  let durationSeconds = 0;
  let complete = false;
  let initUri: string | null = null;
  let pending: number | null = null;

  for (const raw of manifest.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const found = /URI="([^"]*)"/u.exec(line);
      initUri = found?.[1] ?? null;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      complete = true;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length));
      pending = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending !== null) {
      segmentUris.push(line);
      durationSeconds += pending;
      pending = null;
    }
  }

  return { segmentUris, durationSeconds, complete, initUri };
}

/**
 * Where a returning viewer starts.
 *
 * The end of the public window, minus a little, so playback begins with a
 * segment or two in hand rather than at the exact edge with nothing buffered.
 * There is no branch that reaches for the studio's position, because the
 * studio's position is not in the manifest this reads.
 */
export const RESUME_BEHIND_SECONDS = 6;

export function resumeOffsetSeconds(window: PublicWindow): number {
  if (window.segmentUris.length === 0) return 0;
  return Math.max(0, window.durationSeconds - RESUME_BEHIND_SECONDS);
}
