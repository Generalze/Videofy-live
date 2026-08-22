/**
 * WHICH playback path owns translated audio for a session. Exactly one.
 *
 * THE TRAP THIS EXISTS TO CLOSE. Both clients already have a mature
 * finished-file path: the call has its clip queue, the viewer has its
 * programme-clock queue. Wiring a progressive player beside them without
 * deciding who is in charge means an utterance can arrive twice -- once as
 * frames and once as a URL -- and a listener hears every sentence spoken twice,
 * slightly out of step with itself.
 *
 * AND NOT BY RACE. "Whichever event arrives first wins" is the tempting fix and
 * the wrong one: it makes audible behaviour depend on network timing, so the
 * bug reproduces on one machine and not another, and the fix that works today
 * stops working when a provider gets faster.
 *
 * The authority follows the SESSION'S OWN CONFIGURATION. It is knowable before
 * either event arrives, it is the same answer every time, and it is the same
 * answer on every machine.
 */

export type TranslatedAudioAuthority = 'progressive' | 'finished-file' | 'none';

export interface TranslatedAudioAuthorityInput {
  /**
   * Which product this session is. `programme/uploaded` has a complete file by
   * definition and is never progressive.
   */
  readonly serviceCategory: 'call' | 'programme';
  readonly mediaMode: 'live' | 'uploaded';
  /**
   * Whether the deployment actually cut the live path over.
   *
   * Absent means the realtime ingress is not configured, so no frames will ever
   * arrive and the finished-file path is genuinely the only one. This is
   * deployment state, not a guess about what might turn up.
   */
  readonly realtimeConfigured: boolean;
  /** Translated speech is off entirely for this listener or call. */
  readonly translationEnabled: boolean;
}

/**
 * Resolve the one authority for a session.
 *
 * `none` is a real answer: a call in `original` mode, or one whose call mode is
 * `normal`, plays no translated audio through either path.
 */
export function resolveTranslatedAudioAuthority(
  input: TranslatedAudioAuthorityInput,
): TranslatedAudioAuthority {
  if (!input.translationEnabled) return 'none';
  // An upload already has a finished file. Nothing about it is progressive, and
  // routing it through a realtime path would be architecture for its own sake.
  if (input.mediaMode === 'uploaded') return 'finished-file';
  // Live, and the deployment cut over: frames are the authority and the
  // finished-file events for the same work must be ignored.
  if (input.realtimeConfigured) return 'progressive';
  // Live, not cut over. The legacy path is deliberately retained -- development
  // and explicitly-degraded deployments still need it.
  return 'finished-file';
}

/**
 * Should this client ACT on a finished-file translated-audio event?
 *
 * Called by the existing clip queues. Returning false is how a progressive
 * session ignores a legacy event for work its frames already carried, without
 * either path having to know the other exists.
 */
export function finishedFileAudioAllowed(authority: TranslatedAudioAuthority): boolean {
  return authority === 'finished-file';
}

/** Should this client act on a progressive translated-audio frame? */
export function progressiveAudioAllowed(authority: TranslatedAudioAuthority): boolean {
  return authority === 'progressive';
}
