/** @vitest-environment jsdom */
/** @author masterzee001 */
/**
 * Page 07, from an operator's keystrokes to what a viewer's screen renders.
 *
 * PERSISTENCE IS NOT COMPLETION. An operator page that saves a creative and
 * stops there means somebody types their advert, sees success, and every viewer
 * keeps seeing the house creative -- with every signal green. That is this
 * project's most expensive recurring defect and it would have been the ninth
 * instance. So the chain here runs all the way through: real form, real PUT,
 * real store, real PUBLIC delivery read, real listener-web slot in a real DOM.
 *
 * WHAT IS REAL: the shared contract and its validation; the real operator and
 * delivery route handlers; the real durable store over a Postgres-shaped fake;
 * a real HTTP round trip; the real operator client, hook and page; the real
 * listener-web delivery client and SponsoredSlot. Only the database driver is
 * simulated.
 *
 * Mobile's half of the join is proved in apps/mobile -- it needs its own
 * environment, and a React Native component cannot be rendered in this one.
 */
import express from 'express';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AddressInfo } from 'node:net';
import type { SponsoredCreative } from '@videofy-live/shared-types';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSponsoredCreativeRoutes } from '../../../../services/account/src/sponsored-creative-routes';
import { createPostgresSponsoredCreative } from '../../../../services/account/src/db/programme-sponsored-creative-postgres';
import { SponsoredSlot } from '../../../listener-web/src/SponsoredSlot';
import { fetchSponsoredCreative } from '../../../listener-web/src/sponsoredDelivery';
import { AdvertisingPage } from './AdvertisingPage';
import { useAdvertising } from '../useAdvertising';
import { makeCreativeFakePool } from './sponsoredCreativeFakePool';

let container: HTMLDivElement;
let root: Root;
let server: Server | null = null;
let baseUrl = '';
let pool: ReturnType<typeof makeCreativeFakePool>;
let clock = new Date('2026-09-01T12:00:00Z');
/** Every PUT the browser actually made. A retry would show up here. */
let puts: number;

/** The account service, with both surfaces, exactly as production registers them. */
async function serve(options: { withDatabase?: boolean } = {}): Promise<void> {
  pool = makeCreativeFakePool();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.method === 'PUT') puts += 1;
    next();
  });

  if (options.withDatabase !== false) {
    registerSponsoredCreativeRoutes(app, {
      creatives: createPostgresSponsoredCreative(pool.pool),
      callerAccountId: () => ({ accountId: 'acct_1' }),
      // This operator owns prog_A and nothing else.
      mayAdminister: async (_accountId, programmeId) => programmeId === 'prog_A',
      // Both programmes exist; only one is administered by this caller.
      programmeExists: async (programmeId) => ['prog_A', 'prog_B'].includes(programmeId),
      now: () => clock,
    });
  }

  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The console, composed exactly as App.tsx composes it. */
function Console({ programmeId }: { programmeId: string }): React.ReactElement {
  const advertising = useAdvertising({ accountUrl: baseUrl, programmeId });
  return (
    <AdvertisingPage
      snapshot={advertising.snapshot}
      unavailable={advertising.unavailable}
      conflict={advertising.conflict}
      problems={advertising.problems}
      saving={advertising.saving}
      loading={advertising.loading}
      onReload={() => { void advertising.reload(); }}
      onSave={(creative, revision) => { void advertising.save(creative, revision); }}
    />
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

async function openConsole(programmeId = 'prog_A'): Promise<void> {
  await act(async () => { root.render(<Console programmeId={programmeId} />); });
  await settle();
}

function type(name: string, value: string): void {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
  if (field === null) throw new Error(`no field named ${name}`);
  const proto = field instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function check(name: string): void {
  const box = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (box === null) throw new Error(`no checkbox named ${name}`);
  act(() => box.click());
}

function clickText(pattern: RegExp): void {
  const button = [...container.querySelectorAll('button')]
    .find((b) => pattern.test(b.textContent ?? ''));
  if (button === undefined) throw new Error(`no button matching ${pattern}`);
  act(() => button.click());
}

/** Fill and save a complete creative from the real form. */
async function saveCreative(over: Record<string, string> = {}): Promise<void> {
  type('headline', over['headline'] ?? 'A better way to reach Lagos');
  type('body', over['body'] ?? 'Speak to your audience in the language they think in.');
  type('cta', over['cta'] ?? 'Find out how');
  if (over['href'] !== '') type('href', over['href'] ?? 'https://example.com/offer');
  if (over['startsAt'] !== undefined) type('startsAt', over['startsAt']);
  if (over['endsAt'] !== undefined) type('endsAt', over['endsAt']);
  if (over['enabled'] !== 'no') check('enabled');
  clickText(/^Save$/u);
  await settle();
}

/** What a viewer's player is served, through the real public client. */
async function deliveredTo(programmeId: string) {
  return fetchSponsoredCreative(baseUrl, programmeId, (url, init) => fetch(url, init));
}

/** Render the real listener-web slot with what delivery returned. */
function renderSlot(creative: SponsoredCreative): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const slotRoot = createRoot(host);
  act(() => { slotRoot.render(<SponsoredSlot creative={creative} />); });
  return host;
}

beforeEach(async () => {
  puts = 0;
  clock = new Date('2026-09-01T12:00:00Z');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await serve();
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((r) => closing.close(() => r()));
  }
});

describe('an operator configures an advert and viewers receive it', () => {
  it('revision 0 -> save -> revision 1 -> survives a restart', async () => {
    await openConsole();
    expect(container.textContent).toMatch(/Revision 0/u);

    await saveCreative();

    expect(container.textContent).toMatch(/Revision 1/u);
    // Exactly one PUT for one Save. No retry anywhere in the client.
    expect(puts).toBe(1);

    // A FRESH PORT over the same storage is what a restart looks like.
    const afterRestart = await createPostgresSponsoredCreative(pool.pool).read('prog_A');
    expect(afterRestart.revision).toBe(1);
    expect(afterRestart.creative?.headline).toBe('A better way to reach Lagos');
    expect(afterRestart.creative?.enabled).toBe(true);
  });

  it('the public delivery read returns exactly what was stored', async () => {
    await openConsole();
    await saveCreative();

    const delivered = await deliveredTo('prog_A');
    expect(delivered.source).toBe('programme');
    expect(delivered.creative).toEqual({
      headline: 'A better way to reach Lagos',
      body: 'Speak to your audience in the language they think in.',
      cta: 'Find out how',
      href: 'https://example.com/offer',
    });
  });

  it('listener-web renders it, still labelled Sponsored, with a safe link', async () => {
    await openConsole();
    await saveCreative();
    const delivered = await deliveredTo('prog_A');

    const host = renderSlot(delivered.creative);

    expect(host.textContent).toMatch(/A better way to reach Lagos/u);
    // THE PLACEMENT'S GUARANTEES SURVIVE. Sponsored, and separated.
    expect(host.querySelector('[aria-label="Sponsored"]')).not.toBeNull();
    expect(host.textContent).toMatch(/Sponsored/u);

    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/offer');
    expect(link?.getAttribute('target')).toBe('_blank');
    // Without noopener the opened page can navigate this one.
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    host.remove();
  });
});

describe('saving an unchanged creative changes nothing', () => {
  it('leaves the revision where it was', async () => {
    /*
     * A NO-OP MUST NOT ADVANCE THE REVISION. Advancing would tell this operator
     * their unchanged form was a change, and -- worse -- would invalidate a
     * colleague's open page for nothing, sending them to reload against an
     * edit that never happened.
     *
     * This case was missing until a mutation found it: deleting the store's
     * `IS DISTINCT FROM` clause passed every other test in this file.
     */
    await openConsole();
    await saveCreative();
    expect(container.textContent).toMatch(/Revision 1/u);

    // Press Save again, touching nothing.
    clickText(/^Save$/u);
    await settle();

    expect(container.textContent).toMatch(/Revision 1/u);
    const durable = await createPostgresSponsoredCreative(pool.pool).read('prog_A');
    expect(durable.revision).toBe(1);
  });

  it('a real change after a no-op still advances exactly once', async () => {
    await openConsole();
    await saveCreative();
    clickText(/^Save$/u);
    await settle();

    type('headline', 'A different headline');
    clickText(/^Save$/u);
    await settle();

    expect(container.textContent).toMatch(/Revision 2/u);
    const durable = await createPostgresSponsoredCreative(pool.pool).read('prog_A');
    expect(durable.revision).toBe(2);
    expect(durable.creative?.headline).toBe('A different headline');
  });
});

describe('A. another programme inherits nothing', () => {
  it('prog_A has a creative and prog_B still receives the house one', async () => {
    await openConsole();
    await saveCreative();

    const mine = await deliveredTo('prog_A');
    const other = await deliveredTo('prog_B');

    expect(mine.source).toBe('programme');
    // NO GLOBAL LATEST ADVERT. A creative belongs to one programme.
    expect(other.source).toBe('house');
    expect(other.creative.headline).not.toBe('A better way to reach Lagos');
  });

  it('an unknown programme is refused, not handed a plausible advert', async () => {
    // Every programme has a house fallback, so a 200 here would let any typo
    // masquerade as a real programme.
    const response = await fetch(`${baseUrl}/programmes/prog_NOPE/sponsored-creative`);
    expect(response.status).toBe(404);
  });
});

describe('B. switching the programme creative off', () => {
  it('advances the revision and returns viewers to the house creative', async () => {
    await openConsole();
    await saveCreative();
    expect((await deliveredTo('prog_A')).source).toBe('programme');

    // Turn "Use programme creative" off and save again.
    check('enabled');
    clickText(/^Save$/u);
    await settle();

    expect(container.textContent).toMatch(/Revision 2/u);
    const delivered = await deliveredTo('prog_A');
    // The slot is RESERVED: disabling yours is not an advert-free programme.
    expect(delivered.source).toBe('house');
    expect(container.textContent).toMatch(/PROGRAMME CREATIVE DISABLED/u);
  });
});

describe('C. a creative scheduled for later', () => {
  it('is the house creative now, and the programme creative inside the window', async () => {
    await openConsole();
    await saveCreative({ startsAt: '2026-09-01T18:00' });

    // Now: before the start.
    expect((await deliveredTo('prog_A')).source).toBe('house');
    expect(container.textContent).toMatch(/SCHEDULED/u);

    // The SERVICE clock moves; nothing is rescheduled, re-saved or re-run.
    clock = new Date('2026-09-01T19:00:00Z');
    const inside = await deliveredTo('prog_A');
    expect(inside.source).toBe('programme');
    expect(inside.creative.headline).toBe('A better way to reach Lagos');
  });
});

describe('D. a creative whose window has passed', () => {
  it('returns the house creative', async () => {
    await openConsole();
    await saveCreative({ endsAt: '2026-09-01T18:00' });
    expect((await deliveredTo('prog_A')).source).toBe('programme');

    clock = new Date('2026-09-02T00:00:00Z');
    expect((await deliveredTo('prog_A')).source).toBe('house');
  });
});

describe('E. a stale save is refused and recovered by reloading', () => {
  it('one PUT, a 409, no mutation, no retry, then a real GET', async () => {
    await openConsole();
    await saveCreative();
    const putsAfterFirstSave = puts;

    // SOMEBODY ELSE saves, straight against the durable store.
    await createPostgresSponsoredCreative(pool.pool).save('prog_A', {
      headline: 'Their headline', body: 'Their body', cta: 'Theirs',
      href: null, enabled: true, startsAt: null, endsAt: null,
    }, 1);

    // This operator is still editing revision 1 while the server is on 2.
    type('headline', 'My competing headline');
    clickText(/^Save$/u);
    await settle();

    expect(container.textContent)
      .toMatch(/Advertising changed since you opened this page/u);
    expect(container.textContent).toMatch(/Reload the latest revision before saving/u);
    // EXACTLY ONE further PUT. An automatic retry would be the silent
    // overwrite the gate exists to prevent.
    expect(puts).toBe(putsAfterFirstSave + 1);

    // Nothing of this operator's landed; the other person's survived intact.
    const durable = await createPostgresSponsoredCreative(pool.pool).read('prog_A');
    expect(durable.revision).toBe(2);
    expect(durable.creative?.headline).toBe('Their headline');

    // RELOAD is a real GET.
    clickText(/Reload revision/u);
    await settle();
    expect(container.textContent).toMatch(/Revision 2/u);
    expect(container.textContent).toMatch(/Their headline|Revision 2/u);
    expect(container.textContent)
      .not.toMatch(/Advertising changed since you opened this page/u);
  });
});

describe('F. an unsafe destination', () => {
  it('is refused, never stored, and never reaches a viewer', async () => {
    await openConsole();
    await saveCreative({ href: 'javascript:alert(1)' });

    // Refused by the server, and the page says which field.
    expect(container.textContent).toMatch(/https:\/\/ address/u);
    expect(container.textContent).toMatch(/Revision 0/u);

    // NOT PERSISTED.
    const durable = await createPostgresSponsoredCreative(pool.pool).read('prog_A');
    expect(durable.revision).toBe(0);
    expect(durable.creative).toBeNull();

    // And viewers are unaffected: the house creative, whose link is ours.
    const delivered = await deliveredTo('prog_A');
    expect(delivered.source).toBe('house');
    expect(delivered.creative.href).toMatch(/^https:\/\//u);
    const host = renderSlot(delivered.creative);
    expect(host.innerHTML).not.toMatch(/javascript:/u);
    host.remove();
  });
});

describe('G. a creative with no destination', () => {
  it('renders, and offers nothing that pretends to navigate', async () => {
    await openConsole();
    await saveCreative({ href: '' });
    const delivered = await deliveredTo('prog_A');

    expect(delivered.source).toBe('programme');
    expect(delivered.creative.href).toBeNull();

    const host = renderSlot(delivered.creative);
    expect(host.textContent).toMatch(/Find out how/u);
    // NO ANCHOR AT ALL. A link that goes nowhere is worse than plain text.
    expect(host.querySelector('a')).toBeNull();
    host.remove();
  });
});

describe('H. a deployment with no database', () => {
  it('says advertising cannot be configured, and offers no form to fake it', async () => {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await serve({ withDatabase: false });

    await openConsole();

    expect(container.textContent).toMatch(/Advertising cannot be configured/u);
    expect(container.textContent).toMatch(/Durable storage is not configured/u);
    // NO LOCAL FALLBACK. A form here would invite a save that goes nowhere.
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[name="headline"]')).toBeNull();
  });
});
