/**
 * The browser half of signing in with a provider.
 *
 * Two things here are worth more than the rest. One: an absent handoff is the
 * ordinary case on every page load, and reporting it as a failure would put
 * an error in front of everybody who ever visits. Two: the buttons must never
 * be drawn for a provider the deployment does not have, because that button
 * answers 503 and the person pressing it blames themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  completeHandoff,
  describeSignInError,
  fetchProviders,
  hashWithoutHandoff,
  kingsChatLoginUrl,
  providerRowPlan,
  readHandoff,
  signInWithGoogle,
} from './federatedSignIn';

const ACCOUNT_URL = 'https://consummate7.com/auth';

function stub(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown } | Error,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const outcome = handler(String(url), init);
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
    const { fetchImpl } = stub(() => ({ status: 200, body: { google: true, kingschat: false } }));
    expect(await fetchProviders({ accountUrl: ACCOUNT_URL, fetchImpl })).toEqual({
      google: true,
      kingschat: false,
    });
  });

  it('offers nothing when it cannot ask', async () => {
    // A drawn-but-dead button is worse than no button: it answers 503, and
    // the person cannot tell that from their own account being refused.
    const down = stub(() => new Error('network'));
    expect(await fetchProviders({ accountUrl: ACCOUNT_URL, fetchImpl: down.fetchImpl })).toEqual({
      google: false,
      kingschat: false,
    });

    const broken = stub(() => ({ status: 500 }));
    expect(await fetchProviders({ accountUrl: ACCOUNT_URL, fetchImpl: broken.fetchImpl })).toEqual({
      google: false,
      kingschat: false,
    });
  });

  it('treats anything that is not strictly true as no', async () => {
    const { fetchImpl } = stub(() => ({
      status: 200,
      body: { google: 'yes', kingschat: 1 },
    }));
    expect(await fetchProviders({ accountUrl: ACCOUNT_URL, fetchImpl })).toEqual({
      google: false,
      kingschat: false,
    });
  });
});

describe('what the provider row draws', () => {
  const GOOGLE_ID = '692573915541-web.apps.googleusercontent.com';

  it('draws nothing while the question is still unanswered', () => {
    // A row appearing a second after the page settles moves the submit
    // button out from under somebody's cursor.
    expect(providerRowPlan(null, GOOGLE_ID).showRow).toBe(false);
  });

  it('draws nothing when the deployment has neither provider', () => {
    // The normal state while both switches are off, which is most of this
    // feature's life. Not an empty row, not a heading with nothing under it.
    expect(providerRowPlan({ google: false, kingschat: false }, GOOGLE_ID)).toEqual({
      showRow: false,
      showGoogle: false,
      showKingsChat: false,
    });
  });

  it('will not draw Google without a client id to draw it with', () => {
    // Google's own script renders the button and cannot without one, so the
    // slot would be an empty box where a control should be.
    for (const id of [undefined, '', '   ']) {
      expect(providerRowPlan({ google: true, kingschat: false }, id)).toEqual({
        showRow: false,
        showGoogle: false,
        showKingsChat: false,
      });
    }
  });

  it('draws each provider the deployment actually has', () => {
    expect(providerRowPlan({ google: true, kingschat: false }, GOOGLE_ID)).toEqual({
      showRow: true,
      showGoogle: true,
      showKingsChat: false,
    });
    // KingsChat needs no client id here: the server builds the login url,
    // because it holds the id and issues the CSRF token.
    expect(providerRowPlan({ google: false, kingschat: true }, undefined)).toEqual({
      showRow: true,
      showGoogle: false,
      showKingsChat: true,
    });
  });
});

describe('the handoff in the fragment', () => {
  it('finds one and ignores everything else', () => {
    expect(readHandoff('#c7_handoff=abc123')).toBe('abc123');
    expect(readHandoff('c7_handoff=abc123')).toBe('abc123');
    expect(readHandoff('#section-two&c7_handoff=abc123')).toBe('abc123');
    expect(readHandoff('')).toBeNull();
    expect(readHandoff('#section-two')).toBeNull();
    expect(readHandoff('#c7_handoff=')).toBeNull();
  });

  it('removes the handoff and keeps the rest of the fragment', () => {
    expect(hashWithoutHandoff('#c7_handoff=abc')).toBe('');
    expect(hashWithoutHandoff('#tab=live&c7_handoff=abc')).toBe('#tab=live');
  });

  it('leaves a fragment of ours alone when there is no handoff in it', () => {
    // Rebuilding it would rewrite a plain anchor: `#pricing` round-trips
    // through URLSearchParams as `#pricing=`, which matches nothing on the
    // page. Every ordinary page load passes through here.
    expect(hashWithoutHandoff('#pricing')).toBe('#pricing');
    expect(hashWithoutHandoff('')).toBe('');
    expect(hashWithoutHandoff('#tab=live')).toBe('#tab=live');
  });

  it('does nothing at all when there is no handoff', async () => {
    const { fetchImpl, calls } = stub(() => ({ status: 200 }));
    // Every ordinary page load takes this path. A request here would be one
    // per visit, and an error would be an error per visit.
    expect(await completeHandoff({ accountUrl: ACCOUNT_URL, fetchImpl, hash: '' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('exchanges a handoff for a session', async () => {
    const { fetchImpl, calls } = stub(() => ({
      status: 200,
      body: { accountId: 'acct_0000000000000001', token: 'tok', voiceGender: 'female' },
    }));
    const session = await completeHandoff({
      accountUrl: ACCOUNT_URL,
      fetchImpl,
      hash: '#c7_handoff=abc123',
    });
    expect(session?.accountId).toBe('acct_0000000000000001');
    expect(session?.voiceGender).toBe('female');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '{}')).toEqual({ handoff: 'abc123' });
  });

  it('returns nothing for a spent or expired handoff', async () => {
    const { fetchImpl } = stub(() => ({ status: 401, body: { error: 'expired' } }));
    expect(
      await completeHandoff({ accountUrl: ACCOUNT_URL, fetchImpl, hash: '#c7_handoff=abc' }),
    ).toBeNull();
  });

  it('refuses a reply that is missing the parts a session needs', async () => {
    // A half-written session is worse than none: it stores a token with no
    // account and every later surface disagrees about who is signed in.
    const { fetchImpl } = stub(() => ({ status: 200, body: { token: 'tok' } }));
    expect(
      await completeHandoff({ accountUrl: ACCOUNT_URL, fetchImpl, hash: '#c7_handoff=abc' }),
    ).toBeNull();
  });
});

describe('google', () => {
  it('posts the id token and returns the session', async () => {
    const { fetchImpl, calls } = stub(() => ({
      status: 201,
      body: { accountId: 'acct_0000000000000001', token: 'tok' },
    }));
    const result = await signInWithGoogle({ accountUrl: ACCOUNT_URL, fetchImpl, idToken: 'id-tok' });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(`${ACCOUNT_URL}/oauth/google`);
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '{}')).toEqual({ idToken: 'id-tok' });
  });

  it('carries the service wording through rather than inventing its own', async () => {
    const { fetchImpl } = stub(() => ({
      status: 409,
      body: { error: 'This account is already connected to a different Google account.' },
    }));
    const result = await signInWithGoogle({ accountUrl: ACCOUNT_URL, fetchImpl, idToken: 't' });
    expect(result.ok).toBe(false);
    // The service is careful about what its refusals disclose; rewriting them
    // here is how that care gets undone.
    expect(result.ok === false && result.reason).toMatch(/already connected/);
  });

  it('says it could not reach C7 when it could not', async () => {
    const { fetchImpl } = stub(() => new Error('offline'));
    const result = await signInWithGoogle({ accountUrl: ACCOUNT_URL, fetchImpl, idToken: 't' });
    expect(result.ok === false && result.reason).toMatch(/could not reach/i);
  });
});

describe('kingschat', () => {
  it('takes the url from the server rather than building one', async () => {
    const { fetchImpl, calls } = stub(() => ({
      status: 200,
      body: { authorizationUrl: 'https://accounts.kingschat.online/log-in?clientId=x&origin=y' },
    }));
    const url = await kingsChatLoginUrl({
      accountUrl: ACCOUNT_URL,
      fetchImpl,
      returnPath: '/app/',
    });
    // The server holds the client id and issues the CSRF token that has to
    // come back with the code. A url invented here would be refused at the
    // callback, correctly.
    expect(url).toContain('accounts.kingschat.online');
    expect(calls[0]?.url).toBe(`${ACCOUNT_URL}/oauth/kingschat/start?returnPath=%2Fapp%2F`);
  });

  it('returns nothing when the provider is off', async () => {
    const { fetchImpl } = stub(() => ({ status: 503 }));
    expect(await kingsChatLoginUrl({ accountUrl: ACCOUNT_URL, fetchImpl })).toBeNull();
  });
});

describe('wording for a failed callback', () => {
  it('says nothing when nothing went wrong', () => {
    expect(describeSignInError(null)).toBeNull();
  });

  it('never reveals whether an address already has an account', () => {
    const message = describeSignInError('unverified-email-conflict') ?? '';
    // The whole point of the refusal is that the address is not confirmed as
    // theirs. Saying "an account exists for that address" would answer, for
    // anybody who asked, a question they had no right to ask.
    expect(message).not.toMatch(/exists|already registered|taken/i);
    // It still has to tell somebody who genuinely has one what to do.
    expect(message).toMatch(/settings/i);
  });

  it('has wording for every reason the service can send', () => {
    for (const reason of [
      'expired',
      'cancelled',
      'unavailable',
      'no-email',
      'unverified-email-conflict',
      'account-already-linked',
      'account-not-created',
    ]) {
      expect(describeSignInError(reason)).toBeTruthy();
    }
    // And something sane for one it has never heard of, rather than nothing
    // on screen while the person waits for a page that already finished.
    expect(describeSignInError('something-new')).toBeTruthy();
  });
});
