/** @author masterzee001 */
/**
 * Who decides whether a broadcast is kept, and for how long.
 *
 * WHY THIS IS NOT IN `programme-replay`. That package refuses to invent a
 * policy: it has no default retention and no default visibility, because "the
 * operator chose not to keep this" and "nobody has decided yet" are different
 * facts and only one of them is safe to act on. A settings lookup that failed
 * must never quietly become a decision.
 *
 * But somebody does have to decide, and this is where that happens: a channel's
 * standing preference, an optional per-programme override, and a resolver that
 * turns the pair into the explicit `ReplayRetention` and `ReplayVisibility` the
 * archive demands before a recording may be opened. The Replay domain stays
 * default-free; the defaults live here, where they are visibly a product choice
 * rather than a fallback nobody noticed.
 *
 * NO FALLBACK, ANYWHERE IN THIS FILE. A channel with no settings resolves to a
 * refusal, not to "keep nothing" and not to "keep everything". Both of those
 * are decisions, and inventing one on a caller's behalf is how an operator ends
 * up with recordings they never asked for, or discovers months later that none
 * were made.
 *
 * STORAGE-NEUTRAL. No database, no filesystem, no clock but the instant a
 * caller passes in. Where the settings are kept is the account service's
 * business; converting them into a decision is this package's.
 */

import {
  decideRetention,
  isReplayPolicy,
  isReplayVisibility,
  type ReplayPolicy,
  type ReplayRetention,
  type ReplayVisibility,
} from '@videofy-live/programme-replay';

/** Milliseconds in a day, for turning an operator's "30 days" into an instant. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The longest retention an operator may state in days.
 *
 * Not a policy about what is reasonable to keep -- `keep` has no limit at all
 * and is the way to say "forever". This is arithmetic hygiene: a duration large
 * enough to push an expiry past what a double represents exactly would produce
 * an instant that compares strangely, and a recording whose expiry cannot be
 * reasoned about is worse than one that was refused.
 */
export const MAX_REPLAY_DURATION_DAYS = 3_650;

/* ------------------------------------------------------------- the settings */

/**
 * What a channel has standing instructions to do with its broadcasts.
 *
 * `allowOverrides` IS PART OF THE POLICY, not a convenience. A channel that
 * publishes under a retention promise -- or one whose operator simply wants one
 * answer for every programme -- needs a per-programme override to be refused
 * rather than quietly honoured.
 */
export interface ChannelReplaySettings {
  readonly channelId: string;
  readonly defaultPolicy: ReplayPolicy;
  /** Required by `expire`, and meaningless for anything else. */
  readonly defaultDurationDays: number | null;
  readonly defaultVisibility: ReplayVisibility;
  readonly allowOverrides: boolean;
}

/**
 * What one programme asks for instead, if anything.
 *
 * DELIBERATELY THE SAME VOCABULARY as the channel: a policy and a duration in
 * days, never a concrete instant. An override carrying its own `expiresAtMs`
 * would be a second way to say the same thing, with a second place for the
 * conversion to be wrong -- and the conversion is where a stale or impossible
 * expiry gets caught.
 *
 * Every field optional and independent: overriding the visibility of a
 * programme should not force its retention to be restated.
 */
export interface ProgrammeReplayOverride {
  readonly policy?: ReplayPolicy;
  readonly durationDays?: number | null;
  readonly visibility?: ReplayVisibility;
}

/** Whether an override says anything at all. An empty one is not an override. */
export function overrideIsEmpty(override: ProgrammeReplayOverride | null | undefined): boolean {
  if (override === null || override === undefined) return true;
  return (
    override.policy === undefined &&
    override.durationDays === undefined &&
    override.visibility === undefined
  );
}

/* ------------------------------------------------------------- the outcome */

export type ReplayPolicyRefusal =
  /** This channel has no settings. Not a reason to guess one. */
  | 'channel-unconfigured'
  /** The stored settings do not make sense together. */
  | 'invalid-channel-settings'
  /** A programme asked to differ from a channel that does not permit it. */
  | 'overrides-forbidden'
  /** The programme asked for something that is not a usable policy. */
  | 'invalid-override';

/** Where each half of the decision came from. Kept so an audit can say. */
export type ReplayPolicySource = 'channel-default' | 'programme-override';

export interface ResolvedReplayPolicy {
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly retentionSource: ReplayPolicySource;
  readonly visibilitySource: ReplayPolicySource;
}

export type ReplayPolicyResolution =
  | { readonly ok: true; readonly value: ResolvedReplayPolicy }
  | { readonly ok: false; readonly refusal: ReplayPolicyRefusal; readonly detail: string };

function refuse(refusal: ReplayPolicyRefusal, detail: string): ReplayPolicyResolution {
  return { ok: false, refusal, detail };
}

/* ------------------------------------------------------------- validation */

export type SettingsProblem = string | null;

/**
 * Whether a set of channel settings is coherent.
 *
 * SHARED BY THE WRITE AND THE READ. The database enforces the same rules with
 * CHECK constraints, and this is what refuses them one layer earlier with a
 * sentence an operator can act on. Neither is redundant: a constraint catches
 * anything that reaches the table by another route, and a message catches the
 * operator's typo before it becomes an error code.
 */
export function validateChannelReplaySettings(
  settings: ChannelReplaySettings,
): SettingsProblem {
  if (settings.channelId.trim() === '') return 'a channel id is required';
  if (!isReplayPolicy(settings.defaultPolicy)) {
    return `unknown replay policy ${JSON.stringify(settings.defaultPolicy)}`;
  }
  if (!isReplayVisibility(settings.defaultVisibility)) {
    return `unknown replay visibility ${JSON.stringify(settings.defaultVisibility)}`;
  }
  return durationProblem(settings.defaultPolicy, settings.defaultDurationDays);
}

/**
 * Whether a duration belongs with this policy, and is usable if it does.
 *
 * A DURATION ON `keep` OR `none` IS REFUSED rather than ignored. Somebody who
 * set one believed the recording would be released after it, and silently
 * keeping it forever is the more expensive way to be wrong -- and the one
 * nobody notices until a storage bill or a retention promise says so.
 */
function durationProblem(policy: ReplayPolicy, durationDays: number | null): SettingsProblem {
  if (policy !== 'expire') {
    return durationDays === null || durationDays === undefined
      ? null
      : `policy ${policy} cannot carry a duration; only expire may state one`;
  }
  if (durationDays === null || durationDays === undefined) {
    return 'policy expire requires a duration in days and none was given';
  }
  if (!Number.isFinite(durationDays) || !Number.isInteger(durationDays)) {
    return `policy expire requires a whole number of days, not ${String(durationDays)}`;
  }
  if (durationDays < 1) return 'policy expire requires at least one day';
  if (durationDays > MAX_REPLAY_DURATION_DAYS) {
    return `policy expire allows at most ${MAX_REPLAY_DURATION_DAYS} days; use keep to retain indefinitely`;
  }
  return null;
}

/* ------------------------------------------------------------- resolution */

/**
 * Turn a channel's standing instructions and one programme's request into the
 * explicit decision the archive requires.
 *
 * THE ONE PLACE A DURATION BECOMES AN INSTANT. Days are what an operator sets
 * and an instant is what a recording carries, and the conversion needs the
 * broadcast's own start rather than a clock: two programmes configured
 * identically and aired an hour apart expire an hour apart, which is what "kept
 * for thirty days" actually means.
 *
 * The result is handed to `decideRetention` -- the frozen validator the archive
 * itself uses -- rather than checked again here. One definition of a usable
 * retention, in one place.
 */
export function resolveReplayPolicy(
  settings: ChannelReplaySettings | null,
  override: ProgrammeReplayOverride | null,
  startedAtMs: number,
): ReplayPolicyResolution {
  if (settings === null) {
    /*
     * NO SETTINGS IS NOT A POLICY. Falling back to `none` would look safe and
     * would silently stop recording a channel whose configuration failed to
     * load; falling back to `keep` would record broadcasts nobody asked to
     * keep. Both are decisions, and neither is ours to take.
     */
    return refuse(
      'channel-unconfigured',
      'this channel has no replay settings, so there is nothing to resolve',
    );
  }

  const settingsProblem = validateChannelReplaySettings(settings);
  if (settingsProblem !== null) {
    return refuse('invalid-channel-settings', settingsProblem);
  }

  const asked = overrideIsEmpty(override) ? null : override;
  if (asked !== null && !settings.allowOverrides) {
    /*
     * REFUSED, NEVER IGNORED. Quietly applying the channel default to a
     * programme that asked for something else means the operator believes one
     * thing is happening and another is. A refusal is how they find out.
     */
    return refuse(
      'overrides-forbidden',
      `channel ${settings.channelId} does not permit per-programme replay overrides`,
    );
  }

  if (asked !== null) {
    if (asked.policy !== undefined && !isReplayPolicy(asked.policy)) {
      return refuse('invalid-override', `unknown replay policy ${JSON.stringify(asked.policy)}`);
    }
    if (asked.visibility !== undefined && !isReplayVisibility(asked.visibility)) {
      return refuse(
        'invalid-override',
        `unknown replay visibility ${JSON.stringify(asked.visibility)}`,
      );
    }
  }

  /*
   * THE POLICY DECIDES WHETHER THERE IS A DURATION AT ALL.
   *
   * These arrive as two independent fields, and the trap is inheritance: a
   * programme overriding a thirty-day channel to `keep` must not quietly carry
   * the thirty days across, because `keep` with a duration is not a valid
   * retention -- it is a hybrid nobody asked for, and the failure would land at
   * the archive door rather than here.
   *
   * So the effective policy is settled first, and a duration belonging to a
   * policy that has been overridden away does not survive it.
   */
  const policy = asked?.policy ?? settings.defaultPolicy;
  const askedDuration = asked?.durationDays;
  let durationDays: number | null;

  if (policy !== 'expire') {
    if (askedDuration !== undefined && askedDuration !== null) {
      /*
       * A DURATION ALONE CANNOT TURN `keep` INTO `expire`. Somebody sending one
       * meant the recording to be released, and resolving to `keep` regardless
       * would leave them believing it will be. Refused rather than discarded.
       */
      return refuse(
        'invalid-override',
        `policy ${policy} cannot carry a duration; state policy expire to set one`,
      );
    }
    durationDays = null;
  } else if (askedDuration !== undefined && askedDuration !== null) {
    durationDays = askedDuration;
  } else if (askedDuration === null) {
    // Explicitly cleared, which leaves `expire` with nothing to expire at.
    return refuse('invalid-override', 'policy expire requires a duration and none was given');
  } else if (settings.defaultPolicy === 'expire') {
    // A programme restating `expire` without a duration keeps the channel's.
    durationDays = settings.defaultDurationDays;
  } else {
    return refuse(
      'invalid-override',
      'policy expire requires a duration, and neither the override nor the channel states one',
    );
  }

  const usingOverridePolicy = asked?.policy !== undefined || askedDuration !== undefined;
  if (usingOverridePolicy) {
    const problem = durationProblem(policy, durationDays);
    if (problem !== null) return refuse('invalid-override', problem);
  }

  const decided = decideRetention(
    policy === 'expire'
      ? { policy: 'expire', expiresAtMs: startedAtMs + (durationDays ?? 0) * DAY_MS }
      : { policy },
    startedAtMs,
  );
  if (!decided.ok) {
    // The frozen validator refused it -- a start instant that is not a number,
    // an expiry that lands on or before it. Attributed to whichever side asked.
    return refuse(
      usingOverridePolicy ? 'invalid-override' : 'invalid-channel-settings',
      decided.failure.detail,
    );
  }

  return {
    ok: true,
    value: {
      retention: decided.value,
      visibility: asked?.visibility ?? settings.defaultVisibility,
      retentionSource: usingOverridePolicy ? 'programme-override' : 'channel-default',
      visibilitySource: asked?.visibility === undefined ? 'channel-default' : 'programme-override',
    },
  };
}

/* --------------------------------------------------------------- the port */

export type SettingsRefusal = 'invalid-settings' | 'settings-unavailable';

export interface SettingsOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly refusal?: SettingsRefusal;
  readonly detail?: string;
}

/**
 * Where a channel's replay settings are kept.
 *
 * `read` RETURNING NULL IS AN ANSWER, and the important one: this channel has
 * not been configured. It is never an empty set of defaults, because a caller
 * that could not tell those apart would start recording on the strength of a
 * missing row.
 */
export interface ChannelReplaySettingsStore {
  read(channelId: string): Promise<ChannelReplaySettings | null>;
  save(settings: ChannelReplaySettings): Promise<SettingsOutcome<ChannelReplaySettings>>;
}

/* ------------------------------------------------- the programme's override */

/**
 * Whether an override is SHAPED like one, before it is asked to resolve.
 *
 * TWO CHECKS, AND THEY ARE NOT THE SAME CHECK. This one says the values are
 * values: a known policy, a known visibility, a whole number of days inside the
 * bound. `resolveReplayPolicy` says the override MAKES SENSE AGAINST A
 * PARTICULAR CHANNEL -- whether overrides are permitted at all, whether the
 * pair of policy and duration is coherent, whether an inherited duration
 * survives. Neither subsumes the other, and a caller storing an override wants
 * both: the shape so the row is storable, and the resolution so an operator is
 * told now rather than the next time they go on air.
 *
 * AN EMPTY OVERRIDE IS NOT A PROBLEM HERE. It is a perfectly valid statement of
 * "nothing to say", and what a caller does with it -- store it, or delete the
 * row -- is a storage decision rather than a validity one.
 */
export function validateProgrammeReplayOverride(
  override: ProgrammeReplayOverride,
): SettingsProblem {
  if (override.policy !== undefined && !isReplayPolicy(override.policy)) {
    return `unknown replay policy ${JSON.stringify(override.policy)}`;
  }
  if (override.visibility !== undefined && !isReplayVisibility(override.visibility)) {
    return `unknown replay visibility ${JSON.stringify(override.visibility)}`;
  }
  const days = override.durationDays;
  if (days !== undefined && days !== null) {
    if (!Number.isInteger(days)) {
      return `a retention duration must be a whole number of days, not ${String(days)}`;
    }
    if (days < 1) return 'a retention duration must be at least one day';
    if (days > MAX_REPLAY_DURATION_DAYS) {
      return `a retention duration allows at most ${MAX_REPLAY_DURATION_DAYS} days; use keep to retain indefinitely`;
    }
  }
  return null;
}

/**
 * A stored override, and the channel it belongs to.
 *
 * THE CHANNEL IS CARRIED, NOT DERIVED. An override is authorised against the
 * channel that owns the programme, and a store that held only the programme id
 * would make the reader join somewhere else to find out whose it was -- which
 * is the join that gets skipped on the day somebody is in a hurry.
 */
export interface ProgrammeReplayOverrideRecord {
  readonly programmeId: string;
  readonly channelId: string;
  readonly override: ProgrammeReplayOverride;
}

/**
 * Where per-programme overrides are kept.
 *
 * `read` RETURNING NULL MEANS "THIS PROGRAMME ASKED FOR NOTHING", which
 * resolves to the channel's defaults -- unlike a channel with no settings,
 * which resolves to a refusal. The asymmetry is the point: a channel must
 * decide, a programme need not.
 *
 * `clear` IS IDEMPOTENT AND SUCCEEDS ON A PROGRAMME THAT HAD NO OVERRIDE.
 * Removing something that is not there is the state the caller asked for, and
 * an operator pressing "use the channel default" twice has not made a mistake.
 */
export interface ProgrammeReplayOverrideStore {
  read(programmeId: string): Promise<ProgrammeReplayOverrideRecord | null>;
  save(
    record: ProgrammeReplayOverrideRecord,
  ): Promise<SettingsOutcome<ProgrammeReplayOverrideRecord>>;
  clear(programmeId: string): Promise<SettingsOutcome<null>>;
}
