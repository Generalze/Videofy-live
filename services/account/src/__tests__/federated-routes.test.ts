/**
 * Signing in with Google or KingsChat, over HTTP.
 *
 * These drive the real express surface with real signed Google tokens and a
 * stubbed KingsChat, because the parts most worth testing are the ones a unit
 * test cannot see: what status a refusal carries, where a redirect points,
 * and what ends up in a url. A session token in a query string is a working
 * credential in somebody's browser history, and only a test that looks at the
 * actual Location header will ever notice.
 */
import express from 'express';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEphemeralAccountIdentities } from '../account-identities.js';
import { AccountStore } from '../account-store.js';
import { FederatedSignIn } from '../federated-sign-in.js';
import { registerFederatedRoutes } from '../federated-routes.js';
import { GoogleIdTokenVerifier } from '../google-id-token.js';
import { KingsChatIdentity } from '../kingschat-identity.js';
import { OAuthStateStore, SignInHandoffStore } from '../oauth-state.js';
import type { FederatedProviders } from '../federated-config.js';

const NOW_MS = 1_760_000_000_000;
const AUDIENCE = 'videofy-web.apps.googleusercontent.com';
const ORIGIN = 'https://consummate7.com';
const KC_CLIENT = '11c1340f-cbfa-4de3-b12d-dbe24f77b0d8';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function googleToken(overrides: Record<string, unknown> = {}): string {
  const header = { alg: 'RS256', kid: 'key-1', typ: 'JWT' };
  const payload = {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: 'google-sub-1',
    email: 'zoe@example.com',
    email_verified: true,
    name: 'Zoe',
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...overrides,
  };
  const body = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  signer.end();
  return `${body}.${signer.sign(pair.privateKey).toString('base64url')}`;
}

interface Options {
  googleOn?: boolean;
  kingschatOn?: boolean;
  kcProfile?: unknown;
  kcTokenStatus?: number;
}

interface Harness {
  url: string;
  accounts: AccountStore;
  state: OAuthStateStore;
  handoffs: SignInHandoffStore;
  warnings: string[];
  close: () => Promise<void>;
}

async function harness(options: Options = {}): Promise<Harness> {
  const accounts = new AccountStore(undefined, () => NOW_MS);
  const identities = createEphemeralAccountIdentities();
  const warnings: string[] = [];
  const signIn = new FederatedSignIn({
    accounts,
    identities,
    now: () => NOW_MS,
    warn: (m) => warnings.push(m),
  });

  const googleFetch = (async () =>
    new Response(
      JSON.stringify({
        keys: [
          {
            ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
            kid: 'key-1',
            use: 'sig',
            alg: 'RS256',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

  const kcFetch = (async (url: string | URL) => {
    const target = String(url);
    if (target.endsWith('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'kc-access' }), {
        status: options.kcTokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify(
        options.kcProfile ?? {
          profile: {
            id: 'kc-user-1',
            name: 'Zoe Meak',
            username: 'meakzoe',
            email: 'zoe@example.com',
            is_email_verified: true,
          },
        },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const providers: FederatedProviders = {
    google:
      options.googleOn === false
        ? null
        : new GoogleIdTokenVerifier({
            audiences: [AUDIENCE],
            jwksUrl: 'https://keys.test/certs',
            now: () => NOW_MS,
            fetchImpl: googleFetch,
          }),
    kingschat:
      options.kingschatOn === false
        ? null
        : new Map([
            [
              'web' as const,
              new KingsChatIdentity({
                clientId: KC_CLIENT,
                apiKey: 'project-key',
                baseUrl: 'https://connect.test',
                fetchImpl: kcFetch,
                warn: (m) => warnings.push(m),
              }),
            ],
          ]),
  };

  let serial = 0;
  const state = new OAuthStateStore({ now: () => NOW_MS, newToken: () => `state-${++serial}` });
  const handoffs = new SignInHandoffStore({
    now: () => NOW_MS,
    newToken: () => `handoff-${++serial}`,
  });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerFederatedRoutes(app, {
    store: accounts,
    signIn,
    providers,
    secret: randomBytes(32),
    publicOrigin: ORIGIN,
    state,
    handoffs,
    nowSeconds: () => Math.floor(NOW_MS / 1000),
    warn: (m) => warnings.push(m),
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    accounts,
    state,
    handoffs,
    warnings,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function postJson(url: string, path: string, body: unknown) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postForm(url: string, path: string, fields: Record<string, string>) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('which providers exist', () => {
  it('reports what this deployment actually has', async () => {
    app = await harness({ kingschatOn: false });
    const body = await (await fetch(`${app.url}/oauth/providers`)).json();
    // The page asks rather than hard-coding buttons: a button for a provider
    // that is off answers 503, and the person cannot tell that from their
    // own account being rejected.
    expect(body).toEqual({ google: true, kingschat: false });
  });
});

describe('google', () => {
  it('creates an account and returns a session', async () => {
    app = await harness();
    const response = await postJson(app.url, '/oauth/google', { idToken: googleToken() });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { accountId: string; token: string };
    expect(body.accountId).toMatch(/^acct_/);
    expect(body.token.length).toBeGreaterThan(0);
    expect(app.accounts.findByEmail('zoe@example.com')).not.toBeNull();
  });

  it('returns 200 rather than 201 the second time', async () => {
    app = await harness();
    await postJson(app.url, '/oauth/google', { idToken: googleToken() });
    const again = await postJson(app.url, '/oauth/google', { idToken: googleToken() });
    expect(again.status).toBe(200);
  });

  it('issues a device session when the app asks for one', async () => {
    app = await harness();
    const browser = await postJson(app.url, '/oauth/google', { idToken: googleToken() });
    const browserBody = (await browser.json()) as { expiresInSeconds: number };

    const device = await postJson(app.url, '/oauth/google', {
      idToken: googleToken({ sub: 'google-sub-2', email: 'ada@example.com' }),
      client: 'device',
    });
    const deviceBody = (await device.json()) as { expiresInSeconds: number };
    // A phone stays signed in until sign-out; a browser does not.
    expect(deviceBody.expiresInSeconds).toBeGreaterThan(browserBody.expiresInSeconds);
  });

  it('refuses a token for another app with one unhelpful message', async () => {
    app = await harness();
    const response = await postJson(app.url, '/oauth/google', {
      idToken: googleToken({ aud: 'someone-elses-app.apps.googleusercontent.com' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    // Which check failed is not said: that would be a map of what to forge.
    expect(body.error).not.toMatch(/audience|signature|issuer/i);
  });

  it('answers 503, not 401, when Google is off', async () => {
    app = await harness({ googleOn: false });
    const response = await postJson(app.url, '/oauth/google', { idToken: googleToken() });
    expect(response.status).toBe(503);
  });

  it('refuses a request with no token at all', async () => {
    app = await harness();
    expect((await postJson(app.url, '/oauth/google', {})).status).toBe(400);
    expect((await postJson(app.url, '/oauth/google', { idToken: 123 })).status).toBe(400);
  });
});

describe('kingschat', () => {
  it('hands back a login url carrying the client id and a fresh csrf token', async () => {
    app = await harness();
    const body = (await (
      await fetch(`${app.url}/oauth/kingschat/start?returnPath=/dashboard`)
    ).json()) as { authorizationUrl: string };

    const url = new URL(body.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.kingschat.online/log-in');
    expect(url.searchParams.get('clientId')).toBe(KC_CLIENT);
    expect(url.searchParams.get('origin')).toBe('state-1');
  });

  it('completes a login and redirects with the handoff in the fragment', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start?returnPath=/dashboard`);

    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`${ORIGIN}/dashboard#c7_handoff=`)).toBe(true);
    // A fragment is never sent to a server, so it cannot reach an access log
    // or a Referer header on the way to the page that consumes it.
    expect(location).not.toContain('?');
  });

  it('never puts a session token in the redirect', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start`);
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    const location = response.headers.get('location') ?? '';
    const handoff = location.split('#c7_handoff=')[1] ?? '';

    // The handoff is worth one exchange within a minute. A session token here
    // would be a working credential sitting in browser history.
    const exchanged = await postJson(app.url, '/oauth/handoff', { handoff });
    expect(exchanged.status).toBe(200);
    const body = (await exchanged.json()) as { token: string };
    expect(location).not.toContain(body.token);
  });

  it('refuses a callback whose csrf token it never issued', async () => {
    app = await harness();
    // The login-CSRF attack: an attacker's code delivered by a victim's
    // browser would sign the victim in as the attacker.
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'not-a-token-we-issued',
    });
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
  });

  it('refuses the portal test callback, which is the check working', async () => {
    app = await harness();
    // "Test Redirect URL" sends this literal value and carries no cookies.
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'kingschat-redirect-url-test',
    });
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
  });

  it('will not let one csrf token be spent twice', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start`);
    const first = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-1',
      origin: 'state-1',
    });
    expect(first.headers.get('location')).toContain('#c7_handoff=');

    const replay = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-2',
      origin: 'state-1',
    });
    expect(replay.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
  });

  it('refuses to be bounced off our own domain', async () => {
    app = await harness();
    await fetch(
      `${app.url}/oauth/kingschat/start?returnPath=${encodeURIComponent('https://evil.test/x')}`,
    );
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    const location = response.headers.get('location') ?? '';
    // An open redirect here puts a stranger's page behind our domain for
    // somebody who has just signed in and is in the mood to trust us.
    expect(location.startsWith(`${ORIGIN}/#c7_handoff=`)).toBe(true);
    expect(location).not.toContain('evil.test');
  });

  it('separates our misconfiguration from their expired code', async () => {
    app = await harness({ kcTokenStatus: 403 });
    await fetch(`${app.url}/oauth/kingschat/start`);
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    // Unapproved client: retrying will never help, so it must not say
    // "expired", which is an instruction to try again.
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=unavailable`);
    expect(app.warnings.join(' ')).toMatch(/client id/i);
  });

  it('redirects rather than answering JSON when the provider is off', async () => {
    app = await harness({ kingschatOn: false });
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'c',
      origin: 'o',
    });
    // The person's browser is navigating here, so whatever this returns is
    // what they look at. JSON would be a wall of text.
    expect(response.status).toBe(302);
    expect((await fetch(`${app.url}/oauth/kingschat/start`)).status).toBe(503);
  });
});

describe('a phone running the web flow', () => {
  it('comes back through the app scheme instead of a page', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start?client=device`);

    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    const location = response.headers.get('location') ?? '';
    // KingsChat's callback url is fixed per application, so the phone cannot
    // be given its own. It does not need one: the same registered callback
    // receives the code, and only the recorded surface decides where the
    // browser goes next.
    expect(location.startsWith('videofy://auth#c7_handoff=')).toBe(true);
  });

  it('sends a failure back into the app too, rather than stranding it in a browser', async () => {
    app = await harness({ kcTokenStatus: 403 });
    await fetch(`${app.url}/oauth/kingschat/start?client=device`);
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    // Without this the person is left looking at our website inside a system
    // browser with no way back to the app they started in.
    expect(response.headers.get('location')).toBe('videofy://auth?error=unavailable');
  });

  it('takes the surface from the attempt, never from the callback', async () => {
    app = await harness();
    // Started as web...
    await fetch(`${app.url}/oauth/kingschat/start`);
    // ...and the callback cannot talk its way into the app scheme, because
    // a caller that could name its own destination at callback time would be
    // an open redirect with a completed login attached.
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
      client: 'device',
    });
    expect(response.headers.get('location')?.startsWith(ORIGIN)).toBe(true);
  });

  it('refuses an unknown token to the web, not to the app scheme', async () => {
    app = await harness();
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'c',
      origin: 'never-issued',
    });
    // Nothing says a phone started it, and guessing the app scheme from a
    // value we could not verify is the trust this design exists to avoid.
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
  });
});

describe('handoff', () => {
  it('is worth exactly one exchange', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start`);
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    const handoff = (response.headers.get('location') ?? '').split('#c7_handoff=')[1] ?? '';

    expect((await postJson(app.url, '/oauth/handoff', { handoff })).status).toBe(200);
    expect((await postJson(app.url, '/oauth/handoff', { handoff })).status).toBe(401);
  });

  it('refuses a handoff nobody issued', async () => {
    app = await harness();
    expect((await postJson(app.url, '/oauth/handoff', { handoff: 'made-up' })).status).toBe(401);
    expect((await postJson(app.url, '/oauth/handoff', {})).status).toBe(401);
  });

  it('is void once the account has signed out everywhere', async () => {
    app = await harness();
    await fetch(`${app.url}/oauth/kingschat/start`);
    const response = await postForm(app.url, '/oauth/kingschat/callback', {
      code: 'code-xyz',
      origin: 'state-1',
    });
    const handoff = (response.headers.get('location') ?? '').split('#c7_handoff=')[1] ?? '';

    const account = app.accounts.findByEmail('zoe@example.com');
    await app.accounts.signOutEverywhere(account?.accountId ?? '');

    // Somebody who believes they are compromised presses sign out everywhere.
    // A handoff minted a moment earlier must not then mint a live session.
    expect((await postJson(app.url, '/oauth/handoff', { handoff })).status).toBe(401);
  });
});
