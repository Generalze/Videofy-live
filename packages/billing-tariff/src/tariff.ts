/** @author masterzee001 */
/**
 * What a minute of translation costs, and who is allowed to say so.
 *
 * TWO GRADES, ONE METER. Standard and premium differ in the synthesis vendor
 * behind them and in nothing else the meter can see. So the meter does not know
 * about vendors: it counts SECONDS OF TRANSLATED AUDIO and converts them to
 * units at a rate the grade carries. Swapping a vendor later is then a wiring
 * change rather than a billing change.
 *
 * THE UNIT IS ONE SECOND OF STANDARD TRANSLATION. This is the whole reason the
 * unit exists in this form. The first proposal was "1000 units = 30 min on
 * standard, 1000 units = 15 min on premium", which prices correctly but makes a
 * unit burn at 33.33/min and 66.67/min -- non-integer rates that turn every
 * balance and every invoice into a rounding argument. Anchoring the unit to one
 * standard-second makes the rates 1/sec and 2/sec, keeps the same economics,
 * and states the product claim on its face: premium costs double.
 *
 * MONEY IS INTEGER MINOR UNITS, ALWAYS. Cents, kobo, pence -- never a float.
 * Floating point drift is not a curiosity when it is somebody's balance, and a
 * fraction of a cent that survives into a total is a discrepancy nobody can
 * explain afterwards.
 *
 * VERSIONS ARE APPEND-ONLY. Publishing a price never edits the price that was
 * in force before it. A charge raised last week has to stay explicable after
 * this week's price change -- otherwise the answer to "why was I charged this?"
 * is a tariff that no longer exists, and there is no way to tell an honest
 * price change from a retroactive one.
 */

export type Grade = 'standard' | 'premium';

export const GRADES: readonly Grade[] = ['standard', 'premium'];

export const GRADE_LABELS: Readonly<Record<Grade, string>> = {
  standard: 'Standard',
  premium: 'Premium',
};

/** What one grade costs and how fast it consumes a balance. */
export interface GradeTerms {
  /**
   * Units consumed per second of translated audio. Integer, at least 1.
   *
   * This is the dial that expresses "premium is worth more" without touching
   * the price of a unit, which keeps a purchased balance worth the same number
   * of units whatever it is later spent on.
   */
  readonly unitsPerSecond: number;
  /** Minor currency units per 1000 units. Integer, at least 1. */
  readonly pricePerThousandUnitsMinor: number;
}

export interface Tariff {
  /** Monotonic. Version 1 is the first ever published. */
  readonly version: number;
  /** ISO-8601. When this tariff became the one in force. */
  readonly effectiveFrom: string;
  readonly currency: string;
  readonly grades: Readonly<Record<Grade, GradeTerms>>;
  /** The platform operator who published it. Never absent in stored history. */
  readonly publishedBy: string;
  readonly publishedAt: string;
  /** Free text from the operator: why this changed. */
  readonly note?: string | undefined;
}

export type TariffProblem =
  | 'unknown-currency'
  | 'units-per-second-not-positive-integer'
  | 'units-per-second-too-large'
  | 'price-not-positive-integer'
  | 'price-too-large'
  | 'missing-grade'
  | 'version-not-monotonic'
  | 'effective-date-invalid';

export type TariffValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly TariffProblem[] };

/*
 * Ceilings, not opinions. A price of zero is free service and a burn rate of
 * zero is an infinite balance; both are almost certainly a typo or a fat-
 * fingered form, and neither should be reachable through an admin screen
 * without someone deliberately changing this constant. The upper bounds catch
 * the other direction -- a stray zero that charges a customer a hundred times
 * over.
 */
const MAX_UNITS_PER_SECOND = 100;
const MAX_PRICE_PER_THOUSAND_MINOR = 1_000_000;

/** ISO-4217, upper case, three letters. Not a currency table -- a shape check. */
const CURRENCY_SHAPE = /^[A-Z]{3}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateTariff(
  candidate: Tariff,
  previous?: Tariff | undefined,
): TariffValidation {
  const problems: TariffProblem[] = [];

  if (!CURRENCY_SHAPE.test(candidate.currency)) problems.push('unknown-currency');

  if (Number.isNaN(Date.parse(candidate.effectiveFrom))) {
    problems.push('effective-date-invalid');
  }

  for (const grade of GRADES) {
    const terms = candidate.grades[grade];
    if (terms === undefined) {
      problems.push('missing-grade');
      continue;
    }
    if (!isPositiveInteger(terms.unitsPerSecond)) {
      problems.push('units-per-second-not-positive-integer');
    } else if (terms.unitsPerSecond > MAX_UNITS_PER_SECOND) {
      problems.push('units-per-second-too-large');
    }
    if (!isPositiveInteger(terms.pricePerThousandUnitsMinor)) {
      problems.push('price-not-positive-integer');
    } else if (terms.pricePerThousandUnitsMinor > MAX_PRICE_PER_THOUSAND_MINOR) {
      problems.push('price-too-large');
    }
  }

  /*
   * A version that does not advance would overwrite history rather than extend
   * it, which is the one thing this type exists to prevent.
   */
  if (previous !== undefined && candidate.version <= previous.version) {
    problems.push('version-not-monotonic');
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Units owed for a span of translated audio.
 *
 * ROUNDS UP, and does so ONCE PER METERED SPAN rather than per second. Rounding
 * up is the ordinary convention for metered service and it is defensible; what
 * would not be defensible is rounding up repeatedly inside a single continuous
 * span, which would let a 60-second call bill as 60 separate ceilings and
 * silently inflate a bill by up to a unit per accounting tick. Callers must
 * therefore meter a span once, not accumulate per-tick results.
 */
export function unitsForSeconds(seconds: number, grade: Grade, tariff: Tariff): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const terms = tariff.grades[grade];
  return Math.ceil(seconds * terms.unitsPerSecond);
}

/** Seconds a balance of units buys at this grade. Truncated: never oversell. */
export function secondsForUnits(units: number, grade: Grade, tariff: Tariff): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  const terms = tariff.grades[grade];
  return Math.floor(units / terms.unitsPerSecond);
}

/**
 * What a number of units costs, in minor currency units.
 *
 * Rounds up for the same reason as above, and to the same effect: a purchase of
 * one unit is never free because the arithmetic produced a fraction of a cent.
 */
export function priceOfUnitsMinor(units: number, grade: Grade, tariff: Tariff): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  const terms = tariff.grades[grade];
  return Math.ceil((units * terms.pricePerThousandUnitsMinor) / 1000);
}

/**
 * How the admin actually thinks about it: what does this much money buy?
 *
 * The stored form is units-per-second and price-per-thousand-units, which is
 * exact and awkward. Nobody sets prices in that vocabulary -- they set them in
 * "ten dollars should buy half an hour" -- so the surface that lets a person
 * change a price has to be able to show them that sentence, or they are flying
 * blind and will learn the effect from a customer.
 */
export function minutesForSpend(spendMinor: number, grade: Grade, tariff: Tariff): number {
  if (!Number.isFinite(spendMinor) || spendMinor <= 0) return 0;
  const terms = tariff.grades[grade];
  const units = (spendMinor * 1000) / terms.pricePerThousandUnitsMinor;
  return units / terms.unitsPerSecond / 60;
}

/**
 * The starting tariff, matching the ruling: premium burns twice as fast, and a
 * unit costs the same whichever grade later spends it.
 *
 * 556 minor units per 1000 units puts ten of them within a cent of thirty
 * standard minutes (1800 units -> 1000.8 minor). That exactness is deliberately
 * NOT chased with a fractional price: a whole minor unit per thousand is the
 * smallest honest granularity, and the alternative is fractional cents in the
 * ledger, which is the thing this module refuses to have.
 */
export const DEFAULT_GRADE_TERMS: Readonly<Record<Grade, GradeTerms>> = {
  standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 556 },
  premium: { unitsPerSecond: 2, pricePerThousandUnitsMinor: 556 },
};
