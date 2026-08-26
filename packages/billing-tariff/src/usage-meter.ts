/** @author masterzee001 */
/**
 * Counting what is billable, and counting it once.
 *
 * THE METER LIVES AT THE TRANSLATION BOUNDARY. Normal mode is free on every
 * channel, so nothing here is driven by call duration or by minutes connected:
 * what accrues is SECONDS OF TRANSLATED AUDIO PRODUCED. A call that sits in
 * normal mode for an hour bills nothing, and that is the product rule rather
 * than an accident of where the hook was placed.
 *
 * ACCUMULATE SECONDS, CONVERT ONCE. This is the invariant the whole module
 * exists to protect. `unitsForSeconds` rounds up, which is correct for a metered
 * span and wrong if applied repeatedly: a sixty-second call metered as a hundred
 * and twenty half-second ticks bills a hundred and twenty units instead of
 * sixty, because each tick takes its own ceiling. So spans accumulate as
 * floating-point seconds and become units exactly once, when the span closes.
 * Nothing outside this module should call `unitsForSeconds` on a partial span.
 *
 * A LANGUAGE STREAM IS THE UNIT FOR PROGRAMMES, because it is the thing that
 * actually costs money. Synthesis fans out per target language, not per
 * listener: one Yoruba stream serves ten listeners or ten thousand at the same
 * price. Billing a broadcaster per programme-minute would therefore eat the
 * fan-out -- five languages cost five times one and bill the same -- so the key
 * is (programme, language) and a programme in five languages accrues five
 * streams of billable seconds.
 */
import { unitsForSeconds, type Grade, type Tariff } from './tariff.js';

export type UsageKind = 'call' | 'programme';

export interface UsageKey {
  /** Call id or programme id. */
  readonly subjectId: string;
  readonly kind: UsageKind;
  /** The language being PRODUCED. One stream per target language. */
  readonly targetLanguage: string;
  readonly grade: Grade;
}

export interface UsageTotal extends UsageKey {
  /** Raw seconds of translated audio. Fractional, and deliberately so. */
  readonly seconds: number;
  /** Seconds converted at the grade's rate, rounded up exactly once. */
  readonly units: number;
  /**
   * Seconds a premium customer was served by the standard vendor.
   *
   * Not an error, and not a refund on its own: the chain falling through is the
   * platform working as designed, because imperfect audio beats silence. It is
   * a BILLING fact -- they paid the premium rate and received the standard
   * product for this long.
   */
  readonly downgradedSeconds: number;
  /**
   * Units owed back for the downgraded portion.
   *
   * The difference between what premium charges for those seconds and what
   * standard charges, so a customer pays the premium rate only for the audio
   * that was actually premium.
   */
  readonly creditUnits: number;
  /** What to actually charge: `units` less `creditUnits`, never below zero. */
  readonly netUnits: number;
  /** Who is charged. */
  readonly payerAccountId: string;
}

export interface RecordUsageInput extends UsageKey {
  readonly payerAccountId: string;
  /**
   * Seconds of translated audio produced by this span.
   *
   * Fractional is expected and must stay fractional through accumulation --
   * rounding here is the bug this module is built to prevent.
   */
  readonly seconds: number;
  /**
   * True when a premium request was actually served by the standard vendor.
   *
   * The synthesis chain already reports which provider spoke, so this is a fact
   * the caller HAS rather than one it has to infer. Recording it is what makes
   * the credit possible; without it a downgrade is invisible and the customer
   * pays premium for standard audio, which is the outcome the ruling on
   * 2026-08-26 rejected.
   */
  readonly downgraded?: boolean | undefined;
}

/**
 * A NUL is used to join key parts.
 *
 * Written as an escape because a literal control character in source fails this
 * repository's hygiene check, and chosen because it cannot occur in a language
 * tag, an account id or a subject id -- so no pair of different keys can collide
 * by containing the separator.
 */
const SEPARATOR = '\u0000';

function keyOf(key: UsageKey): string {
  return [key.kind, key.subjectId, key.targetLanguage.toLowerCase(), key.grade].join(SEPARATOR);
}

/**
 * Accrues billable seconds and converts them at the end.
 *
 * Deliberately holds no clock and does no I/O: it is told how many seconds were
 * produced rather than measuring them, so a test can describe a two-hour
 * programme without waiting for one and a caller can meter from whatever signal
 * it already has.
 */
export class TranslationUsageMeter {
  private readonly spans = new Map<
    string,
    { key: UsageKey; payerAccountId: string; seconds: number; downgradedSeconds: number }
  >();

  /**
   * Add produced audio to a stream.
   *
   * Zero and negative are ignored rather than rejected: a synthesis that
   * produced nothing is a real outcome (an aborted sentence, a failed vendor),
   * and it must not create a billable stream out of nothing.
   */
  record(input: RecordUsageInput): void {
    if (!Number.isFinite(input.seconds) || input.seconds <= 0) return;

    const id = keyOf(input);
    const existing = this.spans.get(id);
    if (existing === undefined) {
      this.spans.set(id, {
        key: {
          subjectId: input.subjectId,
          kind: input.kind,
          targetLanguage: input.targetLanguage,
          grade: input.grade,
        },
        payerAccountId: input.payerAccountId,
        seconds: input.seconds,
        downgradedSeconds: input.downgraded === true ? input.seconds : 0,
      });
      return;
    }
    /*
     * Seconds, not units. Adding units here would take a ceiling per call and
     * inflate a long session by up to one unit per sentence.
     */
    existing.seconds += input.seconds;
    if (input.downgraded === true) existing.downgradedSeconds += input.seconds;
  }

  /** Every open stream, converted at this tariff. Does not clear. */
  totals(tariff: Tariff): readonly UsageTotal[] {
    const out: UsageTotal[] = [];
    for (const span of this.spans.values()) {
      // THE ONE CEILING, taken here and nowhere else.
      const units = unitsForSeconds(span.seconds, span.key.grade, tariff);
      /*
       * The credit is the DIFFERENCE between the two grades for the downgraded
       * seconds, not a refund of them: the customer did receive audio, and it
       * was worth the standard rate. Only a premium span can be downgraded --
       * there is nothing below standard to fall to.
       */
      const creditUnits =
        span.key.grade === 'premium' && span.downgradedSeconds > 0
          ? Math.max(
              0,
              unitsForSeconds(span.downgradedSeconds, 'premium', tariff) -
                unitsForSeconds(span.downgradedSeconds, 'standard', tariff),
            )
          : 0;
      out.push({
        ...span.key,
        payerAccountId: span.payerAccountId,
        seconds: span.seconds,
        downgradedSeconds: span.downgradedSeconds,
        units,
        creditUnits,
        // Never below zero: a credit larger than the charge would be the
        // platform paying a customer to use it.
        netUnits: Math.max(0, units - creditUnits),
      });
    }
    return out;
  }

  /**
   * What is actually owed across every stream, credits already applied.
   *
   * NET, not gross. A caller that wanted the pre-credit figure would be asking
   * how much to charge before deciding not to charge it, and there is no
   * billing question with that shape -- `totals()` carries both numbers for
   * anyone reconciling.
   */
  totalUnits(tariff: Tariff): number {
    return this.totals(tariff).reduce((sum, total) => sum + total.netUnits, 0);
  }

  /** Units credited back for downgraded premium audio. For reporting. */
  totalCreditUnits(tariff: Tariff): number {
    return this.totals(tariff).reduce((sum, total) => sum + total.creditUnits, 0);
  }

  /**
   * Close and return the totals, leaving the meter empty.
   *
   * Read-and-clear is one operation on purpose. Two operations would let a
   * span recorded between them be dropped -- billed to nobody, and invisible.
   */
  flush(tariff: Tariff): readonly UsageTotal[] {
    const totals = this.totals(tariff);
    this.spans.clear();
    return totals;
  }

  /** How many distinct streams are open. Programme fan-out, at a glance. */
  get streamCount(): number {
    return this.spans.size;
  }
}

/**
 * Seconds of audio from a sample count.
 *
 * The engine is 16 kHz mono throughout, so this is the one conversion between
 * what a synthesis provider reports and what the meter accrues. It lives here
 * rather than at each call site so that a future rate change is one edit.
 */
export const ENGINE_SAMPLE_RATE = 16_000;

export function secondsFromSamples(samples: number): number {
  if (!Number.isFinite(samples) || samples <= 0) return 0;
  return samples / ENGINE_SAMPLE_RATE;
}
