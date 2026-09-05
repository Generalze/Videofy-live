/** @author masterzee001 */
/**
 * How Replay reports that it could not do something, without ending a show.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is a recording problem taking a
 * broadcast off air. A replay is a by-product: the audience watching live has
 * no stake in whether an object store answered, and the day it does not must
 * not be the day a programme stops. An archive that signalled by throwing
 * would put that decision inside whichever `catch` the live path happened to
 * have, which is to say inside nobody's decision at all.
 *
 * So every operation on the Replay port is TOTAL: it answers with a value.
 * Refusals are ordinary results, they carry a machine-readable reason so the
 * caller can decide what to do, and they carry an explicit statement that the
 * live programme is unaffected.
 */

/**
 * Why a replay could not be made, in terms a machine can act on.
 *
 * Prose is not enough. The future caller of this port has to decide whether to
 * retry, whether to alert, and whether the programme status should mention
 * anything at all, and it cannot do that by matching sentences.
 */
export type ReplayFailureReason =
  /** `expire` with no usable instant, or an expiry that is not in the future. */
  | 'retention-configuration-invalid'
  /** The operator asked for no replay. Not a fault; a refusal. */
  | 'policy-forbids-replay'
  /** Media from one run was offered to another run's replay. */
  | 'run-mismatch'
  /** A segment that cannot begin a playback: not keyframe-aligned, or empty. */
  | 'segment-invalid'
  /**
   * A segment id was offered twice describing different media.
   *
   * SEPARATE FROM `segment-invalid` because the two demand different actions.
   * An invalid segment is one the encoder should not have produced; a
   * conflicting one means two producers disagree about what a segment id
   * MEANS, and the recording cannot be trusted until somebody finds out which
   * of them is right.
   */
  | 'segment-conflict'
  /** A retained segment needs initialisation material that was never retained. */
  | 'initialisation-missing'
  /** An encoder generation was offered twice with different material. */
  | 'initialisation-conflict'
  /** Finalising something that retained nothing. */
  | 'no-media-retained'
  /** The archive itself could not be read or written. */
  | 'archive-unavailable'
  /**
   * The programme's own media could not be made durable, so the source of the
   * recording is incomplete.
   *
   * DELIBERATELY NOT `archive-unavailable`. That reason says the archive could
   * not be written and the material was fine; this one says the material was
   * never there to write. They call for opposite responses -- retry the
   * archive, versus never trust this recording again -- and an operator
   * looking at a failed replay has no other way to tell which happened.
   */
  | 'source-media-unavailable'
  /**
   * The encoder producing this broadcast stopped without being asked to.
   *
   * A recording that ends here is TRUNCATED, and the difference between this
   * and an ordinary finish is the whole point of having the reason: a
   * deliberate stop finalises a complete replay, and an encoder that died
   * leaves one that must never be called available.
   */
  | 'media-origin-failed'
  /** The move asked for is not one this state permits. */
  | 'lifecycle-transition-refused'
  /** No replay was ever begun for this run. */
  | 'unknown-replay';

export const REPLAY_FAILURE_REASONS: readonly ReplayFailureReason[] = [
  'retention-configuration-invalid',
  'policy-forbids-replay',
  'run-mismatch',
  'segment-invalid',
  'segment-conflict',
  'initialisation-missing',
  'initialisation-conflict',
  'no-media-retained',
  'archive-unavailable',
  'source-media-unavailable',
  'media-origin-failed',
  'lifecycle-transition-refused',
  'unknown-replay',
];

/**
 * What a Replay failure costs the live broadcast: nothing, ever.
 *
 * A LITERAL RATHER THAN A BOOLEAN, deliberately. A boolean invites a future
 * edit to set it true for the one failure that "obviously" ought to stop a
 * programme, and that edit reads as a one-word diff. There is no other value
 * to give this, so a replay failure that demands a broadcast end cannot be
 * constructed. If Replay ever genuinely needs to, that is a type change and a
 * conversation, not an accident.
 */
export const REPLAY_FAILURE_LIVE_IMPACT = 'none';

export interface ReplayFailure {
  readonly reason: ReplayFailureReason;
  /** For an operator. Never programme content, never a storage secret. */
  readonly detail: string;
  readonly liveImpact: typeof REPLAY_FAILURE_LIVE_IMPACT;
}

export function replayFailure(reason: ReplayFailureReason, detail: string): ReplayFailure {
  return { reason, detail, liveImpact: REPLAY_FAILURE_LIVE_IMPACT };
}

/** The result of asking the archive to do something. Total; never thrown. */
export type ReplayOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ReplayFailure };

export function replayOk<T>(value: T): ReplayOutcome<T> {
  return { ok: true, value };
}

export function replayRefused<T>(reason: ReplayFailureReason, detail: string): ReplayOutcome<T> {
  return { ok: false, failure: replayFailure(reason, detail) };
}

/**
 * Call an archive without letting it reach the broadcast.
 *
 * The port promises not to throw. A durable implementation written later --
 * against a filesystem, an object store, somebody else's SDK -- can break that
 * promise by accident, and the place it would break it is inside a live
 * programme's segment handler. This turns any escape into the ordinary refusal
 * the caller already handles, so the guarantee holds even where the
 * implementation does not.
 */
export async function withoutFailingTheProgramme<T>(
  operation: () => Promise<ReplayOutcome<T>>,
): Promise<ReplayOutcome<T>> {
  try {
    return await operation();
  } catch (error) {
    return replayRefused(
      'archive-unavailable',
      `the replay archive threw instead of refusing: ${describeError(error)}`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
