/** @author masterzee001 */
/**
 * Who decided, and what happens when nobody did.
 *
 * THE PROPERTY THIS SUITE EXISTS FOR: there is no fallback. A channel with no
 * settings resolves to a refusal. Falling back to `none` would look safe and
 * would silently stop recording a channel whose configuration failed to load;
 * falling back to `keep` would record broadcasts nobody asked to keep. Both are
 * decisions, and a test is the only thing that stops one being reintroduced as
 * a convenience.
 *
 * The second property is that a forbidden override is REFUSED rather than
 * ignored: quietly applying the channel default to a programme that asked for
 * something else leaves an operator believing one thing is happening while
 * another is.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_REPLAY_DURATION_DAYS,
  overrideIsEmpty,
  resolveReplayPolicy,
  validateChannelReplaySettings,
  validateProgrammeReplayOverride,
  type ChannelReplaySettings,
  type ProgrammeReplayOverride,
} from './index.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function settings(overrides: Partial<ChannelReplaySettings> = {}): ChannelReplaySettings {
  return {
    channelId: 'ch_1',
    defaultPolicy: 'keep',
    defaultDurationDays: null,
    defaultVisibility: 'unlisted',
    allowOverrides: true,
    ...overrides,
  };
}

function resolved(
  channel: ChannelReplaySettings | null,
  override: ProgrammeReplayOverride | null = null,
  startedAtMs = STARTED,
) {
  const outcome = resolveReplayPolicy(channel, override, startedAtMs);
  if (!outcome.ok) throw new Error(`unexpectedly refused: ${outcome.detail}`);
  return outcome.value;
}

/* ============================================================== no defaults */

describe('nobody gets a policy they did not choose', () => {
  it('refuses to resolve a channel that has no settings', () => {
    const outcome = resolveReplayPolicy(null, null, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('channel-unconfigured');
  });

  it('does not quietly become "keep nothing"', () => {
    // The tempting fallback. It looks safe and it silently stops recording a
    // channel whose configuration failed to load.
    const outcome = resolveReplayPolicy(null, null, STARTED);
    expect(JSON.stringify(outcome)).not.toContain('"policy"');
  });

  it('does not quietly become "keep everything" either', () => {
    const outcome = resolveReplayPolicy(null, { policy: 'keep' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    // An override cannot conjure a channel that was never configured.
    expect(outcome.refusal).toBe('channel-unconfigured');
  });
});

/* =========================================================== channel policy */

describe('what a channel has standing instructions to do', () => {
  it('keeps indefinitely', () => {
    const decision = resolved(settings({ defaultPolicy: 'keep' }));
    expect(decision.retention).toEqual({ policy: 'keep' });
    expect(decision.retentionSource).toBe('channel-default');
  });

  it('keeps nothing', () => {
    const decision = resolved(settings({ defaultPolicy: 'none' }));
    expect(decision.retention).toEqual({ policy: 'none' });
  });

  it('turns a duration in days into an instant measured from this broadcast', () => {
    /*
     * A CLOCK WOULD BE WRONG. Two programmes configured identically and aired
     * an hour apart must expire an hour apart, which is what "kept for thirty
     * days" actually means to the person who set it.
     */
    const decision = resolved(settings({ defaultPolicy: 'expire', defaultDurationDays: 30 }));
    expect(decision.retention).toEqual({
      policy: 'expire',
      expiresAtMs: STARTED + 30 * DAY_MS,
    });

    const later = resolved(
      settings({ defaultPolicy: 'expire', defaultDurationDays: 30 }),
      null,
      STARTED + 3_600_000,
    );
    if (later.retention.policy !== 'expire') throw new Error('unreachable');
    expect(later.retention.expiresAtMs).toBe(STARTED + 3_600_000 + 30 * DAY_MS);
  });

  it('carries each visibility tier through', () => {
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      const decision = resolved(settings({ defaultVisibility: visibility }));
      expect(decision.visibility).toBe(visibility);
      expect(decision.visibilitySource).toBe('channel-default');
    }
  });
});

/* ============================================================== validation */

describe('settings that do not make sense together', () => {
  it('refuses expire with no duration', () => {
    expect(validateChannelReplaySettings(settings({ defaultPolicy: 'expire' }))).toContain(
      'requires a duration',
    );
  });

  it('refuses a duration attached to keep or none', () => {
    // Somebody who set one believed the recording would be released after it.
    // Silently keeping it forever is the expensive way to be wrong.
    for (const policy of ['keep', 'none'] as const) {
      expect(
        validateChannelReplaySettings(settings({ defaultPolicy: policy, defaultDurationDays: 7 })),
      ).toContain('cannot carry a duration');
    }
  });

  it('refuses a duration that is not a whole positive number of days', () => {
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validateChannelReplaySettings(
          settings({ defaultPolicy: 'expire', defaultDurationDays: days }),
        ),
      ).not.toBeNull();
    }
  });

  it('refuses a duration beyond what an instant can be reasoned about', () => {
    expect(
      validateChannelReplaySettings(
        settings({ defaultPolicy: 'expire', defaultDurationDays: MAX_REPLAY_DURATION_DAYS + 1 }),
      ),
    ).toContain('use keep');
    expect(
      validateChannelReplaySettings(
        settings({ defaultPolicy: 'expire', defaultDurationDays: MAX_REPLAY_DURATION_DAYS }),
      ),
    ).toBeNull();
  });

  it('refuses a policy or visibility it has never heard of', () => {
    expect(
      validateChannelReplaySettings(settings({ defaultPolicy: 'forever' as never })),
    ).toContain('unknown replay policy');
    expect(
      validateChannelReplaySettings(settings({ defaultVisibility: 'locked' as never })),
    ).toContain('unknown replay visibility');
  });

  it('refuses to resolve against settings that are already wrong', () => {
    const outcome = resolveReplayPolicy(settings({ defaultPolicy: 'expire' }), null, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-channel-settings');
  });
});

/* =============================================================== overrides */

describe('what one programme may ask for instead', () => {
  it('uses the channel settings when nothing is asked', () => {
    const decision = resolved(settings({ defaultPolicy: 'expire', defaultDurationDays: 7 }));
    expect(decision.retentionSource).toBe('channel-default');
    expect(decision.visibilitySource).toBe('channel-default');
  });

  it('treats an empty override as no override at all', () => {
    expect(overrideIsEmpty(null)).toBe(true);
    expect(overrideIsEmpty({})).toBe(true);
    expect(overrideIsEmpty({ visibility: 'public' })).toBe(false);

    const decision = resolved(settings(), {});
    expect(decision.retentionSource).toBe('channel-default');
  });

  it('lets a programme choose its own retention', () => {
    const decision = resolved(settings({ defaultPolicy: 'keep' }), {
      policy: 'expire',
      durationDays: 14,
    });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 14 * DAY_MS });
    expect(decision.retentionSource).toBe('programme-override');
    // And the visibility it did not mention still comes from the channel.
    expect(decision.visibilitySource).toBe('channel-default');
  });

  it('lets a programme choose its own visibility alone', () => {
    const decision = resolved(settings({ defaultVisibility: 'private' }), {
      visibility: 'public',
    });
    expect(decision.visibility).toBe('public');
    expect(decision.visibilitySource).toBe('programme-override');
    expect(decision.retentionSource).toBe('channel-default');
  });

  it('lets a programme choose both', () => {
    const decision = resolved(settings({ defaultPolicy: 'none', defaultVisibility: 'private' }), {
      policy: 'keep',
      visibility: 'unlisted',
    });
    expect(decision.retention).toEqual({ policy: 'keep' });
    expect(decision.visibility).toBe('unlisted');
    expect(decision.retentionSource).toBe('programme-override');
    expect(decision.visibilitySource).toBe('programme-override');
  });

  it('lets one programme keep nothing on a channel that keeps everything', () => {
    const decision = resolved(settings({ defaultPolicy: 'keep' }), { policy: 'none' });
    expect(decision.retention).toEqual({ policy: 'none' });
  });

  it('lets one programme be kept on a channel that keeps nothing', () => {
    const decision = resolved(settings({ defaultPolicy: 'none' }), {
      policy: 'expire',
      durationDays: 3,
    });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 3 * DAY_MS });
  });
});

/* ==================================================== overrides not allowed */

describe('a channel that does not permit overrides', () => {
  const locked = settings({ allowOverrides: false, defaultPolicy: 'keep' });

  it('refuses a retention override explicitly', () => {
    const outcome = resolveReplayPolicy(locked, { policy: 'none' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('overrides-forbidden');
  });

  it('refuses a visibility override explicitly', () => {
    const outcome = resolveReplayPolicy(locked, { visibility: 'public' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('overrides-forbidden');
  });

  it('never silently applies the channel default instead', () => {
    /*
     * THE FAILURE THIS PREVENTS. Ignoring the request would resolve happily to
     * `keep` and leave the operator believing their programme was private, or
     * unrecorded, when it was neither.
     */
    const outcome = resolveReplayPolicy(locked, { policy: 'none' }, STARTED);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('"retention"');
  });

  it('still resolves a programme that asks for nothing', () => {
    const decision = resolved(locked, {});
    expect(decision.retention).toEqual({ policy: 'keep' });
  });
});

/* ========================================================= invalid override */

describe('a programme asking for something unusable', () => {
  it('refuses expire with no duration', () => {
    const outcome = resolveReplayPolicy(settings(), { policy: 'expire' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
  });

  it('refuses a duration attached to keep', () => {
    const outcome = resolveReplayPolicy(settings(), { policy: 'keep', durationDays: 5 }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
  });

  it('refuses a duration that is not a sensible number of days', () => {
    for (const days of [0, -3, 2.5, MAX_REPLAY_DURATION_DAYS + 1]) {
      const outcome = resolveReplayPolicy(
        settings(),
        { policy: 'expire', durationDays: days },
        STARTED,
      );
      expect(outcome.ok, String(days)).toBe(false);
    }
  });

  it('refuses a policy or visibility it has never heard of', () => {
    expect(resolveReplayPolicy(settings(), { policy: 'forever' as never }, STARTED).ok).toBe(false);
    expect(resolveReplayPolicy(settings(), { visibility: 'locked' as never }, STARTED).ok).toBe(
      false,
    );
  });

  it('refuses a start instant that is not a number', () => {
    const outcome = resolveReplayPolicy(
      settings({ defaultPolicy: 'expire', defaultDurationDays: 7 }),
      null,
      Number.NaN,
    );
    expect(outcome.ok).toBe(false);
  });
});

/* ============================================================== the result */

describe('what the resolver hands back', () => {
  it('is exactly what the archive asks for, and nothing else', () => {
    /*
     * No channel id, no row id, no connection detail, no "source" of the
     * settings beyond which half of the decision they came from. The archive
     * wants a retention and a visibility; anything more would be this package
     * leaking how it knows.
     */
    const decision = resolved(settings({ defaultPolicy: 'expire', defaultDurationDays: 30 }));
    expect(Object.keys(decision).sort()).toEqual([
      'retention',
      'retentionSource',
      'visibility',
      'visibilitySource',
    ]);
    const serialised = JSON.stringify(decision);
    expect(serialised).not.toContain('ch_1');
    expect(serialised).not.toContain('channel_replay_settings');
    expect(serialised).not.toContain('durationDays');
  });

  it('produces a retention the frozen archive validator already accepted', () => {
    // The conversion is handed to `decideRetention` rather than checked again
    // here: one definition of a usable retention, in one place.
    const decision = resolved(settings({ defaultPolicy: 'expire', defaultDurationDays: 1 }));
    if (decision.retention.policy !== 'expire') throw new Error('unreachable');
    expect(decision.retention.expiresAtMs).toBeGreaterThan(STARTED);
  });
});

/* ================================================ policy and duration together */

describe('a duration belongs to a policy, and does not outlive it', () => {
  /*
   * THE TRAP THIS MATRIX PINS. Policy and duration arrive as two independent
   * fields, so inheritance can produce a hybrid nobody asked for: a programme
   * overriding a thirty-day channel to `keep` must not quietly carry the thirty
   * days across. `keep` with a duration is not a valid retention, and the
   * failure would land at the archive door instead of here.
   */
  const thirtyDayChannel = settings({ defaultPolicy: 'expire', defaultDurationDays: 30 });
  const keepChannel = settings({ defaultPolicy: 'keep' });

  it('1. overriding expire-30 to keep does not inherit the thirty days', () => {
    const decision = resolved(thirtyDayChannel, { policy: 'keep' });
    expect(decision.retention).toEqual({ policy: 'keep' });
    expect(decision.retention).not.toHaveProperty('expiresAtMs');
    expect(decision.retentionSource).toBe('programme-override');
  });

  it('2. overriding expire-30 to none does not inherit the thirty days', () => {
    const decision = resolved(thirtyDayChannel, { policy: 'none' });
    expect(decision.retention).toEqual({ policy: 'none' });
    expect(decision.retention).not.toHaveProperty('expiresAtMs');
  });

  it('3. overriding keep to expire with its own duration', () => {
    const decision = resolved(keepChannel, { policy: 'expire', durationDays: 7 });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 7 * DAY_MS });
    expect(decision.retentionSource).toBe('programme-override');
  });

  it('4. shortening an expire channel with a duration alone', () => {
    const decision = resolved(thirtyDayChannel, { durationDays: 7 });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 7 * DAY_MS });
    expect(decision.retentionSource).toBe('programme-override');
  });

  it('5. a duration alone cannot turn keep into expire', () => {
    // Somebody sending one meant the recording to be released. Resolving to
    // `keep` regardless would leave them believing it will be.
    const outcome = resolveReplayPolicy(keepChannel, { durationDays: 7 }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
    expect(outcome.detail).toContain('state policy expire');
  });

  it('6. a visibility-only override leaves the retention exactly as the channel set it', () => {
    const decision = resolved(thirtyDayChannel, { visibility: 'public' });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 30 * DAY_MS });
    expect(decision.retentionSource).toBe('channel-default');
    expect(decision.visibilitySource).toBe('programme-override');
  });

  it('7. restating expire without a duration keeps the channel duration', () => {
    const decision = resolved(thirtyDayChannel, { policy: 'expire' });
    expect(decision.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + 30 * DAY_MS });
    expect(decision.retentionSource).toBe('programme-override');
  });

  it('refuses expire when neither side states a duration', () => {
    const outcome = resolveReplayPolicy(keepChannel, { policy: 'expire' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
    expect(outcome.detail).toContain('neither the override nor the channel');
  });

  it('refuses expire whose duration was explicitly cleared', () => {
    const outcome = resolveReplayPolicy(
      thirtyDayChannel,
      { policy: 'expire', durationDays: null },
      STARTED,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
  });

  it('accepts a null duration alongside a policy that has none', () => {
    // Saying "keep, and no duration" is consistent, if redundant.
    const decision = resolved(thirtyDayChannel, { policy: 'keep', durationDays: null });
    expect(decision.retention).toEqual({ policy: 'keep' });
  });

  it('never produces a retention carrying a duration it should not have', () => {
    // The whole matrix as one statement: whatever the pair of inputs, an
    // expiry appears only on `expire`.
    for (const channel of [thirtyDayChannel, keepChannel, settings({ defaultPolicy: 'none' })]) {
      for (const override of [
        null,
        {},
        { policy: 'keep' as const },
        { policy: 'none' as const },
        { visibility: 'public' as const },
      ]) {
        const outcome = resolveReplayPolicy(channel, override, STARTED);
        if (!outcome.ok) continue;
        const carriesExpiry = 'expiresAtMs' in outcome.value.retention;
        expect(carriesExpiry, JSON.stringify({ channel: channel.defaultPolicy, override })).toBe(
          outcome.value.retention.policy === 'expire',
        );
      }
    }
  });
});

/* ============================================== an override, shaped correctly */

describe('an override is checked for shape before it is asked to resolve', () => {
  /*
   * TWO DIFFERENT QUESTIONS, and the tests below keep them apart on purpose.
   * Shape says the values are values. Resolution says they make sense against a
   * particular channel. A store needs the first before it can write a row; an
   * operator needs the second before they go on air.
   */
  it('accepts an empty override', () => {
    // "Nothing to say" is a valid thing to say; what a caller does with it --
    // store it, or delete the row -- is a storage decision, not a validity one.
    expect(validateProgrammeReplayOverride({})).toBeNull();
    expect(overrideIsEmpty({})).toBe(true);
  });

  it('accepts each field on its own', () => {
    expect(validateProgrammeReplayOverride({ policy: 'keep' })).toBeNull();
    expect(validateProgrammeReplayOverride({ visibility: 'private' })).toBeNull();
    expect(validateProgrammeReplayOverride({ durationDays: 7 })).toBeNull();
    expect(validateProgrammeReplayOverride({ durationDays: null })).toBeNull();
  });

  it('refuses a policy or visibility it does not recognise', () => {
    expect(
      validateProgrammeReplayOverride({ policy: 'forever' as unknown as 'keep' }),
    ).toContain('unknown replay policy');
    expect(
      validateProgrammeReplayOverride({ visibility: 'locked' as unknown as 'public' }),
    ).toContain('unknown replay visibility');
  });

  it('refuses a channel access tier offered as a replay tier', () => {
    // `locked` is a CHANNEL tier and has no meaning for a stored object. A
    // store that accepted it would hold a value nothing downstream can read.
    expect(validateProgrammeReplayOverride({ visibility: 'locked' as never })).not.toBeNull();
  });

  it('refuses a duration that is not a whole usable number of days', () => {
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateProgrammeReplayOverride({ durationDays: days }), String(days)).not.toBeNull();
    }
    expect(validateProgrammeReplayOverride({ durationDays: MAX_REPLAY_DURATION_DAYS })).toBeNull();
    expect(
      validateProgrammeReplayOverride({ durationDays: MAX_REPLAY_DURATION_DAYS + 1 }),
    ).toContain('at most');
  });

  it('does not judge the pairing, which is what resolution is for', () => {
    /*
     * `keep` with a duration is SHAPED fine and RESOLVES to a refusal. Making
     * shape validation reject it would put the same rule in two places and let
     * them drift; the refusal an operator sees still comes from the resolver.
     */
    expect(validateProgrammeReplayOverride({ policy: 'keep', durationDays: 7 })).toBeNull();
    const outcome = resolveReplayPolicy(settings(), { policy: 'keep', durationDays: 7 }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('invalid-override');
  });

  it('a shaped override on a channel that forbids overrides is still refused', () => {
    // Shape is not permission. The channel decides whether anybody may differ.
    expect(validateProgrammeReplayOverride({ policy: 'none' })).toBeNull();
    const outcome = resolveReplayPolicy(
      settings({ allowOverrides: false }),
      { policy: 'none' },
      STARTED,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('overrides-forbidden');
  });
});
