/**
 * A0a — the email and phone verification FLOW.
 *
 * Exercises the service the routes call, with a provider that captures what
 * would have been delivered. The token never leaves that capture: if it ever
 * appeared in a response or a record, these tests would be the place it showed.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';
import { VerificationService, normalisePhone } from '../verification.js';
import {
  EMAIL_POLICY,
  PHONE_POLICY,
  createSyntheticProvider,
  createSyntheticIdentityProvider,
  type VerificationMessage,
} from '@videofy-live/account-trust';

async function harness() {
  const store = new AccountStore();
  const delivered: VerificationMessage[] = [];
  const provider = createSyntheticProvider('email', (message) => delivered.push(message));
  const phoneProvider = createSyntheticProvider('phone', (message) => delivered.push(message));

  let nowMs = 1_700_000_000_000;
  const verification = new VerificationService({
    store,
    emailProvider: provider,
    phoneProvider,
    nowMs: () => nowMs,
  });

  const registration = await store.register({
    email: 'zoe@example.com',
    password: 'a-long-enough-passphrase-42', username: 'u653b933e63' });
  if (!registration.ok) throw new Error('registration failed');

  return {
    store,
    verification,
    delivered,
    accountId: registration.account.accountId,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('email verification', () => {
  it('moves the account to pending, then verified', async () => {
    const { store, verification, delivered, accountId } = await harness();
    expect(store.trustStateOf(accountId)).toBe('registered');

    const requested = await verification.requestEmailVerification(accountId);
    expect(requested.ok).toBe(true);
    expect(store.trustStateOf(accountId)).toBe('verification_pending');
    expect(delivered).toHaveLength(1);

    const confirmed = await verification.confirmEmail(accountId, delivered[0]!.token);
    expect(confirmed.ok).toBe(true);
    expect(store.trustOf(accountId).email).toBe('verified');
    // Still not `verified` overall: phone and identity remain outstanding.
    expect(store.trustStateOf(accountId)).toBe('verification_required');
  });

  it('PIN: the plaintext token is never stored on the account', async () => {
    const { store, verification, delivered, accountId } = await harness();
    await verification.requestEmailVerification(accountId);
    const record = store.get(accountId);
    expect(JSON.stringify(record)).not.toContain(delivered[0]!.token);
    expect(record?.emailChallenge?.tokenHash).toBeTruthy();
  });

  it('PIN: a wrong token is COUNTED, and the count survives', async () => {
    const { store, verification, accountId } = await harness();
    await verification.requestEmailVerification(accountId);

    await verification.confirmEmail(accountId, 'not-the-token');
    expect(store.get(accountId)?.emailChallenge?.attempts).toBe(1);

    await verification.confirmEmail(accountId, 'still-not-the-token');
    expect(store.get(accountId)?.emailChallenge?.attempts).toBe(2);
  });

  it('PIN: a used link cannot be replayed', async () => {
    const { verification, delivered, accountId } = await harness();
    await verification.requestEmailVerification(accountId);
    const token = delivered[0]!.token;

    expect((await verification.confirmEmail(accountId, token)).ok).toBe(true);
    const replay = await verification.confirmEmail(accountId, token);
    expect(replay.ok).toBe(false);
  });

  it('PIN: an expired link is refused', async () => {
    const { verification, delivered, accountId, advance } = await harness();
    await verification.requestEmailVerification(accountId);
    advance(EMAIL_POLICY.ttlMs + 1);
    const late = await verification.confirmEmail(accountId, delivered[0]!.token);
    expect(late.ok).toBe(false);
  });

  it('throttles resend, then allows it', async () => {
    const { verification, accountId, advance } = await harness();
    await verification.requestEmailVerification(accountId);

    const tooSoon = await verification.requestEmailVerification(accountId);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.reason).toBe('throttled');

    advance(EMAIL_POLICY.resendCooldownMs);
    expect((await verification.requestEmailVerification(accountId)).ok).toBe(true);
  });

  it('refuses to re-verify an address that is already verified', async () => {
    const { verification, delivered, accountId, advance } = await harness();
    await verification.requestEmailVerification(accountId);
    await verification.confirmEmail(accountId, delivered[0]!.token);

    advance(EMAIL_POLICY.resendCooldownMs);
    const again = await verification.requestEmailVerification(accountId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already-verified');
  });
});

describe('phone verification', () => {
  it('normalises to E.164, and refuses anything that is not dialable', () => {
    expect(normalisePhone('+234 800 000 0000')).toBe('+2348000000000');
    expect(normalisePhone('+1 (555) 010-9999')).toBe('+15550109999');
    expect(normalisePhone('08000000000')).toBeNull();
    expect(normalisePhone('not a number')).toBeNull();
    expect(normalisePhone('+0123')).toBeNull();
  });

  it('verifies a code and records the number', async () => {
    const { store, verification, delivered, accountId } = await harness();
    const requested = await verification.requestPhoneVerification(accountId, '+2348000000000');
    expect(requested.ok).toBe(true);

    const code = delivered[0]!.token;
    expect(code).toMatch(/^\d{6}$/);

    const confirmed = await verification.confirmPhone(accountId, code);
    expect(confirmed.ok).toBe(true);
    expect(store.trustOf(accountId).phone).toBe('verified');
    expect(store.get(accountId)?.phoneNumber).toBe('+2348000000000');
  });

  it('PIN: guessing is bounded by the attempt cap', async () => {
    const { verification, accountId } = await harness();
    await verification.requestPhoneVerification(accountId, '+2348000000000');

    for (let attempt = 0; attempt < PHONE_POLICY.maxAttempts; attempt += 1) {
      expect((await verification.confirmPhone(accountId, '000000')).ok).toBe(false);
    }
    const blocked = await verification.confirmPhone(accountId, '000000');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('too-many-attempts');
  });

  it('refuses a number that is not in international format', async () => {
    const { verification, accountId } = await harness();
    const outcome = await verification.requestPhoneVerification(accountId, '08000000000');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid-target');
  });
});

describe('all three channels', async () => {
  it('reaches `verified` only when identity completes too', async () => {
    const { store, verification, delivered, accountId, advance } = await harness();

    await verification.requestEmailVerification(accountId);
    await verification.confirmEmail(accountId, delivered[0]!.token);
    advance(1000);
    await verification.requestPhoneVerification(accountId, '+2348000000000');
    await verification.confirmPhone(accountId, delivered[1]!.token);

    // Email and phone done; identity is what the KYC stage (A0b) completes.
    expect(store.trustStateOf(accountId)).toBe('verification_required');
    expect(verification.status(accountId)).toMatchObject({
      email: 'verified',
      phone: 'verified',
      identity: 'unverified',
    });
  });
});

/*
 * REGISTRATION MUST ACTUALLY SEND THE EMAIL.
 *
 * This is tested over HTTP rather than against the service, because the defect
 * it pins lived exactly at that boundary: registration created the account and
 * returned a session, the verification endpoint sat waiting to be called, and
 * nothing called it. Both halves passed their own tests. Somebody registering
 * on staging received nothing, and the account record showed no challenge had
 * ever been issued -- proof the provider was never even reached.
 */
describe('registering over HTTP', () => {
  async function routeHarness() {
    const store = new AccountStore();
    const delivered: VerificationMessage[] = [];
    const emailProvider = createSyntheticProvider('email', (message) => delivered.push(message));
    const phoneProvider = createSyntheticProvider('phone', (message) => delivered.push(message));

    const app = express();
    app.use(express.json());
    registerAccountRoutes(app, {
      store,
      secret: requireSessionSecret('z'.repeat(48), 'TEST_SECRET'),
      verification: new VerificationService({ store, emailProvider, phoneProvider }),
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${port}`,
      store,
      delivered,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it('sends a verification email when an account is created', async () => {
    const harnessed = await routeHarness();
    try {
      const response = await fetch(`${harnessed.url}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', password: 'a-long-enough-passphrase-42', username: 'uee49581776' }),
      });

      expect(response.status).toBe(201);
      // Delivery is fired without being awaited, so the assertion waits for it
      // rather than racing it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harnessed.delivered.map((message) => message.target)).toEqual(['new@example.com']);
    } finally {
      await harnessed.close();
    }
  });

  it('records the challenge against the account, so a confirmation can match it', async () => {
    const harnessed = await routeHarness();
    try {
      const response = await fetch(`${harnessed.url}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', password: 'a-long-enough-passphrase-42', username: 'ue3998f5a48' }),
      });
      const { accountId } = (await response.json()) as { accountId: string };
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harnessed.store.get(accountId)?.emailChallenge ?? null).not.toBeNull();
    } finally {
      await harnessed.close();
    }
  });

  /* The token belongs in the message and nowhere else. */
  it('does not return the token in the registration response', async () => {
    const harnessed = await routeHarness();
    try {
      const response = await fetch(`${harnessed.url}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', password: 'a-long-enough-passphrase-42', username: 'ub04f1cdf03' }),
      });
      const body = JSON.stringify(await response.json());
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(body).not.toContain(harnessed.delivered[0]!.token);
    } finally {
      await harnessed.close();
    }
  });

  /*
   * A delivery outage must not turn a successful registration into a failure.
   * The account exists and the session is valid; the resend endpoint is the
   * designed path back.
   */
  it('still creates the account when delivery fails', async () => {
    const store = new AccountStore();
    const failing = {
      name: 'failing',
      synthetic: true,
      async send() {
        return { delivered: false, reference: null, synthetic: true };
      },
      async notify() {
        return { delivered: false, reference: null, synthetic: true };
      },
    };
    const app = express();
    app.use(express.json());
    registerAccountRoutes(app, {
      store,
      secret: requireSessionSecret('z'.repeat(48), 'TEST_SECRET'),
      verification: new VerificationService({
        store,
        emailProvider: failing,
        phoneProvider: failing,
      }),
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', password: 'a-long-enough-passphrase-42', username: 'u8199765788' }),
      });
      expect(response.status).toBe(201);
      expect(store.findByEmail('new@example.com')).not.toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/*
 * A CHANNEL THAT CANNOT DELIVER MUST NOT REPORT A SEND.
 *
 * The synthetic provider reports every send as delivered, which is right for a
 * test double and a lie when somebody is waiting for a code. On staging that
 * produced a "Send code" button that answered "code sent" forever while no SMS
 * existed, and an identity check stuck "in progress" permanently because the
 * synthetic provider opens a case no callback will ever close.
 */
describe('honest deliverability', () => {
  it('reports a synthetic email channel as undeliverable', async () => {
    const harnessed = await harness();
    expect(harnessed.verification.deliverabilityOf('email')).toBe('synthetic');
  });

  it('reports a real provider as deliverable', async () => {
    const store = new AccountStore();
    const real = {
      name: 'real',
      synthetic: false,
      async send() {
        return { delivered: true, reference: 'x', synthetic: false };
      },
      async notify() {
        return { delivered: true, reference: 'x', synthetic: false };
      },
    };
    const verification = new VerificationService({
      store,
      emailProvider: real,
      phoneProvider: real,
    });
    expect(verification.deliverabilityOf('email')).toBe('real');
    expect(verification.deliverabilityOf('phone')).toBe('real');
  });

  /*
   * ABSENT and SYNTHETIC are different states and are reported differently: one
   * deployment never configured identity, another configured a stub. Both
   * refuse, and neither should open a case.
   */
  it('separates an absent identity provider from a synthetic one', async () => {
    const store = new AccountStore();
    const provider = createSyntheticProvider('email');
    const withoutIdentity = new VerificationService({
      store,
      emailProvider: provider,
      phoneProvider: provider,
    });
    expect(withoutIdentity.identityDeliverability()).toBe('absent');
  });
});

/*
 * AN ABANDONED IDENTITY CHECK MUST NOT STRAND THE ACCOUNT.
 *
 * "One open case at a time" refused forever: somebody who started a check and
 * closed the tab was locked out of identity verification permanently, and the
 * console told them a check was already in progress while offering nothing to
 * do about it. Zoe hit exactly this on staging. It is not a synthetic-provider
 * problem -- a real provider's abandoned session strands an account the same
 * way.
 */
describe('a stale identity check', () => {
  async function identityHarness() {
    const store = new AccountStore();
    let nowMs = 1_700_000_000_000;
    const provider = createSyntheticProvider('email');
    const verification = new VerificationService({
      store,
      emailProvider: provider,
      phoneProvider: provider,
      identityProvider: createSyntheticIdentityProvider(),
      nowMs: () => nowMs,
    });
    const registration = await store.register({
      email: 'kyc@example.com',
      password: 'a-long-enough-passphrase-42', username: 'u7039402b8f' });
    if (!registration.ok) throw new Error('registration failed');
    return {
      verification,
      accountId: registration.account.accountId,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('blocks a second check while the first is still live', async () => {
    const h = await identityHarness();
    expect((await h.verification.startIdentityVerification(h.accountId)).ok).toBe(true);

    const second = await h.verification.startIdentityVerification(h.accountId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('in-progress');
  });

  it('still blocks it most of a day later, so a real check is not interrupted', async () => {
    const h = await identityHarness();
    await h.verification.startIdentityVerification(h.accountId);
    h.advance(23 * 60 * 60 * 1000);

    const second = await h.verification.startIdentityVerification(h.accountId);
    expect(second.ok).toBe(false);
  });

  /* THE FIX: after a day, an unfinished check is abandoned, not sacred. */
  it('lets a new check supersede one that was never finished', async () => {
    const h = await identityHarness();
    await h.verification.startIdentityVerification(h.accountId);
    h.advance(25 * 60 * 60 * 1000);

    const second = await h.verification.startIdentityVerification(h.accountId);
    expect(second.ok).toBe(true);
  });

  /*
   * The superseded case must not be able to win a later race. Callbacks match
   * on providerReference, so a new check must carry a NEW one.
   */
  it('gives the superseding check its own provider reference', async () => {
    const h = await identityHarness();
    const first = await h.verification.startIdentityVerification(h.accountId);
    h.advance(25 * 60 * 60 * 1000);
    const second = await h.verification.startIdentityVerification(h.accountId);

    if (first.ok && second.ok) {
      expect(second.session.providerReference).not.toBe(first.session.providerReference);
    }
  });

  it('reports a synthetic identity provider as unable to conclude', async () => {
    const h = await identityHarness();
    expect(h.verification.identityDeliverability()).toBe('synthetic');
  });
});
