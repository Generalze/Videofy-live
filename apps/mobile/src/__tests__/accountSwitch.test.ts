/**
 * One phone, two people, in sequence.
 *
 * THE PRIVACY CASE, not a push-notification bug. A phone is sold, lent or
 * handed on; one account signs out and another signs in. FCM hands the app the
 * SAME token, because the token names the install rather than the person. If
 * anything in that sequence leaves the old binding in place, the previous
 * owner's calls and message previews arrive on a stranger's lock screen, and
 * nothing anywhere reports it.
 *
 * The server side of this is settled and tested in `device-store.test.ts`:
 * registering a token reassigns it, and the losing row is deleted. What is
 * tested HERE is the client half -- that sign-out actually ends the session, that
 * a rotation arriving afterwards cannot re-register against it, and that the
 * second account's registration goes out under the second account's session.
 */
import { describe, expect, it } from 'vitest';
import { AuthSessionManager } from '../auth/authSessionManager';
import { createSecureSessionStore } from '../auth/secureSessionStore';
import { DeviceRegistrationService } from '../push/deviceRegistrationService';
import { createDeviceIdentity } from '../push/deviceIdentity';
import type { PushTokenService } from '../push/pushTokenService';

const BASE = 'https://staging.example/auth';
/** The same physical install, so the same token for both people. */
const SHARED_TOKEN = 't'.repeat(142);

interface Sent {
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

function harness() {
  let stored: string | null = null;
  const sent: Sent[] = [];
  let deviceStored: string | null = null;
  let rotationListener: ((token: string) => void) | null = null;

  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as RequestInit;
    const path = String(url).replace(BASE, '');
    const headers = new Headers(request.headers ?? {});

    if (path === '/sessions' && request.method === 'POST') {
      const body = JSON.parse(String(request.body)) as { email: string };
      const accountId = body.email.startsWith('a') ? 'acct_a' : 'acct_b';
      return new Response(
        JSON.stringify({ accountId, token: `token-${accountId}`, expiresInSeconds: 43_200 }),
        { status: 200 },
      );
    }
    if (path === '/sessions' && request.method === 'DELETE') return new Response('', { status: 204 });
    if (path === '/sessions/current') return new Response('{}', { status: 200 });

    sent.push({
      path,
      authorization: headers.get('authorization'),
      body: request.body === undefined ? null : (JSON.parse(String(request.body)) as Record<string, unknown>),
    });
    return new Response('{}', { status: 201 });
  }) as unknown as typeof fetch;

  const auth = new AuthSessionManager({
    accountBaseUrl: BASE,
    store: createSecureSessionStore({
      async getItemAsync() {
        return stored;
      },
      async setItemAsync(_k: string, v: string) {
        stored = v;
      },
      async deleteItemAsync() {
        stored = null;
      },
    }),
    fetchImpl,
  });

  const pushTokens: PushTokenService = {
    async acquire() {
      return { ok: true, token: SHARED_TOKEN };
    },
    onRotation(listener) {
      rotationListener = listener;
      return () => {
        rotationListener = null;
      };
    },
  };

  const devices = new DeviceRegistrationService({
    authorizedFetch: (path, init) => auth.authorizedFetch(path, init),
    identity: createDeviceIdentity(
      {
        async getItemAsync() {
          return deviceStored;
        },
        async setItemAsync(_k: string, v: string) {
          deviceStored = v;
        },
      },
      () => 'dev_this_phone',
    ),
    pushTokens,
    platform: 'android',
  });

  return {
    auth,
    devices,
    sent,
    rotate: (token: string) => rotationListener?.(token),
    get sessionStored() {
      return stored;
    },
  };
}

describe('account A, then account B, on one phone', () => {
  it('registers the same device under whichever account is signed in', async () => {
    const h = harness();

    await h.auth.signIn('a@example.com', 'pw');
    await h.devices.register();

    await h.auth.signOut();

    await h.auth.signIn('b@example.com', 'pw');
    await h.devices.register();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.authorization).toBe('Bearer token-acct_a');
    expect(h.sent[1]?.authorization).toBe('Bearer token-acct_b');

    /*
     * THE SAME device id and the SAME token both times. That is what lets the
     * server move the binding rather than accumulate two rows -- the mechanism
     * that stops the first account being reachable on this phone.
     */
    expect(h.sent[0]?.body?.['deviceId']).toBe(h.sent[1]?.body?.['deviceId']);
    expect(h.sent[0]?.body?.['pushToken']).toBe(h.sent[1]?.body?.['pushToken']);
  });

  it('leaves no credential behind between the two', async () => {
    const h = harness();

    await h.auth.signIn('a@example.com', 'pw');
    await h.auth.signOut();

    expect(h.sessionStored).toBeNull();
    expect(h.auth.current().status).toBe('signed-out');
    // With no session, a registration cannot go out at all.
    expect((await h.devices.register()).ok).toBe(false);
  });

  /*
   * A rotation arriving after sign-out must not re-register the phone against
   * the account that just left. Stopping the listener is what guarantees it;
   * without that, the only thing preventing it is the session being gone --
   * true today, and not something to rely on.
   */
  it('does not re-register for the departed account when a token rotates', async () => {
    const h = harness();

    await h.auth.signIn('a@example.com', 'pw');
    await h.devices.register();
    h.devices.startWatchingForRotation();

    await h.auth.signOut();
    h.devices.stopWatchingForRotation();

    h.rotate('n'.repeat(142));
    await new Promise((r) => setTimeout(r, 5));

    // Only the original registration. Nothing went out for acct_a afterwards.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.authorization).toBe('Bearer token-acct_a');
  });

  /* Belt and braces: even a listener left running cannot register signed-out. */
  it('cannot register after sign-out even if rotation was never stopped', async () => {
    const h = harness();

    await h.auth.signIn('a@example.com', 'pw');
    h.devices.startWatchingForRotation();
    await h.auth.signOut();

    h.rotate('n'.repeat(142));
    await new Promise((r) => setTimeout(r, 5));

    expect(h.sent).toHaveLength(0);
  });
});
