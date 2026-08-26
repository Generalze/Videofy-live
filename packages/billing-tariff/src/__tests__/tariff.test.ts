/**
 * The tariff, and the two things it must never get wrong: the arithmetic that
 * turns audio into money, and the refusal to let history be rewritten.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE_TERMS,
  minutesForSpend,
  priceOfUnitsMinor,
  secondsForUnits,
  unitsForSeconds,
  validateTariff,
  type Tariff,
} from '../tariff.js';

function tariff(overrides: Partial<Tariff> = {}): Tariff {
  return {
    version: 1,
    effectiveFrom: '2026-08-26T00:00:00.000Z',
    currency: 'USD',
    grades: DEFAULT_GRADE_TERMS,
    publishedBy: 'acct_operator',
    publishedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('the ruling, as arithmetic', () => {
  /*
   * THE ONE THAT ENCODES THE PRODUCT DECISION. Ten dollars buys half an hour of
   * standard and a quarter hour of premium. If a future edit to the default
   * terms breaks this, it has changed the price of the product, and that should
   * fail a test rather than reach a customer.
   */
  it('gives thirty standard minutes and fifteen premium minutes for ten dollars', () => {
    const t = tariff();
    expect(minutesForSpend(1000, 'standard', t)).toBeCloseTo(30, 0);
    expect(minutesForSpend(1000, 'premium', t)).toBeCloseTo(15, 0);
  });

  it('makes premium cost exactly double per second of audio', () => {
    const t = tariff();
    expect(unitsForSeconds(100, 'premium', t)).toBe(2 * unitsForSeconds(100, 'standard', t));
  });

  /* A unit is worth the same whichever grade later spends it. */
  it('prices a unit identically across grades', () => {
    const t = tariff();
    expect(priceOfUnitsMinor(1000, 'premium', t)).toBe(priceOfUnitsMinor(1000, 'standard', t));
  });
});

describe('metering arithmetic', () => {
  it('bills one second of standard as one unit', () => {
    expect(unitsForSeconds(1, 'standard', tariff())).toBe(1);
  });

  it('rounds a partial second up', () => {
    expect(unitsForSeconds(0.2, 'standard', tariff())).toBe(1);
    expect(unitsForSeconds(10.1, 'standard', tariff())).toBe(11);
  });

  /*
   * The counterpart to rounding up: a span metered ONCE must never cost more
   * than the same span metered once at a coarser resolution. This is what stops
   * per-tick accumulation from inflating a bill, and it is the property the
   * doc comment on unitsForSeconds is asking callers to preserve.
   */
  it('charges a whole span less than the same span split into ticks', () => {
    const t = tariff();
    // The same sixty seconds, metered once and then metered as 120 half-second
    // accounting ticks. Each tick takes its own ceiling, so the split version
    // bills double -- which is precisely the mistake the doc comment warns a
    // caller not to make.
    const whole = unitsForSeconds(60, 'standard', t);
    const ticked = Array.from({ length: 120 }, () => unitsForSeconds(0.5, 'standard', t)).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(whole).toBe(60);
    expect(ticked).toBe(120);
  });

  it('never oversells seconds for a balance', () => {
    const t = tariff();
    // 5 units of premium is 2.5 seconds; the customer gets 2, not 3.
    expect(secondsForUnits(5, 'premium', t)).toBe(2);
  });

  it('treats zero and nonsense as zero rather than throwing', () => {
    const t = tariff();
    expect(unitsForSeconds(0, 'standard', t)).toBe(0);
    expect(unitsForSeconds(-5, 'standard', t)).toBe(0);
    expect(unitsForSeconds(Number.NaN, 'standard', t)).toBe(0);
    expect(secondsForUnits(-1, 'premium', t)).toBe(0);
    expect(priceOfUnitsMinor(0, 'standard', t)).toBe(0);
  });

  /* A purchase is never free because the arithmetic produced a fraction. */
  it('never prices a real purchase at zero', () => {
    expect(priceOfUnitsMinor(1, 'standard', tariff())).toBe(1);
  });
});

describe('what a tariff refuses to be', () => {
  it('accepts the default', () => {
    expect(validateTariff(tariff()).ok).toBe(true);
  });

  /* Free service is almost always a typo, and it is unrecoverable revenue. */
  it('refuses a price of zero', () => {
    const bad = tariff({
      grades: { ...DEFAULT_GRADE_TERMS, standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 0 } },
    });
    const result = validateTariff(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('price-not-positive-integer');
  });

  it('refuses a burn rate of zero, which would be an infinite balance', () => {
    const bad = tariff({
      grades: { ...DEFAULT_GRADE_TERMS, premium: { unitsPerSecond: 0, pricePerThousandUnitsMinor: 556 } },
    });
    const result = validateTariff(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('units-per-second-not-positive-integer');
  });

  /* Fractional cents in the ledger is the thing the whole module refuses. */
  it('refuses a fractional price', () => {
    const bad = tariff({
      grades: { ...DEFAULT_GRADE_TERMS, standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 55.6 } },
    });
    expect(validateTariff(bad).ok).toBe(false);
  });

  /* The stray-zero direction: a hundredfold overcharge. */
  it('refuses a price far above any plausible one', () => {
    const bad = tariff({
      grades: {
        ...DEFAULT_GRADE_TERMS,
        standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 99_000_000 },
      },
    });
    const result = validateTariff(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('price-too-large');
  });

  it('refuses a currency that is not a currency', () => {
    expect(validateTariff(tariff({ currency: 'dollars' })).ok).toBe(false);
  });

  it('refuses an unparseable effective date', () => {
    const result = validateTariff(tariff({ effectiveFrom: 'next tuesday' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('effective-date-invalid');
  });

  it('reports every problem at once rather than one at a time', () => {
    const bad = tariff({
      currency: 'zzz',
      effectiveFrom: 'nonsense',
      grades: {
        standard: { unitsPerSecond: 0, pricePerThousandUnitsMinor: 0 },
        premium: { unitsPerSecond: 0, pricePerThousandUnitsMinor: 0 },
      },
    });
    const result = validateTariff(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThan(4);
  });
});

describe('history is append-only', () => {
  /*
   * THE ONE THAT MATTERS FOR AUDIT. Reusing a version number would overwrite
   * the price a past charge was raised under, and there would be no way to
   * distinguish an honest price change from a retroactive one.
   */
  it('refuses a version that does not advance', () => {
    const previous = tariff({ version: 4 });
    const result = validateTariff(tariff({ version: 4 }), previous);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain('version-not-monotonic');
  });

  it('refuses a version that goes backwards', () => {
    expect(validateTariff(tariff({ version: 2 }), tariff({ version: 7 })).ok).toBe(false);
  });

  it('accepts the next version', () => {
    expect(validateTariff(tariff({ version: 5 }), tariff({ version: 4 })).ok).toBe(true);
  });
});
