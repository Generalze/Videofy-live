/**
 * Counting billable translation.
 *
 * The headline test here is the one about ticks. Rounding up is correct for a
 * metered span and catastrophic if applied repeatedly, and the difference does
 * not show up as an error -- it shows up as a bill that is twice what it should
 * be, on an invoice nobody can reconcile.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADE_TERMS } from '../tariff.js';
import type { Tariff } from '../tariff.js';
import { TranslationUsageMeter, secondsFromSamples } from '../usage-meter.js';

const TARIFF: Tariff = {
  version: 1,
  effectiveFrom: '2026-08-26T00:00:00.000Z',
  currency: 'USD',
  grades: DEFAULT_GRADE_TERMS,
  publishedBy: 'acct_operator',
  publishedAt: '2026-08-26T00:00:00.000Z',
};

function call(overrides: Partial<Parameters<TranslationUsageMeter['record']>[0]> = {}) {
  return {
    subjectId: 'call_1',
    kind: 'call' as const,
    targetLanguage: 'fr',
    grade: 'standard' as const,
    payerAccountId: 'acct_payer',
    seconds: 10,
    ...overrides,
  };
}

describe('counting once', () => {
  /*
   * THE ONE THAT MATTERS. Sixty seconds delivered as a hundred and twenty
   * half-second sentences is still sixty seconds. If each sentence took its own
   * ceiling the customer would be billed double, and nothing would raise an
   * error -- the only symptom is an invoice that cannot be reconciled.
   */
  it('bills a span once however many pieces it arrived in', () => {
    const meter = new TranslationUsageMeter();
    for (let piece = 0; piece < 120; piece += 1) {
      meter.record(call({ seconds: 0.5 }));
    }
    expect(meter.totalUnits(TARIFF)).toBe(60);
  });

  it('accumulates fractional seconds without rounding on the way in', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 0.4 }));
    meter.record(call({ seconds: 0.4 }));
    meter.record(call({ seconds: 0.4 }));
    // 1.2s of audio is 2 units at 1/sec, not 3.
    expect(meter.totalUnits(TARIFF)).toBe(2);
  });

  it('takes exactly one ceiling at the end', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 10.1 }));
    expect(meter.totals(TARIFF)[0]?.units).toBe(11);
    expect(meter.totals(TARIFF)[0]?.seconds).toBeCloseTo(10.1, 5);
  });

  it('charges premium double for the same audio', () => {
    const standard = new TranslationUsageMeter();
    const premium = new TranslationUsageMeter();
    standard.record(call({ seconds: 30, grade: 'standard' }));
    premium.record(call({ seconds: 30, grade: 'premium' }));

    expect(premium.totalUnits(TARIFF)).toBe(2 * standard.totalUnits(TARIFF));
  });
});

describe('what does not bill', () => {
  it('ignores a span that produced nothing', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 0 }));
    expect(meter.streamCount).toBe(0);
    expect(meter.totalUnits(TARIFF)).toBe(0);
  });

  /* An aborted sentence or a failed vendor must not invent a billable stream. */
  it('ignores negative and nonsense', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: -5 }));
    meter.record(call({ seconds: Number.NaN }));
    expect(meter.streamCount).toBe(0);
  });
});

describe('programme fan-out', () => {
  /*
   * Cost scales with LANGUAGES, not listeners. A programme in five languages
   * runs five synthesis streams whether ten people watch or ten thousand, so
   * five streams is what accrues.
   */
  it('keeps one stream per target language', () => {
    const meter = new TranslationUsageMeter();
    for (const targetLanguage of ['fr', 'es', 'pt', 'ar', 'de']) {
      meter.record(call({ kind: 'programme', subjectId: 'prog_1', targetLanguage, seconds: 3600 }));
    }
    expect(meter.streamCount).toBe(5);
    // 5 languages x 3600s at 1 unit/sec.
    expect(meter.totalUnits(TARIFF)).toBe(18_000);
  });

  it('does not multiply by listeners', () => {
    const meter = new TranslationUsageMeter();
    // The same hour of Yoruba, however many people are hearing it.
    meter.record(call({ kind: 'programme', subjectId: 'prog_1', targetLanguage: 'yo', seconds: 3600 }));
    expect(meter.totalUnits(TARIFF)).toBe(3600);
  });

  it('treats a regional tag as the same stream', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ targetLanguage: 'pt-BR', seconds: 10 }));
    meter.record(call({ targetLanguage: 'PT-br', seconds: 10 }));
    expect(meter.streamCount).toBe(1);
  });

  it('separates different programmes', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ kind: 'programme', subjectId: 'prog_1', seconds: 10 }));
    meter.record(call({ kind: 'programme', subjectId: 'prog_2', seconds: 10 }));
    expect(meter.streamCount).toBe(2);
  });

  it('separates a call from a programme with the same id', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ kind: 'call', subjectId: 'x', seconds: 10 }));
    meter.record(call({ kind: 'programme', subjectId: 'x', seconds: 10 }));
    expect(meter.streamCount).toBe(2);
  });

  /* Two grades on one stream are two different prices and must not merge. */
  it('separates grades', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'standard', seconds: 10 }));
    meter.record(call({ grade: 'premium', seconds: 10 }));
    expect(meter.streamCount).toBe(2);
  });
});

describe('closing out', () => {
  it('reports who pays', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ payerAccountId: 'acct_broadcaster' }));
    expect(meter.totals(TARIFF)[0]?.payerAccountId).toBe('acct_broadcaster');
  });

  /*
   * Read-and-clear is one operation. Two would let a span recorded between them
   * vanish -- billed to nobody, and with nothing to show it ever existed.
   */
  it('empties the meter when flushed', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 10 }));

    expect(meter.flush(TARIFF)).toHaveLength(1);
    expect(meter.streamCount).toBe(0);
    expect(meter.totalUnits(TARIFF)).toBe(0);
  });

  it('does not clear on a plain read', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 10 }));
    meter.totals(TARIFF);
    expect(meter.streamCount).toBe(1);
  });

  /* A price published mid-session must not silently re-rate closed usage. */
  it('converts at whatever tariff it is handed', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ seconds: 10, grade: 'premium' }));

    const dearer: Tariff = {
      ...TARIFF,
      version: 2,
      grades: { ...DEFAULT_GRADE_TERMS, premium: { unitsPerSecond: 4, pricePerThousandUnitsMinor: 556 } },
    };
    expect(meter.totalUnits(TARIFF)).toBe(20);
    expect(meter.totalUnits(dearer)).toBe(40);
  });
});

describe('samples to seconds', () => {
  it('converts at the engine rate', () => {
    expect(secondsFromSamples(16_000)).toBe(1);
    expect(secondsFromSamples(8_000)).toBe(0.5);
  });

  it('treats nothing as nothing', () => {
    expect(secondsFromSamples(0)).toBe(0);
    expect(secondsFromSamples(-1)).toBe(0);
    expect(secondsFromSamples(Number.NaN)).toBe(0);
  });
});

describe('crediting a downgraded premium session', () => {
  /*
   * THE RULING, AS ARITHMETIC. Premium is ElevenLabs; when the chain falls
   * through to the standard vendor the listener still hears audio, which is the
   * right behaviour -- but they paid twice the rate for it. The credit is the
   * difference, not a refund of the whole span, because standard audio is worth
   * the standard price.
   */
  it('credits the difference between the grades', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'premium', seconds: 10, downgraded: true }));

    const total = meter.totals(TARIFF)[0];
    expect(total?.units).toBe(20);
    expect(total?.creditUnits).toBe(10);
    expect(total?.netUnits).toBe(10);
  });

  it('credits only the downgraded part of a session', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'premium', seconds: 30 }));
    meter.record(call({ grade: 'premium', seconds: 10, downgraded: true }));

    const total = meter.totals(TARIFF)[0];
    expect(total?.seconds).toBe(40);
    expect(total?.downgradedSeconds).toBe(10);
    expect(total?.units).toBe(80);
    expect(total?.creditUnits).toBe(10);
    expect(total?.netUnits).toBe(70);
  });

  it('bills the net, not the gross', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'premium', seconds: 10, downgraded: true }));
    expect(meter.totalUnits(TARIFF)).toBe(10);
    expect(meter.totalCreditUnits(TARIFF)).toBe(10);
  });

  /* There is nothing below standard to fall to, so nothing to credit. */
  it('does not credit a standard session', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'standard', seconds: 10, downgraded: true }));
    expect(meter.totals(TARIFF)[0]?.creditUnits).toBe(0);
    expect(meter.totalUnits(TARIFF)).toBe(10);
  });

  it('credits nothing when the premium vendor served throughout', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'premium', seconds: 60 }));
    expect(meter.totals(TARIFF)[0]?.creditUnits).toBe(0);
    expect(meter.totalUnits(TARIFF)).toBe(120);
  });

  /* A credit larger than the charge would be paying somebody to use the product. */
  it('never bills below zero', () => {
    const meter = new TranslationUsageMeter();
    meter.record(call({ grade: 'premium', seconds: 5, downgraded: true }));
    expect(meter.totals(TARIFF)[0]?.netUnits).toBeGreaterThanOrEqual(0);
  });

  /* An entirely downgraded premium session costs exactly the standard price. */
  it('charges a fully downgraded session at the standard rate', () => {
    const premium = new TranslationUsageMeter();
    premium.record(call({ grade: 'premium', seconds: 45, downgraded: true }));
    const standard = new TranslationUsageMeter();
    standard.record(call({ grade: 'standard', seconds: 45 }));

    expect(premium.totalUnits(TARIFF)).toBe(standard.totalUnits(TARIFF));
  });
});
