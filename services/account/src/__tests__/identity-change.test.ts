/**
 * Changing a verified email or phone number, over HTTP.
 *
 * WHY THIS IS THE MOST DANGEROUS ROUTE IN THE SERVICE. A verified address is
 * not a display preference -- it is where password reset is sent. Treated as an
 * ordinary field update, an attacker holding a live session and nothing else
 * could point recovery at an address they control and own the account
 * permanently.
 *
 * So what is tested here is the ORDER, because the order is the whole security
 * property: step up, then prove the NEW address, then replace, then warn the
 * OLD one. Every test below fails if a step moves.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import {
  totpCodeAt,
  type IdentityChangeNotice,
  type VerificationDeliveryProvider,
  type VerificationMessage,
} from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { IdentityChangeService } from '../identity-change-service.js';
import { MfaService, readMfaKeyring } from '../mfa-service.js';
import { registerAccountRoutes } from '../routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const EMAIL = 'zoe@example.com';
const NEXT_EMAIL = 'zoe@consummate7.com';
const PASSWORD = 'correct horse battery staple';
const KEYRING_CONFIG = `k1:${'a'.repeat(64)}:current`;
const PEPPER = 'a-recovery-pepper-of-sufficient-length-here';

interface Harness {
  url: string;
  store: AccountStore;
  clock: { now: number };
  /** Tokens delivered to a NEW address. */
  sent: VerificationMessage[];
  /** Warnings delivered to an OLD address. */
  notices: IdentityChangeNotice[];
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const clock = { now: 1_700_000_000_000 };
  const store = new AccountStore(undefined, () => clock.now);
  const keyring = readMfaKeyring(KEYRING_CONFIG);
  if (!keyring) throw new Error('keyring did not parse');

  const sent: VerificationMessage[] = [];
  const notices: IdentityChangeNotice[] = [];
  /*
   * Captures instead of delivering, so a test can present the token a real
   * recipient would read -- without any endpoint ever returning one.
   */
  const provider = (): VerificationDeliveryProvider => ({
    name: 'capture',
    synthetic: true,
    async send(message) {
      sent.push(message);
      return { delivered: true, reference: 'test', synthetic: true };
    },
    async notify(notice) {
      notices.push(notice);
      return { delivered: true, reference: 'test', synthetic: true };
    },
  });

  const mfa = new MfaService({ store, keyring, recoveryPepper: PEPPER, nowMs: () => clock.now });
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, {
    store,
    secret: SECRET,
    nowMs: () => clock.now,
    mfa,
    identityChange: new IdentityChangeService({
      store,
      emailProvider: provider(),
      phoneProvider: provider(),
      mfa,
      nowMs: () => clock.now,
    }),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    clock,
    sent,
    notices,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let app: Harness;
beforeEach(async () => {
  app = await harness();
});
afterEach(async () => {
  await app.close();
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  return fetch(`${app.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registered(email = EMAIL): Promise<{ token: string; accountId: string }> {
  // Registration requires a handle now, derived here so each account is distinct.
  const handle = `u${email.split('@')[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase() ?? 'user'}`;
  const response = await call('POST', '/accounts', { email, password: PASSWORD, username: handle });
  return (await response.json()) as { token: string; accountId: string };
}

/** An account with a second factor enrolled and a fresh step-up satisfied. */
async function steppedUp(): Promise<{ token: string; accountId: string; secret: string }> {
  const account = await registered();
  const enrol = await call('POST', '/accounts/mfa', {}, account.token);
  const { otpauthUri } = (await enrol.json()) as { otpauthUri: string };
  const secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!;

  await call('POST', '/accounts/mfa/confirm', { code: totpCodeAt(secret, app.clock.now) }, account.token);
  await call('POST', '/accounts/step-up', { code: totpCodeAt(secret, app.clock.now) }, account.token);
  return { ...account, secret };
}

describe('starting a change', () => {
  /*
   * THE DEFECT THIS CLOSES. Without step-up, a stolen session alone could aim
   * password recovery at an attacker's address. The refusal must happen BEFORE
   * anything is sent, so the attacker cannot even cause a message to be
   * delivered to an address they chose.
   */
  it('refuses without a fresh step-up, and sends nothing', async () => {
    const account = await registered();

    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: NEXT_EMAIL },
      account.token,
    );

    expect(response.status).toBe(403);
    expect(app.sent).toEqual([]);
  });

  it('accepts once a second factor has been satisfied', async () => {
    const account = await steppedUp();

    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: NEXT_EMAIL },
      account.token,
    );

    expect(response.status).toBe(202);
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.target).toBe(NEXT_EMAIL);
  });

  /* Returning the token would let a stolen session finish without reading it. */
  it('never returns the token it sent', async () => {
    const account = await steppedUp();
    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: NEXT_EMAIL },
      account.token,
    );

    expect(JSON.stringify(await response.json())).not.toContain(app.sent[0]!.token);
  });

  /*
   * THE OLD ADDRESS STAYS AUTHORITATIVE. Replacing before proving is the
   * common mistake: it locks somebody out the moment they mistype, and hands
   * an attacker the change even when the confirmation is never opened.
   */
  it('does not change the address until the new one is proven', async () => {
    const account = await steppedUp();
    await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: NEXT_EMAIL },
      account.token,
    );

    expect(app.store.get(account.accountId)?.email).toBe(EMAIL);
  });

  it('refuses an address that is not an address', async () => {
    const account = await steppedUp();
    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: 'not-an-address' },
      account.token,
    );
    expect(response.status).toBe(400);
    expect(app.sent).toEqual([]);
  });

  it('refuses a change to the address already held', async () => {
    const account = await steppedUp();
    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: EMAIL },
      account.token,
    );
    expect(response.status).toBe(409);
    expect(app.sent).toEqual([]);
  });

  /*
   * ONE ANSWER for an unusable address and for one belonging to somebody else.
   * Two answers would turn this into a way to ask whether a given person has
   * an account.
   */
  it('does not reveal that an address belongs to another account', async () => {
    await registered('someone-else@example.com');
    const account = await steppedUp();

    const taken = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: 'someone-else@example.com' },
      account.token,
    );
    const malformed = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: 'not-an-address' },
      account.token,
    );

    expect(taken.status).toBe(malformed.status);
    expect(await taken.json()).toEqual(await malformed.json());
    expect(app.sent).toEqual([]);
  });

  it('requires signing in', async () => {
    const response = await call('POST', '/accounts/identity-change', {
      channel: 'email',
      target: NEXT_EMAIL,
    });
    expect(response.status).toBe(401);
  });
});

describe('confirming a change', () => {
  async function started(): Promise<{ token: string; accountId: string; sentToken: string }> {
    const account = await steppedUp();
    await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'email', target: NEXT_EMAIL },
      account.token,
    );
    return { ...account, sentToken: app.sent[0]!.token };
  }

  it('applies the change when the token from the new address is presented', async () => {
    const account = await started();

    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(response.status).toBe(200);
    expect(app.store.get(account.accountId)?.email).toBe(NEXT_EMAIL);
  });

  /*
   * WARNING THE OLD ADDRESS is what makes a silent takeover loud. It is the
   * only message in this flow that reaches somebody who has NOT been
   * compromised.
   */
  it('warns the address it replaced', async () => {
    const account = await started();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(app.notices).toHaveLength(1);
    expect(app.notices[0]?.target).toBe(EMAIL);
  });

  /* The warning must not hand the attacker's address to the victim. */
  it('does not name the new address in the warning', async () => {
    const account = await started();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(JSON.stringify(app.notices[0])).not.toContain(NEXT_EMAIL);
  });

  /*
   * A changed email moves the recovery path, so every session ends. If this
   * was an attacker, the change is exactly when to end their access rather
   * than the moment to leave it running.
   */
  it('revokes existing sessions', async () => {
    const account = await started();
    const before = app.store.get(account.accountId)!.tokenVersion;

    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect((await response.json()) as { sessionsRevoked: boolean }).toMatchObject({
      sessionsRevoked: true,
    });
    expect(app.store.get(account.accountId)!.tokenVersion).toBe(before + 1);
  });

  it('leaves the old session unable to act afterwards', async () => {
    const account = await started();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    const after = await call('GET', '/me', undefined, account.token);
    expect(after.status).toBe(401);
  });

  it('refuses a token that was never issued', async () => {
    const account = await started();
    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: 'not-the-token' },
      account.token,
    );

    expect(response.status).toBe(400);
    expect(app.store.get(account.accountId)?.email).toBe(EMAIL);
  });

  /*
   * REFUSED AT THE DOOR, which is stronger than the single-use check behind it.
   * The first confirmation revoked every session, so the replay is rejected as
   * unauthenticated and never reaches the handler at all. Asserted as 401
   * rather than 409 because that is what actually happens -- and it is the
   * better outcome. The single-use property itself is pinned on the phone
   * channel below, where sessions survive and the replay can get that far.
   */
  it('cannot be replayed, because the session that made it is gone', async () => {
    const account = await started();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    const replay = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );
    expect(replay.status).toBe(401);
    expect(app.store.get(account.accountId)?.email).toBe(NEXT_EMAIL);
  });

  it('refuses when nothing is waiting to be confirmed', async () => {
    const account = await steppedUp();
    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: 'anything' },
      account.token,
    );
    expect(response.status).toBe(409);
  });

  /*
   * The step-up grant paid for THIS change. Left in place, one
   * re-authentication would buy a window of sensitive operations rather than
   * one operation.
   */
  it('consumes the step-up grant', async () => {
    const account = await started();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(app.store.get(account.accountId)?.stepUpAtMs ?? null).toBeNull();
  });
});

describe('changing a phone number', () => {
  const NUMBER = '+2348012345678';

  async function startedPhone(): Promise<{ token: string; accountId: string; sentToken: string }> {
    const account = await steppedUp();
    await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'phone', target: NUMBER },
      account.token,
    );
    return { ...account, sentToken: app.sent[0]!.token };
  }

  it('applies the number once the code is presented', async () => {
    const account = await startedPhone();
    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(response.status).toBe(200);
    expect(app.store.get(account.accountId)?.phoneNumber).toBe(NUMBER);
  });

  /*
   * A phone change is serious but does not by itself move password reset, so
   * sessions survive it. That is the difference from an email change, and it
   * is what lets the single-use check below be reached at all.
   */
  it('does not revoke sessions', async () => {
    const account = await startedPhone();
    const before = app.store.get(account.accountId)!.tokenVersion;

    const response = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect((await response.json()) as { sessionsRevoked: boolean }).toMatchObject({
      sessionsRevoked: false,
    });
    expect(app.store.get(account.accountId)!.tokenVersion).toBe(before);
  });

  /* SINGLE USE: the pending change is cleared the moment it is applied. */
  it('cannot be confirmed twice', async () => {
    const account = await startedPhone();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    const replay = await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );
    expect(replay.status).toBe(409);
  });

  /* Nothing was verified before, so there is nobody to warn. */
  it('sends no warning when there was no previous number', async () => {
    const account = await startedPhone();
    await call(
      'POST',
      '/accounts/identity-change/confirm',
      { token: account.sentToken },
      account.token,
    );

    expect(app.notices).toEqual([]);
  });

  it('refuses a number that is not dialable', async () => {
    const account = await steppedUp();
    const response = await call(
      'POST',
      '/accounts/identity-change',
      { channel: 'phone', target: '0801234' },
      account.token,
    );
    expect(response.status).toBe(400);
    expect(app.sent).toEqual([]);
  });
});
