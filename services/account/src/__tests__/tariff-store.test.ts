/**
 * Publishing a price.
 *
 * The arithmetic is tested in billing-tariff. What is tested here is the part
 * that only a store can get wrong: version assignment under concurrency, what
 * "in force" means when a price is dated forward, and the refusal to let a
 * published version be reused.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADE_TERMS } from '@videofy-live/billing-tariff';
import { BOOTSTRAP_PUBLISHER, TariffStore, createInMemoryTariffPort } from '../tariff-store.js';

function store(now?: () => number) {
  return new TariffStore(now === undefined
    ? { port: createInMemoryTariffPort() }
    : { port: createInMemoryTariffPort(), now });
}

const PUBLISH = {
  grades: DEFAULT_GRADE_TERMS,
  currency: 'USD',
  publishedBy: 'acct_zoe',
} as const;

describe('publishing', () => {
  it('assigns version 1 to the first tariff', async () => {
    const result = await store().publish(PUBLISH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tariff.version).toBe(1);
  });

  it('advances the version on each publish', async () => {
    const s = store();
    await s.publish(PUBLISH);
    const second = await s.publish({ ...PUBLISH, note: 'price rise' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.tariff.version).toBe(2);
  });

  /*
   * THE ONE THE LOCK EXISTS FOR. Two operators publishing at once is a
   * read-modify-write over the highest version; without serialisation both read
   * version 1 and both write version 2, and one price silently vanishes -- or
   * overwrites a version a charge was already raised under.
   */
  it('gives concurrent publishes distinct versions', async () => {
    const s = store();
    const results = await Promise.all([
      s.publish(PUBLISH),
      s.publish(PUBLISH),
      s.publish(PUBLISH),
      s.publish(PUBLISH),
    ]);
    const versions = results.map((r) => (r.ok ? r.tariff.version : -1)).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4]);
  });

  /*
   * A rejected publish must not poison the lock. The chain is a promise; if a
   * rejection were left on it, every later publish would wait behind a promise
   * that never settles well.
   */
  it('keeps accepting publishes after a rejected one', async () => {
    const s = store();
    const bad = await s.publish({ ...PUBLISH, currency: 'not a currency' });
    expect(bad.ok).toBe(false);
    const good = await s.publish(PUBLISH);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.tariff.version).toBe(1);
  });

  it('records who published and when', async () => {
    const result = await store(() => 1_760_000_000_000).publish(PUBLISH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tariff.publishedBy).toBe('acct_zoe');
      expect(result.tariff.publishedAt).toBe(new Date(1_760_000_000_000).toISOString());
    }
  });

  it('refuses a tariff the domain rejects, without writing it', async () => {
    const s = store();
    const result = await s.publish({
      ...PUBLISH,
      grades: {
        ...DEFAULT_GRADE_TERMS,
        standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 0 },
      },
    });
    expect(result.ok).toBe(false);
    expect(await s.history()).toEqual([]);
  });
});

describe('what is in force', () => {
  /*
   * A price can be published today to start on Friday. Until Friday it is real,
   * visible and NOT in force -- which is the difference between announcing a
   * change and making one.
   */
  it('does not put a future-dated tariff in force', async () => {
    const nowMs = 1_760_000_000_000;
    const s = store(() => nowMs);
    await s.publish(PUBLISH);
    await s.publish({
      ...PUBLISH,
      effectiveFrom: new Date(nowMs + 86_400_000).toISOString(),
      note: 'next week',
    });

    const current = await s.current();
    expect(current?.version).toBe(1);
    expect((await s.pending()).map((t) => t.version)).toEqual([2]);
  });

  it('puts it in force once its date has passed', async () => {
    const nowMs = 1_760_000_000_000;
    let clock = nowMs;
    const s = store(() => clock);
    await s.publish(PUBLISH);
    await s.publish({ ...PUBLISH, effectiveFrom: new Date(nowMs + 1000).toISOString() });

    clock = nowMs + 2000;
    expect((await s.current())?.version).toBe(2);
    expect(await s.pending()).toEqual([]);
  });

  /*
   * The question an audit actually asks: under what price was this charged?
   * A tariff published later must not change the answer for an earlier charge.
   */
  it('explains a past charge with the tariff in force at the time', async () => {
    const t0 = 1_760_000_000_000;
    let clock = t0;
    const s = store(() => clock);
    await s.publish(PUBLISH);

    clock = t0 + 100_000;
    await s.publish({
      ...PUBLISH,
      grades: {
        ...DEFAULT_GRADE_TERMS,
        standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 900 },
      },
    });

    const atCharge = await s.inForceAt(t0 + 50_000);
    expect(atCharge?.version).toBe(1);
    expect(atCharge?.grades.standard.pricePerThousandUnitsMinor).toBe(556);
  });

  it('has nothing in force before anything is published', async () => {
    expect(await store().current()).toBeNull();
  });
});

describe('seeding', () => {
  it('writes the default as a real version 1', async () => {
    const s = store();
    const seeded = await s.seedDefault('USD');
    expect(seeded?.version).toBe(1);
    expect(seeded?.publishedBy).toBe(BOOTSTRAP_PUBLISHER);
    expect((await s.history()).length).toBe(1);
  });

  /*
   * Safe on every boot. A restart must never reinstate the default over a price
   * somebody deliberately set.
   */
  it('leaves an existing tariff alone', async () => {
    const s = store();
    await s.publish({
      ...PUBLISH,
      grades: {
        ...DEFAULT_GRADE_TERMS,
        premium: { unitsPerSecond: 3, pricePerThousandUnitsMinor: 700 },
      },
    });

    expect(await s.seedDefault('USD')).toBeNull();
    const current = await s.current();
    expect(current?.grades.premium.unitsPerSecond).toBe(3);
    expect((await s.history()).length).toBe(1);
  });
});

describe('the port', () => {
  /* No upsert anywhere: a duplicate version is a bug, not a silent overwrite. */
  it('refuses to append a version that already exists', async () => {
    const port = createInMemoryTariffPort();
    const tariff = {
      version: 1,
      effectiveFrom: '2026-08-26T00:00:00.000Z',
      currency: 'USD',
      grades: DEFAULT_GRADE_TERMS,
      publishedBy: 'acct_zoe',
      publishedAt: '2026-08-26T00:00:00.000Z',
    };
    await port.append(tariff);
    await expect(port.append(tariff)).rejects.toThrow(/already exists/u);
  });
});
