/** @author masterzee001 */
/**
 * Mobile's half of the advertising delivery join.
 *
 * WHAT MUST NOT HAPPEN, in order of cost: showing a programme creative that is
 * not currently sold; crashing a listener out of a live programme because an
 * advert link would not open; and rendering a call to action that responds to a
 * tap by doing nothing.
 *
 * Everything asserted here is behaviour rather than layout, which is why it
 * lives beside the component instead of inside a renderer.
 */
import { describe, expect, it, vi } from 'vitest';
import { HOUSE_CREATIVE } from '@videofy-live/shared-types';
import {
  HOUSE_DELIVERY,
  creativeOpener,
  fetchSponsoredCreative,
} from '../sponsoredDelivery';

const PROGRAMME = {
  headline: 'A better way to reach Lagos',
  body: 'Speak to your audience in the language they think in.',
  cta: 'Find out how',
  href: 'https://example.com/offer',
};

function respond(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('reading the programme creative', () => {
  it('returns the programme creative the service delivered', async () => {
    const delivered = await fetchSponsoredCreative(
      'https://account.example', 'prog_A',
      respond({ programmeId: 'prog_A', placement: 'programme-sponsored-slot', source: 'programme', creative: PROGRAMME }),
    );
    expect(delivered.source).toBe('programme');
    expect(delivered.creative).toEqual(PROGRAMME);
  });

  it('asks the public delivery path, never the operator one', async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ source: 'house', creative: HOUSE_CREATIVE }) };
    }) as unknown as typeof fetch;
    await fetchSponsoredCreative('https://account.example/', 'prog_A', spy);
    expect(seen[0]).toBe('https://account.example/programmes/prog_A/sponsored-creative');
    // The operator surface is authenticated and carries configuration a viewer
    // has no business receiving.
    expect(seen[0]).not.toMatch(/operator/u);
  });
});

describe('a failure falls back to the house creative and never invents one', () => {
  it('falls back when the service refuses', async () => {
    const delivered = await fetchSponsoredCreative(
      'https://account.example', 'prog_A', respond({}, false, 404),
    );
    expect(delivered).toEqual(HOUSE_DELIVERY);
    expect(delivered.creative).toEqual(HOUSE_CREATIVE);
  });

  it('falls back when the network fails outright', async () => {
    const dead = (async () => {
      throw new Error('no route to host');
    }) as unknown as typeof fetch;
    const delivered = await fetchSponsoredCreative('https://account.example', 'prog_A', dead);
    expect(delivered.source).toBe('house');
  });

  it('falls back on a malformed answer rather than rendering half a card', async () => {
    const delivered = await fetchSponsoredCreative(
      'https://account.example', 'prog_A',
      respond({ source: 'programme', creative: { headline: 'only this' } }),
    );
    expect(delivered.source).toBe('house');
    expect(delivered.creative).toEqual(HOUSE_CREATIVE);
  });

  it('never reports "programme" while carrying the house creative', async () => {
    // The combination that would let a fallback masquerade as a real advert.
    const delivered = await fetchSponsoredCreative(
      'https://account.example', '', respond({ source: 'programme', creative: PROGRAMME }),
    );
    expect(delivered.source).toBe('house');
  });
});

describe('the call to action', () => {
  it('has no press handler at all when there is no destination', () => {
    // Not a handler that quietly does nothing -- a button that reacts to a tap
    // by doing nothing is indistinguishable from a broken one.
    expect(creativeOpener(null)).toBeNull();
    expect(creativeOpener('   ')).toBeNull();
  });

  it('opens the exact stored address through the platform opener', () => {
    const opener = vi.fn(async () => true);
    const open = creativeOpener('https://example.com/offer', opener);
    expect(open).not.toBeNull();
    open?.();
    expect(opener).toHaveBeenCalledWith('https://example.com/offer');
  });

  it('survives an opener that rejects, rather than taking the programme down', async () => {
    const opener = vi.fn(async () => {
      throw new Error('no activity found to handle intent');
    });
    const open = creativeOpener('https://example.com/offer', opener);
    // The assertion is that this does not throw and leaves no unhandled
    // rejection behind: a listener must not be dropped out of a live programme
    // because an advert link had nowhere to go.
    expect(() => open?.()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
