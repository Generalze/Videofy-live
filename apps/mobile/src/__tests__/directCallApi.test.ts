/** @author masterzee001 */
/**
 * The three pre-join questions, and the words for every telephone state.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_DIRECT_STATES,
  createDirectCallApi,
  directStateWords,
  terminalStateAfterFailedResume,
  type DirectCallCheck,
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

/*
 * The seat that could not be resumed.
 *
 * A phone whose socket dropped while the other party hung up is told nothing:
 * the state that carried the news went to a room it had already left. These
 * pin the rule that decides whether such a phone may finally close the call.
 */
describe('terminalStateAfterFailedResume', () => {
  const check = (state: string): DirectCallCheck => ({
    ring: false,
    state,
    mode: 'normal',
    callerAccountId: 'acct_a',
    callerName: 'Ada',
  });

  it('ends the call when the server names a terminal state', () => {
    expect(terminalStateAfterFailedResume(check('ended'))).toBe('ended');
    expect(terminalStateAfterFailedResume(check('declined'))).toBe('declined');
    expect(terminalStateAfterFailedResume(check('no_answer'))).toBe('no_answer');
  });

  it('keeps waiting when the read failed', () => {
    // Null is a dead network as often as a vanished call. Ending here would
    // hang up a live call on one lost packet.
    expect(terminalStateAfterFailedResume(null)).toBeNull();
  });

  it('keeps waiting while the call is still live', () => {
    expect(terminalStateAfterFailedResume(check('connected'))).toBeNull();
    expect(terminalStateAfterFailedResume(check('ringing'))).toBeNull();
    expect(terminalStateAfterFailedResume(check('reconnecting'))).toBeNull();
  });
});

/*
 * THE SEAM. The rule above is worthless if nothing calls it. This repository
 * has shipped both halves of a feature with the join missing more than once,
 * and every unit test passed each time, so the join is asserted here directly.
 */
describe('the failed resume is actually reconciled', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../call/callConnection.ts', import.meta.url)),
    'utf8',
  ).replace(/\r\n/gu, '\n');

  it('asks the server after a resume that failed', () => {
    expect(source).toContain('reconcileDirectState');
    // Both ways a resume ends badly: refused, and a seat that came back different.
    const calls = source.match(/void this\.reconcileDirectState\(\);/gu) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('reconciles through the shared rule rather than its own copy', () => {
    expect(source).toContain('terminalStateAfterFailedResume');
  });
});
