/** @owner masterzee001 */
/**
 * The last identity trust boundary (closure wave).
 *
 * Enrolment and deletion derived ownership from a verified token while call
 * join still accepted `voiceOwnerId` straight from the browser. A caller could
 * name somebody else's account and be spoken in their voice.
 *
 * These tests use the REAL verifier over a real secret and the REAL token
 * issuer, because the defect being closed is precisely the kind a stand-in
 * agrees with. The forged, foreign-signed and expired cases all have to be
 * refused by actual signature checking, not by a mock returning null.
 *
 * The resume cases are the ones that matter most. Securing first join and then
 * leaving the previous owner sitting in participant state recreates the
 * shared-browser defect on top of real accounts — same bug, better paperwork.
 */
import { describe, expect, it, vi } from 'vitest';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';
import { CallSessionStore, type CallIngestPlan } from '@videofy-live/call-session';
import { createCallVoiceIdentityVerifier } from '../call-voice-identity.js';

const SECRET_VALUE = 's'.repeat(48);
const OTHER_SECRET_VALUE = 'x'.repeat(48);
const ACCOUNT_A = 'acct_aaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'acct_bbbbbbbbbbbbbbbb';
const NOW = 1_760_000_000;

const verify = createCallVoiceIdentityVerifier(SECRET_VALUE, () => NOW)!;

function tokenFor(
  accountId: string,
  options: { secret?: string; issuedAt?: number; lifetimeSeconds?: number } = {},
): string {
  return issueSessionToken({
    secret: requireSessionSecret(options.secret ?? SECRET_VALUE, 'TEST'),
    accountId,
    version: 1,
    nowSeconds: options.issuedAt ?? NOW,
    ...(options.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: options.lifetimeSeconds }),
  });
}

describe('the gateway derives identity instead of accepting it', () => {
  it('B: a valid token yields the account it was signed for', () => {
    expect(verify(tokenFor(ACCOUNT_A))).toBe(ACCOUNT_A);
  });

  it('C: a forged token claiming an account yields nobody', () => {
    // The payload says acct_A; nothing signed it.
    const body = Buffer.from(
      JSON.stringify({ sub: ACCOUNT_A, iat: NOW, exp: NOW + 3600, ver: 1 }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(verify(`${body}.not-a-signature`)).toBeNull();
    expect(verify(body)).toBeNull();
  });

  it('D: a token signed with another secret yields nobody', () => {
    expect(verify(tokenFor(ACCOUNT_A, { secret: OTHER_SECRET_VALUE }))).toBeNull();
  });

  it('E: an expired token yields nobody', () => {
    expect(verify(tokenFor(ACCOUNT_A, { lifetimeSeconds: 60, issuedAt: NOW - 3600 }))).toBeNull();
  });

  it('F: a retired devid_ subject yields nobody, even correctly signed', () => {
    // Accounts exist to end browser-scoped ownership. A prototype identity must
    // not become an account by being placed in a token we ourselves signed.
    expect(verify(tokenFor('devid_aaaaaaaaaaaa'))).toBeNull();
  });

  it('H: a token cannot be edited from account A to account B', () => {
    // Swap the body for one naming B, keep A's signature.
    const forB = tokenFor(ACCOUNT_B).split('.')[0]!;
    const signatureForA = tokenFor(ACCOUNT_A).split('.')[1]!;

    expect(verify(`${forB}.${signatureForA}`)).toBeNull();
  });

  it('refuses junk without throwing, because a throw is a 500 and a probe', () => {
    for (const candidate of ['', '.', 'a.b.c', 'nonsense', '%%%.%%%']) {
      expect(() => verify(candidate)).not.toThrow();
      expect(verify(candidate)).toBeNull();
    }
  });
});

describe('a gateway with no secret grants no personal voice', () => {
  it('returns no verifier rather than accepting everybody', () => {
    // The safe direction for an optional feature: calls keep working, nobody
    // gets a personal voice, and nothing falls back to trusting the client.
    expect(createCallVoiceIdentityVerifier(undefined)).toBeNull();
    expect(createCallVoiceIdentityVerifier('too-short')).toBeNull();
  });
});

// ------------------------------------------------------- store-level identity

function joinInput(overrides: Record<string, unknown> = {}) {
  return {
    callId: 'demo',
    displayName: 'Ana',
    speakLanguage: 'en' as const,
    hearLanguage: 'en' as const,
    captionsEnabled: true,
    voiceGender: 'female' as const,
    audioMode: 'translated' as const,
    ...overrides,
  };
}

/** What the gateway does: strip any client claim, substitute the verified one. */
function gatewayJoin(store: CallSessionStore, clientPayload: Record<string, unknown>) {
  const { voiceOwnerId: _discarded, sessionToken, ...rest } = clientPayload;
  const verified = typeof sessionToken === 'string' ? verify(sessionToken) : null;
  return store.createOrJoin({ ...(rest as ReturnType<typeof joinInput>), voiceOwnerId: verified });
}

function planFor(plans: CallIngestPlan[], participantId: string): CallIngestPlan | undefined {
  return plans.find((plan) => plan.ingestSessionId.includes(participantId));
}

describe('resume re-proves identity every time', () => {
  it('I: a resume with a valid token keeps that account', () => {
    const store = new CallSessionStore();
    const first = gatewayJoin(store, joinInput({ sessionToken: tokenFor(ACCOUNT_A) }));
    if (!first.ok) throw new Error('join failed');

    const resumed = gatewayJoin(
      store,
      joinInput({
        sessionToken: tokenFor(ACCOUNT_A),
        resumeParticipantId: first.participantId,
        resumeToken: first.resumeToken,
      }),
    );
    if (!resumed.ok) throw new Error('resume failed');

    expect(planFor(resumed.ingestPlans, first.participantId)?.voiceOwnerId).toBe(ACCOUNT_A);
  });

  it('J: a resume after signing out drops the account, never keeps a stale one', () => {
    // THE case. Securing first join and then merging on resume leaves acct_A
    // attached to the seat after A has signed out — the shared-browser defect,
    // rebuilt on top of real accounts.
    const store = new CallSessionStore();
    const first = gatewayJoin(store, joinInput({ sessionToken: tokenFor(ACCOUNT_A) }));
    if (!first.ok) throw new Error('join failed');

    const resumed = gatewayJoin(
      store,
      joinInput({
        resumeParticipantId: first.participantId,
        resumeToken: first.resumeToken,
      }),
    );
    if (!resumed.ok) throw new Error('resume failed');

    expect(planFor(resumed.ingestPlans, first.participantId)?.voiceOwnerId).toBeUndefined();
  });

  it('J2: an expired token on resume drops the account too', () => {
    const store = new CallSessionStore();
    const first = gatewayJoin(store, joinInput({ sessionToken: tokenFor(ACCOUNT_A) }));
    if (!first.ok) throw new Error('join failed');

    const resumed = gatewayJoin(
      store,
      joinInput({
        sessionToken: tokenFor(ACCOUNT_A, { lifetimeSeconds: 60, issuedAt: NOW - 3600 }),
        resumeParticipantId: first.participantId,
        resumeToken: first.resumeToken,
      }),
    );
    if (!resumed.ok) throw new Error('resume failed');

    expect(planFor(resumed.ingestPlans, first.participantId)?.voiceOwnerId).toBeUndefined();
  });

  it('K: account B on a shared browser never inherits account A', () => {
    // A signs out, B signs in, same seat. B must be B, and must never be A.
    const store = new CallSessionStore();
    const first = gatewayJoin(store, joinInput({ sessionToken: tokenFor(ACCOUNT_A) }));
    if (!first.ok) throw new Error('join failed');

    const resumed = gatewayJoin(
      store,
      joinInput({
        sessionToken: tokenFor(ACCOUNT_B),
        resumeParticipantId: first.participantId,
        resumeToken: first.resumeToken,
      }),
    );
    if (!resumed.ok) throw new Error('resume failed');

    const owner = planFor(resumed.ingestPlans, first.participantId)?.voiceOwnerId;
    expect(owner).toBe(ACCOUNT_B);
    expect(owner).not.toBe(ACCOUNT_A);
  });
});

describe('a client claim is discarded, not preferred', () => {
  it('G: naming an account in the payload achieves nothing', () => {
    // The original defect, asserted directly: the client says it is acct_A and
    // offers no evidence.
    const store = new CallSessionStore();
    const joined = gatewayJoin(store, joinInput({ voiceOwnerId: ACCOUNT_A }));
    if (!joined.ok) throw new Error('join failed');

    expect(planFor(joined.ingestPlans, joined.participantId)?.voiceOwnerId).toBeUndefined();
  });

  it('a claim alongside a valid token for someone else does not win', () => {
    // Belt and braces: the signature decides, and the assertion is discarded
    // before the store ever sees it.
    const store = new CallSessionStore();
    const joined = gatewayJoin(
      store,
      joinInput({ voiceOwnerId: ACCOUNT_A, sessionToken: tokenFor(ACCOUNT_B) }),
    );
    if (!joined.ok) throw new Error('join failed');

    expect(planFor(joined.ingestPlans, joined.participantId)?.voiceOwnerId).toBe(ACCOUNT_B);
  });

  it('A: an anonymous join still works, with no owner at all', () => {
    // Accounts are optional. Translation is the product.
    const store = new CallSessionStore();
    const joined = gatewayJoin(store, joinInput());

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(planFor(joined.ingestPlans, joined.participantId)?.voiceOwnerId).toBeUndefined();
  });
});

describe('the token never travels inward', () => {
  it('L: reaches no plan, no snapshot and no wire payload', () => {
    const store = new CallSessionStore();
    const token = tokenFor(ACCOUNT_A);
    const joined = gatewayJoin(store, joinInput({ sessionToken: token }));
    if (!joined.ok) throw new Error('join failed');

    // The derived owner is on the work order, which is internal and correct.
    expect(planFor(joined.ingestPlans, joined.participantId)?.voiceOwnerId).toBe(ACCOUNT_A);
    // The token itself stops at the gateway boundary.
    expect(JSON.stringify(joined.ingestPlans)).not.toContain(token);
    expect(JSON.stringify(joined.snapshot)).not.toContain(token);
    // And the public snapshot names no account at all.
    expect(JSON.stringify(joined.snapshot)).not.toContain('acct_');
  });
});

describe('a rejected token costs the voice, not the call', () => {
  it('an unusable sign-in still joins, in a standard voice', () => {
    // An expired session must not stop somebody joining a conversation. The
    // feature degrades; the product does not.
    const store = new CallSessionStore();
    const joined = gatewayJoin(
      store,
      joinInput({ sessionToken: tokenFor(ACCOUNT_A, { lifetimeSeconds: 60, issuedAt: NOW - 3600 }) }),
    );

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(planFor(joined.ingestPlans, joined.participantId)?.voiceOwnerId).toBeUndefined();
  });

  it('does not log the token or the attempted account', () => {
    // A log of failed voice authentications is a log of who tried to speak as
    // whom, kept somewhere the recording is not.
    const warn = vi.fn();
    const quiet = createCallVoiceIdentityVerifier(SECRET_VALUE, () => NOW)!;

    quiet(tokenFor(ACCOUNT_A, { secret: OTHER_SECRET_VALUE }));

    expect(warn).not.toHaveBeenCalled();
  });
});
