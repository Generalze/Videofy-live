/**
 * The pricing API, over HTTP.
 *
 * Almost every test here is a refusal. This is the surface that decides what
 * the platform charges, and the interesting question is never "does publishing
 * work" -- it is who is turned away, what they are allowed to learn from being
 * turned away, and whether a misconfigured deployment fails open.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRADE_TERMS } from '@videofy-live/billing-tariff';
import type { AccountTrust } from '@videofy-live/account-trust';
import { TariffStore, createInMemoryTariffPort } from '../tariff-store.js';
import { registerTariffRoutes } from '../tariff-routes.js';
import type { Caller } from '../routes.js';

const VERIFIED: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

const UNVERIFIED: AccountTrust = { ...VERIFIED, email: 'unverified' };

function caller(accountId: string, trust: AccountTrust): Caller {
  // `record` is never read by these routes; only accountId and trust are.
  return { accountId, trust, record: {} as Caller['record'] };
}

interface Harness {
  url: string;
  tariffs: TariffStore;
  events: { event: string; detail: Record<string, string | number> }[];
  close: () => Promise<void>;
}

async function harness(options: {
  operators?: string[];
  as?: Caller | null;
} = {}): Promise<Harness> {
  const tariffs = new TariffStore({ port: createInMemoryTariffPort() });
  const events: { event: string; detail: Record<string, string | number> }[] = [];
  const app = express();
  app.use(express.json());
  registerTariffRoutes(app, {
    tariffs,
    platformOperators: new Set(options.operators ?? ['acct_zoe']),
    callerAccountId: () => options.as ?? null,
    onEvent: (event, detail) => events.push({ event, detail }),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    tariffs,
    events,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const BODY = { grades: DEFAULT_GRADE_TERMS, currency: 'USD' };

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('the public price', () => {
  beforeEach(async () => {
    app = await harness();
  });

  it('says there is no price before one is published', async () => {
    const response = await fetch(`${app.url}/billing/tariff`);
    expect(response.status).toBe(503);
  });

  it('publishes the price in force to anybody', async () => {
    await app.tariffs.seedDefault('USD');
    const response = await fetch(`${app.url}/billing/tariff`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tariff: Record<string, unknown> };
    expect(body.tariff['version']).toBe(1);
  });

  /*
   * Prices are public; who set them and why is not. A note can carry commercial
   * reasoning, and publishedBy names a member of staff.
   */
  it('does not leak who published it or why', async () => {
    await app.tariffs.publish({
      grades: DEFAULT_GRADE_TERMS,
      currency: 'USD',
      publishedBy: 'acct_zoe',
      note: 'undercutting a competitor',
    });
    const body = await (await fetch(`${app.url}/billing/tariff`)).text();
    expect(body).not.toContain('acct_zoe');
    expect(body).not.toContain('undercutting');
  });

  /*
   * A published-but-not-yet-effective price is an unannounced commercial
   * decision. The public endpoint must show today's price, not next month's.
   */
  it('does not reveal a pending price change', async () => {
    await app.tariffs.publish({ grades: DEFAULT_GRADE_TERMS, currency: 'USD', publishedBy: 'acct_zoe' });
    await app.tariffs.publish({
      grades: { ...DEFAULT_GRADE_TERMS, standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 999 } },
      currency: 'USD',
      publishedBy: 'acct_zoe',
      effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const body = (await (await fetch(`${app.url}/billing/tariff`)).json()) as {
      tariff: { version: number; grades: Record<string, { pricePerThousandUnitsMinor: number }> };
    };
    expect(body.tariff.version).toBe(1);
    expect(body.tariff.grades['standard']?.pricePerThousandUnitsMinor).toBe(556);
  });
});

describe('who may change a price', () => {
  it('lets a verified operator publish', async () => {
    app = await harness({ as: caller('acct_zoe', VERIFIED) });
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(response.status).toBe(201);
    expect((await app.tariffs.current())?.publishedBy).toBe('acct_zoe');
  });

  it('refuses an anonymous caller', async () => {
    app = await harness({ as: null });
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(response.status).toBe(404);
    expect(await app.tariffs.current()).toBeNull();
  });

  it('refuses a signed-in account that is not an operator', async () => {
    app = await harness({ as: caller('acct_stranger', VERIFIED) });
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(response.status).toBe(404);
    expect(await app.tariffs.current()).toBeNull();
  });

  /* A durable grant must not outlive live verification. */
  it('refuses an operator who is no longer verified', async () => {
    app = await harness({ as: caller('acct_zoe', UNVERIFIED) });
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(response.status).toBe(404);
  });

  /*
   * THE ONE THAT MATTERS MOST. A deployment with no operators configured must
   * deny everybody. Failing open here would hand the price list to any account
   * with a session.
   */
  it('refuses everybody when no operators are configured', async () => {
    app = await harness({ operators: [], as: caller('acct_zoe', VERIFIED) });
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(response.status).toBe(404);
    expect(await app.tariffs.current()).toBeNull();
  });

  /*
   * A 403 would confirm the endpoint exists and that the URL was right. Both
   * refusals have to look identical from outside.
   */
  it('answers a stranger and a bad URL the same way', async () => {
    app = await harness({ as: caller('acct_stranger', VERIFIED) });
    const denied = await fetch(`${app.url}/admin/billing/tariff`);
    const missing = await fetch(`${app.url}/admin/billing/nothing-here`);
    expect(denied.status).toBe(missing.status);
  });
});

describe('what an operator sees', () => {
  beforeEach(async () => {
    app = await harness({ as: caller('acct_zoe', VERIFIED) });
  });

  it('shows history, pending and provenance', async () => {
    await app.tariffs.publish({ grades: DEFAULT_GRADE_TERMS, currency: 'USD', publishedBy: 'acct_zoe', note: 'why' });
    const body = (await (await fetch(`${app.url}/admin/billing/tariff`)).json()) as {
      current: { publishedBy: string; note: string };
      history: unknown[];
    };
    expect(body.current.publishedBy).toBe('acct_zoe');
    expect(body.current.note).toBe('why');
    expect(body.history.length).toBe(1);
  });

  /*
   * The stored form is units-per-second and price-per-thousand. Nobody sets a
   * price in that vocabulary, so the response has to say what it MEANS or the
   * operator learns the effect from a customer.
   */
  it('states what a reference spend buys, per grade', async () => {
    await app.tariffs.seedDefault('USD');
    const body = (await (await fetch(`${app.url}/admin/billing/tariff`)).json()) as {
      current: { grades: Record<string, { minutesPerReferenceSpend: number }> };
    };
    expect(body.current.grades['standard']?.minutesPerReferenceSpend).toBeCloseTo(30, 0);
    expect(body.current.grades['premium']?.minutesPerReferenceSpend).toBeCloseTo(15, 0);
  });
});

describe('bad input', () => {
  beforeEach(async () => {
    app = await harness({ as: caller('acct_zoe', VERIFIED) });
  });

  it('refuses a price that is not a number', async () => {
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currency: 'USD',
        grades: {
          standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: '556' },
          premium: { unitsPerSecond: 2, pricePerThousandUnitsMinor: 556 },
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await app.tariffs.current()).toBeNull();
  });

  it('refuses a body with a grade missing', async () => {
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currency: 'USD', grades: { standard: DEFAULT_GRADE_TERMS.standard } }),
    });
    expect(response.status).toBe(400);
  });

  it('names the domain problems it rejected', async () => {
    const response = await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currency: 'USD',
        grades: {
          standard: { unitsPerSecond: 1, pricePerThousandUnitsMinor: 0 },
          premium: DEFAULT_GRADE_TERMS.premium,
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { problems: string[] };
    expect(body.problems).toContain('price-not-positive-integer');
  });
});

describe('the audit trail', () => {
  it('records the change with both the old and the new version', async () => {
    app = await harness({ as: caller('acct_zoe', VERIFIED) });
    await app.tariffs.seedDefault('USD');
    await fetch(`${app.url}/admin/billing/tariff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });

    const published = app.events.find((e) => e.event === 'tariff.published');
    expect(published?.detail['accountId']).toBe('acct_zoe');
    expect(published?.detail['version']).toBe(2);
    expect(published?.detail['previousVersion']).toBe(1);
  });

  /*
   * The caller is told nothing; the log is told the truth. This is how an
   * operator debugging their own access finds out they are not on the list.
   */
  it('records why a caller was refused, even though the caller is not told', async () => {
    app = await harness({ operators: [], as: caller('acct_zoe', VERIFIED) });
    await fetch(`${app.url}/admin/billing/tariff`);
    const denied = app.events.find((e) => e.event === 'tariff.denied');
    expect(denied?.detail['reason']).toBe('no-operators-configured');
  });
});
