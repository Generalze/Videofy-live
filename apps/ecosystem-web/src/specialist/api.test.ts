/** @author masterzee001 */
/**
 * What the API client does with each kind of answer.
 *
 * These are the seams where a server problem becomes a user-visible one, and
 * the interesting cases are all failures rather than successes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpecialistApi, dayWord, stateTone, stateWord } from './api';

function answer(body: string, init: ResponseInit = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, ...init })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading an answer', () => {
  it('returns the payload on a normal success', async () => {
    answer(JSON.stringify({ accountId: 'acct_zoe', tracks: [], assignments: [] }));
    const result = await createSpecialistApi('http://x', 'tok').me();
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.accountId).toBe('acct_zoe');
  });

  it('PIN: a 200 that is not JSON is a FAILURE, not an empty success', async () => {
    // A deployment whose reverse proxy does not route the account prefix
    // answers every API call with the SPA shell: status 200, text/html. Read as
    // an empty payload it becomes an object with no fields, and the first
    // property a component reads throws — a blank page from a server that
    // answered happily. Found in the visual audit, where the built bundle asks
    // for /auth and the local preview replied with index.html.
    answer('<!doctype html><html><body>the app shell</body></html>');
    const result = await createSpecialistApi('http://x', 'tok').me();
    expect(result.ok).toBe(false);
    expect(result.ok === false && 'error' in result && result.error).toMatch(/could not read/u);
  });

  it('PIN: a 401 is a sign-in, not an error message', async () => {
    // The portal turns it into the existing C7 join flow. Reported as an error
    // string, a caller could forget to distinguish it and would render "Sign in
    // to continue." as a failure.
    answer('{"error":"Sign in to continue."}', { status: 401 });
    const result = await createSpecialistApi('http://x', 'tok').me();
    expect(result).toEqual({ ok: false, unauthenticated: true });
  });

  it('carries the SERVER’s words on a refusal, not its own', async () => {
    // The rule that produced the refusal lives on the server. A second copy of
    // the wording here would eventually say "locked" when it is open.
    answer('{"error":"Review is not open for this language yet.","reason":"review-locked"}', {
      status: 403,
    });
    const result = await createSpecialistApi('http://x', 'tok').packet('asg_1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && 'error' in result && result.error).toBe(
      'Review is not open for this language yet.',
    );
    expect(result.ok === false && 'reason' in result && result.reason).toBe('review-locked');
  });

  it('PIN: an unreachable server is not a sign-out', async () => {
    // A flaky connection must not bounce somebody to the join form because
    // their train went into a tunnel.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const result = await createSpecialistApi('http://x', 'tok').me();
    expect(result.ok).toBe(false);
    expect(result.ok === false && 'unauthenticated' in result && result.unauthenticated).toBeFalsy();
  });

  it('accepts an empty body on a success that has none', async () => {
    answer('', { status: 200 });
    const result = await createSpecialistApi('http://x', 'tok').me();
    expect(result.ok).toBe(true);
  });

  it('sends the bearer token and no credential anywhere else', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await createSpecialistApi('http://x/', 'tok').freezeElicitation('yo');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x/specialists/elicitation/yo/freeze');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    // token-logging: allowed (asserting the credential is NOT in the URL)
    expect(url).not.toContain('tok');
  });

  it('escapes a language so it cannot leave its path segment', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await createSpecialistApi('http://x', 'tok').consent('yo/../../admin');
    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://x/specialists/consent/yo%2F..%2F..%2Fadmin');
  });
});

describe('the words a state is printed in', () => {
  it('prints every state the server can send', () => {
    expect(stateWord('ASSESSMENT_IN_PROGRESS')).toBe('Assessment in progress');
    expect(stateWord('QUALIFIED')).toBe('Qualified');
  });

  it('PIN: an unknown state prints as itself rather than as nothing', () => {
    // A dashboard that silently shows an empty chip for a state it does not
    // know is worse than one showing the raw word: the raw word is a bug report.
    expect(stateWord('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(stateTone('SOMETHING_NEW')).toBe('neutral');
  });

  it('prints an absent date as a dash, never as null', () => {
    expect(dayWord(null)).toBe('—');
    expect(dayWord(undefined)).toBe('—');
  });
});
