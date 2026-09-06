/** @author masterzee001 */
/**
 * What was asked for, and the configurations that are refused rather than
 * quietly repaired.
 *
 * The property under test throughout: a replay's lifetime is a decision
 * somebody made, recorded exactly, and never inferred from anything else --
 * least of all from the live safety delay, which is a different retention
 * measured in seconds and serving a different purpose.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SUPPORTED_DELAY_MS,
  RETENTION_MARGIN_MS,
  retentionWindowMs,
} from '@videofy-live/programme-timeline';
import * as replay from './index.js';
import {
  REPLAY_POLICIES,
  REPLAY_VISIBILITIES,
  decideRetention,
  expiryOf,
  isReplayPolicy,
  isReplayVisibility,
  retainsMedia,
} from './policy.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('the three retention policies', () => {
  it('names exactly keep, expire and none', () => {
    expect([...REPLAY_POLICIES].sort()).toEqual(['expire', 'keep', 'none']);
  });

  it('refuses anything that is not one of them', () => {
    expect(isReplayPolicy('keep')).toBe(true);
    expect(isReplayPolicy('KEEP')).toBe(false);
    expect(isReplayPolicy('forever')).toBe(false);
    expect(isReplayPolicy(undefined)).toBe(false);
  });

  it('keeps nothing under none, and something under the other two', () => {
    expect(retainsMedia({ policy: 'none' })).toBe(false);
    expect(retainsMedia({ policy: 'keep' })).toBe(true);
    expect(retainsMedia({ policy: 'expire', expiresAtMs: STARTED + 1 })).toBe(true);
  });
});

describe('this package invents no policy of its own', () => {
  it('exports no default policy or visibility for a caller to fall back on', () => {
    // A default here would be channel policy invented by the media layer. It
    // reads as a safe fallback and behaves as a decision: a settings lookup
    // that failed would silently become a policy, and "the operator chose not
    // to record this" would stop being distinguishable from "we could not find
    // out what the operator chose".
    const defaults = Object.keys(replay).filter((name) => name.startsWith('DEFAULT_'));
    expect(defaults).toEqual([]);
  });

  it('refuses an absent policy rather than resolving one', () => {
    const decided = decideRetention(
      { policy: undefined as unknown as 'keep' },
      STARTED,
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });

  it('does not treat an unresolved policy as none', () => {
    // The dangerous near-miss: failing closed by inventing `none` would look
    // identical to an operator who genuinely asked for no recording.
    const decided = decideRetention(
      { policy: '' as unknown as 'keep' },
      STARTED,
    );
    expect(decided.ok).toBe(false);
  });
});

describe('the three visibility tiers', () => {
  it('names exactly public, unlisted and private', () => {
    expect([...REPLAY_VISIBILITIES].sort()).toEqual(['private', 'public', 'unlisted']);
  });

  it('does not accept the channel spelling of a tier it does not have', () => {
    // A channel is public/private/locked. A replay is not a door, and `locked`
    // here would be a tier with no meaning rather than a stricter one.
    expect(isReplayVisibility('locked')).toBe(false);
    expect(isReplayVisibility('unlisted')).toBe(true);
  });
});

describe('an expiry is recorded exactly or refused outright', () => {
  it('pins the instant it was given', () => {
    const decided = decideRetention(
      { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
      STARTED,
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error('unreachable');
    expect(expiryOf(decided.value)).toBe(STARTED + THIRTY_DAYS_MS);
  });

  it('refuses expire with no instant at all', () => {
    const decided = decideRetention({ policy: 'expire' }, STARTED);
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });

  it('refuses an expiry that has already passed', () => {
    // Otherwise a broadcast spends its whole length writing a recording that
    // was expired before the first segment landed.
    const decided = decideRetention({ policy: 'expire', expiresAtMs: STARTED - 1 }, STARTED);
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });

  it('refuses an expiry at exactly the start', () => {
    const decided = decideRetention({ policy: 'expire', expiresAtMs: STARTED }, STARTED);
    expect(decided.ok).toBe(false);
  });

  it('refuses a non-finite expiry', () => {
    const decided = decideRetention({ policy: 'expire', expiresAtMs: Number.NaN }, STARTED);
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });

  it('refuses an expiry attached to keep rather than ignoring it', () => {
    // Somebody who sent one believed the recording would be let go. Silently
    // keeping it forever is the expensive way to be wrong.
    const decided = decideRetention({ policy: 'keep', expiresAtMs: STARTED + 1 }, STARTED);
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });

  it('refuses an expiry attached to none', () => {
    const decided = decideRetention({ policy: 'none', expiresAtMs: STARTED + 1 }, STARTED);
    expect(decided.ok).toBe(false);
  });

  it('gives keep no expiry at all', () => {
    const decided = decideRetention({ policy: 'keep' }, STARTED);
    if (!decided.ok) throw new Error('unreachable');
    expect(expiryOf(decided.value)).toBeNull();
  });

  it('refuses a policy it has never heard of', () => {
    const decided = decideRetention(
      { policy: 'forever' as unknown as 'keep' },
      STARTED,
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error('unreachable');
    expect(decided.failure.reason).toBe('retention-configuration-invalid');
  });
});

describe('replay retention is not the live spool retention', () => {
  it('does not move when the live delay does', () => {
    // The spool window is derived from the configured delay. A replay expiry
    // is a stated instant. Nothing links them, and this is the pin that says
    // so: the same expiry survives both ends of the delay range.
    const expiry = STARTED + THIRTY_DAYS_MS;
    const shortest = decideRetention({ policy: 'expire', expiresAtMs: expiry }, STARTED);
    const longest = decideRetention({ policy: 'expire', expiresAtMs: expiry }, STARTED);
    if (!shortest.ok || !longest.ok) throw new Error('unreachable');
    expect(expiryOf(shortest.value)).toBe(expiry);
    expect(expiryOf(longest.value)).toBe(expiry);

    // And the live window is unchanged by any of this: still the delay plus a
    // margin, still bounded by the longest delay grade the product offers.
    expect(retentionWindowMs(0)).toBe(RETENTION_MARGIN_MS);
    expect(retentionWindowMs(MAX_SUPPORTED_DELAY_MS)).toBe(
      MAX_SUPPORTED_DELAY_MS + RETENTION_MARGIN_MS,
    );
  });

  it('is measured on a scale the live window cannot reach', () => {
    // Ninety seconds plus a margin, against thirty days. Reusing the first for
    // the second would mean holding an entire broadcast in the live path.
    expect(retentionWindowMs(MAX_SUPPORTED_DELAY_MS)).toBeLessThan(THIRTY_DAYS_MS);
  });
});
