/** @author masterzee001 */
/**
 * The three pre-join questions, and the words for every telephone state.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_DIRECT_STATES,
  createDirectCallApi,
  directStateWords,
} from '../call/directCallApi';

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; method: string; auth: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', auth: headers['authorization'] ?? '' });
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    const status = route?.[1].status ?? 404;
    return {
      ok: status >= 200 && status < 300,
      json: async () => route?.[1].body ?? {},
    } as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('createDirectCallApi', () => {
  it('rings only when the server says the call is live, carrying the bearer session', async () => {
    const f = fakeFetch({
      '/calls/direct/ring-1': {
        status: 200,
        body: { ring: true, state: 'calling', mode: 'translated', callerAccountId: 'acct_a', callerName: 'Zoe' },
      },
    });
    const api = createDirectCallApi({ gatewayUrl: 'https://gw/', sessionToken: () => 'tok', fetchImpl: f.fetchImpl });
    const check = await api.check('ring-1');
    expect(check).toEqual({ ring: true, state: 'calling', mode: 'translated', callerAccountId: 'acct_a', callerName: 'Zoe' });
    expect(f.calls[0]?.url).toBe('https://gw/calls/direct/ring-1');
    expect(f.calls[0]?.auth).toBe('Bearer tok');
  });

  it('a stale push stays silent: expired is not a ring, and a 404 is not a ring', async () => {
    const f = fakeFetch({
      '/calls/direct/ring-old': { status: 200, body: { ring: false, state: 'no_answer', mode: 'normal' } },
    });
    const api = createDirectCallApi({ gatewayUrl: 'https://gw', sessionToken: () => 'tok', fetchImpl: f.fetchImpl });
    expect((await api.check('ring-old'))?.ring).toBe(false);
    expect(await api.check('ring-unknown')).toBe(null);
  });

  it('never rings without a session, and never throws into a notification handler', async () => {
    const api = createDirectCallApi({
      gatewayUrl: 'https://gw',
      sessionToken: () => null,
      fetchImpl: (async () => {
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(await api.check('ring-1')).toBe(null);
    expect(await api.ackRinging('ring-1')).toBe(false);
    expect(await api.decline('ring-1')).toBe(false);
  });

  it('acknowledges ringing and declines with POSTs', async () => {
    const f = fakeFetch({
      '/calls/direct/ring-1/ringing': { status: 200, body: { live: true } },
      '/calls/direct/ring-1/decline': { status: 200, body: { declined: true } },
    });
    const api = createDirectCallApi({ gatewayUrl: 'https://gw', sessionToken: () => 'tok', fetchImpl: f.fetchImpl });
    expect(await api.ackRinging('ring-1')).toBe(true);
    expect(await api.decline('ring-1')).toBe(true);
    expect(f.calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });
});

describe('directStateWords', () => {
  it('has a human sentence for every state and never a code', () => {
    for (const state of [
      'calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting',
      'busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended',
    ]) {
      const words = directStateWords(state, 'Zoe');
      expect(words.length).toBeGreaterThan(3);
      expect(words).not.toMatch(/ring-|code/iu);
    }
    expect(directStateWords('busy', 'Zoe')).toBe('Zoe is busy');
    expect(directStateWords('no_answer', 'Zoe')).toBe('No answer');
    expect(TERMINAL_DIRECT_STATES.has('connected')).toBe(false);
    expect(TERMINAL_DIRECT_STATES.has('network')).toBe(true);
  });
});
