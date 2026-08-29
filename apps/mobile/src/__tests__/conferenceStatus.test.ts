/** @author masterzee001 */
/**
 * The gateway's word on a remembered room, and `unknown` for everything
 * the phone cannot read as a word -- so Join is never greyed on a guess.
 */
import { describe, expect, it } from 'vitest';
import { fetchConferenceStatus, fetchConferenceStatuses, parseConferenceStatus } from '../conference/conferenceStatus';

function fakeFetch(answer: (url: string) => { ok: boolean; body?: unknown } | Error): typeof fetch & { readonly urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const outcome = answer(url);
    if (outcome instanceof Error) throw outcome;
    return {
      ok: outcome.ok,
      async json() {
        return outcome.body;
      },
    } as Response;
  }) as typeof fetch;
  return Object.assign(impl, { urls });
}

describe('parseConferenceStatus', () => {
  it('reads the three words and nothing else', () => {
    expect(parseConferenceStatus({ status: 'active' })).toBe('active');
    expect(parseConferenceStatus({ status: 'ended' })).toBe('ended');
    expect(parseConferenceStatus({ status: 'unknown' })).toBe('unknown');
    expect(parseConferenceStatus({ status: 'finished' })).toBe('unknown');
    expect(parseConferenceStatus({})).toBe('unknown');
    expect(parseConferenceStatus(null)).toBe('unknown');
    expect(parseConferenceStatus('ended')).toBe('unknown');
  });
});

describe('fetchConferenceStatus', () => {
  it('asks the status route for the code, URL-encoded', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: true, body: { status: 'ended' } }));
    expect(await fetchConferenceStatus('https://gw.test', 'calm river 12', fetchImpl)).toBe('ended');
    expect(fetchImpl.urls).toEqual(['https://gw.test/calls/calm%20river%2012/status']);
  });

  it('is unknown on a refusal, a missing route or no network', async () => {
    expect(await fetchConferenceStatus('https://gw.test', 'x-y-1', fakeFetch(() => ({ ok: false })))).toBe('unknown');
    expect(await fetchConferenceStatus('https://gw.test', 'x-y-1', fakeFetch(() => new Error('offline')))).toBe('unknown');
    expect(await fetchConferenceStatus('https://gw.test', 'x-y-1', fakeFetch(() => ({ ok: true, body: '<html>' })))).toBe('unknown');
  });
});

describe('fetchConferenceStatuses', () => {
  it('asks once per distinct code and answers each', async () => {
    const fetchImpl = fakeFetch((url) => (url.includes('/gone-') ? { ok: true, body: { status: 'ended' } } : { ok: true, body: { status: 'active' } }));
    const statuses = await fetchConferenceStatuses('https://gw.test', ['gone-a-1', 'live-b-2', 'gone-a-1'], fetchImpl);
    expect(statuses).toEqual({ 'gone-a-1': 'ended', 'live-b-2': 'active' });
    expect(fetchImpl.urls).toHaveLength(2);
  });

  it('answers unknown for a code it could not ask, without failing the rest', async () => {
    const fetchImpl = fakeFetch((url) => (url.includes('/bad-') ? new Error('boom') : { ok: true, body: { status: 'active' } }));
    expect(await fetchConferenceStatuses('https://gw.test', ['bad-a-1', 'ok-b-2'], fetchImpl)).toEqual({ 'bad-a-1': 'unknown', 'ok-b-2': 'active' });
    expect(await fetchConferenceStatuses('https://gw.test', [], fetchImpl)).toEqual({});
  });
});
