/** @author masterzee001 */
/**
 * Signing in with a provider, on the phone.
 *
 * What cannot be tested here is the system browser itself -- that is a real
 * native surface and the stub refuses to pretend otherwise. What CAN be
 * tested is everything around it, and that is where the failures live: what
 * the app asks for, what it accepts back, and what it refuses to draw.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_PROVIDERS,
  describeCallbackError,
  describeProviderFailure,
  fetchProviders,
  readErrorFromUrl,
  readHandoffFromUrl,
  signInWithKingsChat,
} from './providerSignIn';
import { providerButtonPlan } from '../screens/ProviderButtons';

const ACCOUNT_URL = 'https://staging.consummate7.com/auth';

function stub(outcome: { status: number; body?: unknown } | Error) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    if (outcome instanceof Error) throw outcome;
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('which providers to offer', () => {
  it('reports what the service says', async () => {
    const { fetchImpl } = stub({ status: 200, body: { google: true, kingschat: true } });
    expect(await fetchProviders(ACCOUNT_URL, fetchImpl)).toEqual({
      google: true,
      kingschat: true,
    });
  });

  it('offers nothing when it cannot ask', async () => {
    // On a phone a dead button reads as a tap that did nothing, so the person
    // taps it again. Drawing none is honest.
    expect(await fetchProviders(ACCOUNT_URL, stub(new Error('offline')).fetchImpl)).toEqual(
      NO_PROVIDERS,
    );
    expect(await fetchProviders(ACCOUNT_URL, stub({ status: 500 }).fetchImpl)).toEqual(
      NO_PROVIDERS,
    );
  });

  it('treats anything but strictly true as no', async () => {
    const { fetchImpl } = stub({ status: 200, body: { google: 'yes', kingschat: 1 } });
    expect(await fetchProviders(ACCOUNT_URL, fetchImpl)).toEqual(NO_PROVIDERS);
  });
});

describe('reading the url the app is opened with', () => {
  it('finds a handoff in the fragment', () => {
    expect(readHandoffFromUrl('videofy://auth#c7_handoff=abc123')).toBe('abc123');
    // The fragment is where the account service puts it precisely because no
    // server ever receives one.
    expect(readHandoffFromUrl('videofy://auth?x=1#c7_handoff=abc123')).toBe('abc123');
    expect(readHandoffFromUrl('videofy://auth')).toBeNull();
    expect(readHandoffFromUrl('videofy://auth#c7_handoff=')).toBeNull();
    expect(readHandoffFromUrl(null)).toBeNull();
    expect(readHandoffFromUrl('')).toBeNull();
  });

  it('finds an error in the query', () => {
    expect(readErrorFromUrl('videofy://auth?error=unavailable')).toBe('unavailable');
    expect(readErrorFromUrl('videofy://auth')).toBeNull();
    // A handoff is not an error, and a url carrying one must not be reported
    // as a failure on top of signing somebody in.
    expect(readErrorFromUrl('videofy://auth#c7_handoff=abc')).toBeNull();
  });

  it('does not mistake a fragment for a query', () => {
    // Everything after the first # is fragment, so an `error=` written there
    // is not a query parameter and reading it as one would invent a failure.
    expect(readErrorFromUrl('videofy://auth#error=nope')).toBeNull();
  });
});

describe('starting a kingschat login', () => {
  it('tells the server a phone started it', async () => {
    const { fetchImpl, calls } = stub({ status: 200, body: {} });
    await signInWithKingsChat(ACCOUNT_URL, fetchImpl);
    // `client=device` is what makes the callback come back through the app
    // scheme instead of landing on a web page the phone cannot act on.
    expect(calls[0]).toBe(`${ACCOUNT_URL}/oauth/kingschat/start?client=device`);
  });

  it('reports an off provider as unavailable rather than as a failure', async () => {
    const { fetchImpl } = stub({ status: 503 });
    // Different things: one is a deployment that does not offer this, the
    // other is something that went wrong. Only the second is worth a retry.
    expect(await signInWithKingsChat(ACCOUNT_URL, fetchImpl)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('fails rather than inventing a login url of its own', async () => {
    // The server holds the client id and issues the CSRF token that must come
    // back with the code; a url built here would be refused at the callback.
    const { fetchImpl } = stub({ status: 200, body: { authorizationUrl: 42 } });
    expect(await signInWithKingsChat(ACCOUNT_URL, fetchImpl)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(await signInWithKingsChat(ACCOUNT_URL, stub(new Error('offline')).fetchImpl)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('what the person is told', () => {
  it('says nothing when they changed their mind', () => {
    // An error banner for somebody's own decision is the app arguing with
    // them about a thing they meant to do.
    expect(describeProviderFailure('cancelled')).toBeNull();
  });

  it('has wording for the two that are not their doing', () => {
    expect(describeProviderFailure('unavailable')).toBeTruthy();
    expect(describeProviderFailure('failed')).toBeTruthy();
  });
});

describe('which buttons the phone draws', () => {
  it('draws nothing while the question is unanswered, and nothing when there is nothing', () => {
    // Most of this feature's life: both switches off, so the correct render
    // is nothing at all.
    expect(providerButtonPlan(null, true).showRow).toBe(false);
    expect(providerButtonPlan({ google: false, kingschat: false }, true).showRow).toBe(false);
  });

  it('will not draw Google into a build with no client id', () => {
    // The switch being on at the server is not enough: without an id
    // compiled into THIS build the request fails at Google with an error
    // nobody can act on, which on a phone is a tap that did nothing.
    expect(providerButtonPlan({ google: true, kingschat: false }, false)).toEqual({
      showRow: false,
      google: false,
      kingschat: false,
    });
  });

  it('draws what the deployment and the build both support', () => {
    expect(providerButtonPlan({ google: true, kingschat: true }, true)).toEqual({
      showRow: true,
      google: true,
      kingschat: true,
    });
    // KingsChat needs nothing compiled in: the server builds the login url.
    expect(providerButtonPlan({ google: true, kingschat: true }, false)).toEqual({
      showRow: true,
      google: false,
      kingschat: true,
    });
  });
});

describe('what a refused sign-in is told', () => {
  it('names the cause for no-email instead of asking them to try again', () => {
    // Five people on 10 Oct 2026 were refused for this and every one was
    // shown "try again" -- an instruction to repeat the thing that cannot work.
    const words = describeCallbackError('no-email') ?? '';
    expect(words).toMatch(/no email address/i);
    expect(words).not.toMatch(/try again/i);
  });

  it('never says whether an address already has an account', () => {
    const words = describeCallbackError('unverified-email-conflict') ?? '';
    expect(words).not.toMatch(/exists|already registered|taken/i);
  });

  it('says nothing for a cancelled attempt, and something for any reason it has never met', () => {
    expect(describeCallbackError('cancelled')).toBeNull();
    expect(describeCallbackError(null)).toBeNull();
    expect(describeCallbackError('something-new')).toBeTruthy();
  });
});
