/** @author masterzee001 */
/**
 * What the operator asked us to keep, for how long, and who may watch it.
 *
 * REPLAY RETENTION IS NOT LIVE RETENTION. The live spool keeps seconds so a
 * cursor can be held behind the live edge; it is derived from the configured
 * delay and it is pruned as the audience advances. Replay retention keeps a
 * finished broadcast for hours, days or forever, it is chosen rather than
 * derived, and it has to survive the exact moment the spool cleans up. Nothing
 * in this file refers to the delay, the retention window or the margin, and
 * nothing in this file should ever start to: a replay whose lifetime moved
 * because somebody changed a delay grade would be a broadcast quietly deleted
 * by an unrelated setting.
 */

import { replayOk, replayRefused, type ReplayOutcome } from './outcome.js';

/**
 * What the operator asked us to do with the recording.
 *
 *   keep   - retain it until somebody deletes it. No clock, no worker.
 *   expire - retain it until a stated instant, then let it go.
 *   none   - produce no replay at all. The broadcast happens and nothing of
 *            it is kept.
 *
 * `none` is a first-class policy rather than the absence of configuration,
 * because "the operator chose not to keep this" and "nobody has decided yet"
 * are different facts and only one of them is safe to act on.
 */
export type ReplayPolicy = 'keep' | 'expire' | 'none';

/** The policies, in the order a picker would show them. */
export const REPLAY_POLICIES: readonly ReplayPolicy[] = ['keep', 'expire', 'none'];

export function isReplayPolicy(value: unknown): value is ReplayPolicy {
  return typeof value === 'string' && (REPLAY_POLICIES as readonly string[]).includes(value);
}

/**
 * Who may watch the recording.
 *
 *   public   - listed and open.
 *   unlisted - not listed; the link is what admits a viewer.
 *   private  - the owner only.
 *
 * DELIBERATELY NOT `ChannelVisibility`. The channel tiers are public/private/
 * locked, where that `private` means unlisted-but-linkable and `locked` is the
 * one that actually controls access. A replay is a stored object rather than a
 * door, so its middle tier is named for what it is. Reusing the channel type
 * would have made a private replay silently mean a linkable one, which is
 * precisely the mistake worth spending a second type to prevent.
 *
 * Visibility is an axis of its own and never a lifecycle state: making a
 * replay private hides it, and must never be confused with destroying it.
 */
export type ReplayVisibility = 'public' | 'unlisted' | 'private';

export const REPLAY_VISIBILITIES: readonly ReplayVisibility[] = ['public', 'unlisted', 'private'];

export function isReplayVisibility(value: unknown): value is ReplayVisibility {
  return typeof value === 'string' && (REPLAY_VISIBILITIES as readonly string[]).includes(value);
}

/*
 * THERE ARE DELIBERATELY NO DEFAULTS HERE.
 *
 * A `DEFAULT_REPLAY_POLICY` in this package would be channel policy invented
 * by the media layer. It reads as a safe fallback and behaves as a decision:
 * a configuration lookup that failed would silently become a policy, and the
 * difference between "the operator chose not to record this" and "we could not
 * find out what the operator chose" would stop existing at exactly the moment
 * somebody needed it.
 *
 * Policy and visibility are EXPLICIT INPUTS to this domain. Resolving them --
 * channel default, then any per-stream override -- belongs to the channel
 * layer in a later wave, and that layer fails closed when it cannot. Until it
 * exists, a caller that cannot state a policy must not begin a recording.
 */

/**
 * The policy and everything that policy requires, as one indivisible value.
 *
 * A `policy` field beside an optional `expiresAtMs` field lets `expire` exist
 * with no expiry -- a replay that is meant to be let go at a time nobody
 * recorded, which in practice means kept forever while claiming otherwise. The
 * union makes that unrepresentable: an `expire` retention that does not carry
 * an instant cannot be constructed at all.
 */
export type ReplayRetention =
  | { readonly policy: 'keep' }
  | { readonly policy: 'expire'; readonly expiresAtMs: number }
  | { readonly policy: 'none' };

/** The instant a retention ends, or null when it never does. */
export function expiryOf(retention: ReplayRetention): number | null {
  return retention.policy === 'expire' ? retention.expiresAtMs : null;
}

/** Whether this retention keeps anything at all. */
export function retainsMedia(retention: ReplayRetention): boolean {
  return retention.policy !== 'none';
}

/**
 * What a caller outside this package supplies: a policy and maybe an instant.
 *
 * Loose on purpose. Channel defaults and per-stream overrides arrive from a
 * database and an HTTP body in a later wave, and the boundary that turns two
 * separate fields into one coherent retention has to exist before they do.
 */
export interface ReplayRetentionRequest {
  readonly policy: ReplayPolicy;
  /** Required when the policy is `expire`. Refused with any other policy. */
  readonly expiresAtMs?: number | undefined;
}

/**
 * Turn an untrusted policy-and-instant into a retention, or refuse it.
 *
 * AN EXPIRY ON A `keep` REPLAY IS REFUSED rather than ignored. Somebody who
 * sent one believed the recording would be let go, and silently keeping it
 * forever is the more expensive of the two ways to be wrong -- it is also the
 * one nobody notices until a storage bill or a retention promise says so.
 *
 * AN EXPIRY THAT IS NOT IN THE FUTURE IS REFUSED. Accepting it would create a
 * replay born already expired: a recording that a broadcast spent its whole
 * length writing and that nothing will ever serve.
 */
export function decideRetention(
  request: ReplayRetentionRequest,
  startedAtMs: number,
): ReplayOutcome<ReplayRetention> {
  if (!isReplayPolicy(request.policy)) {
    return replayRefused(
      'retention-configuration-invalid',
      `unknown replay policy ${JSON.stringify(request.policy)}`,
    );
  }

  if (request.policy !== 'expire') {
    if (request.expiresAtMs !== undefined) {
      return replayRefused(
        'retention-configuration-invalid',
        `policy ${request.policy} cannot carry an expiry; only expire may state one`,
      );
    }
    return replayOk(request.policy === 'keep' ? { policy: 'keep' } : { policy: 'none' });
  }

  const expiresAtMs = request.expiresAtMs;
  if (expiresAtMs === undefined) {
    return replayRefused(
      'retention-configuration-invalid',
      'policy expire requires an expiry instant and none was given',
    );
  }
  if (!Number.isFinite(expiresAtMs)) {
    return replayRefused(
      'retention-configuration-invalid',
      `policy expire was given a non-finite expiry: ${String(expiresAtMs)}`,
    );
  }
  if (expiresAtMs <= startedAtMs) {
    return replayRefused(
      'retention-configuration-invalid',
      `policy expire was given an expiry at or before the start: ${expiresAtMs} <= ${startedAtMs}`,
    );
  }

  return replayOk({ policy: 'expire', expiresAtMs });
}
