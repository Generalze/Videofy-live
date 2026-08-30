/** @author masterzee001 */
/**
 * Who may operate a programme.
 *
 * The operator role used to be claimed by a query parameter and nothing else,
 * so anybody who found the URL could start, stop, retarget and mute a live
 * programme going out to an audience. These tests exist so that cannot come
 * back quietly.
 */
import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';
import {
  OPERATOR_NOT_ENTITLED_MESSAGE,
  OPERATOR_SIGN_IN_MESSAGE,
  createOperatorAuthority,
  operatorRefusalNotice,
  type OperatorAdmission,
} from '../operator-authority.js';

const SECRET_VALUE = 'z'.repeat(48);
const SECRET = requireSessionSecret(SECRET_VALUE, 'TEST_SECRET');
const NOW_SECONDS = 1_700_000_000;
/**
 * A REAL-SHAPED account id: `acct_` and sixteen hex characters.
 *
 * `acct_operator` reads better and is refused by parseAccountId, which is the
 * token layer correctly declining a malformed subject. Worth noting rather than
 * working around: a fixture that does not look like production data tests a
 * path production never takes.
 */
const ACCOUNT = 'acct_a1b2c3d4e5f60718';
const OTHER_ACCOUNT = 'acct_00112233445566aa';

function token(overrides: { accountId?: string; version?: number; nowSeconds?: number } = {}) {
  return issueSessionToken({
    secret: SECRET,
    accountId: overrides.accountId ?? ACCOUNT,
    version: overrides.version ?? 1,
    nowSeconds: overrides.nowSeconds ?? NOW_SECONDS,
  });
}

/** A socket carrying whatever a client chose to present. */
function socketWith(handshake: { auth?: unknown; query?: Record<string, string> }): Socket {
  return {
    handshake: { auth: handshake.auth ?? {}, query: handshake.query ?? {} },
  } as unknown as Socket;
}

const authority = () =>
  createOperatorAuthority({ secret: SECRET_VALUE, nowSeconds: () => NOW_SECONDS });

describe('admitting an operator', () => {
  it('admits a valid session token and reports the account', () => {
    const admission = authority().admit(socketWith({ auth: { token: token() } }));

    expect(admission.ok).toBe(true);
    if (admission.ok) expect(admission.accountId).toBe(ACCOUNT);
  });

  it('accepts the token from the query string too', () => {
    const admission = authority().admit(socketWith({ query: { token: token() } }));
    expect(admission.ok).toBe(true);
  });

  /*
   * THE DEFECT THIS CLOSES. `?role=operator` was the entire check, so this
   * socket -- claiming the role and presenting nothing -- used to be admitted
   * to a live programme's controls.
   */
  it('refuses a socket that merely claims the role', () => {
    const admission = authority().admit(socketWith({ query: { role: 'operator' } }));

    expect(admission.ok).toBe(false);
    if (!admission.ok) expect(admission.reason).toBe('no-token');
  });

  it('refuses a forged token', () => {
    const admission = authority().admit(socketWith({ auth: { token: 'not-a-token' } }));
    expect(admission.ok).toBe(false);
  });

  it('refuses a token signed with a different secret', () => {
    const otherSecret = requireSessionSecret('y'.repeat(48), 'OTHER');
    const foreign = issueSessionToken({
      secret: otherSecret,
      accountId: OTHER_ACCOUNT,
      version: 1,
      nowSeconds: NOW_SECONDS,
    });

    const admission = authority().admit(socketWith({ auth: { token: foreign } }));
    expect(admission.ok).toBe(false);
  });

  it('refuses an expired token', () => {
    const old = token({ nowSeconds: NOW_SECONDS - 60 * 60 * 24 * 365 });
    const admission = authority().admit(socketWith({ auth: { token: old } }));
    expect(admission.ok).toBe(false);
  });

  /*
   * FAIL CLOSED, unlike the personal-voice verifier next door. There, an
   * unusable secret degrades to standard voices and the worst outcome is
   * sounding generic. Here the worst outcome is an anonymous stranger
   * controlling a live broadcast.
   */
  it('refuses every operator when no secret is configured', () => {
    const unconfigured = createOperatorAuthority({ secret: undefined });
    const admission = unconfigured.admit(socketWith({ auth: { token: token() } }));

    expect(admission.ok).toBe(false);
    if (!admission.ok) expect(admission.reason).toBe('not-configured');
  });

  it('refuses when the secret is too short to be a secret', () => {
    const weak = createOperatorAuthority({ secret: 'short' });
    expect(weak.admit(socketWith({ auth: { token: token() } })).ok).toBe(false);
  });
});

describe('the entitlement gate', () => {
  /*
   * OPEN, BUT NOT ANONYMOUS. A deliberate product decision taken while there is
   * nothing to subscribe to -- and never a bypass of authentication.
   */
  it('admits any authenticated account while entitlement is not required', () => {
    const open = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: false,
    });
    expect(open.admit(socketWith({ auth: { token: token() } })).ok).toBe(true);
  });

  it('still refuses an unauthenticated caller while entitlement is not required', () => {
    const open = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: false,
    });
    expect(open.admit(socketWith({ query: { role: 'operator' } })).ok).toBe(false);
  });

  it('refuses an authenticated account with no entitlement once required', () => {
    const gated = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: true,
      hasEntitlement: () => false,
    });
    const admission = gated.admit(socketWith({ auth: { token: token() } }));
    expect(admission.ok).toBe(false);
    if (!admission.ok) expect(admission.reason).toBe('not-entitled');
  });

  it('admits an entitled account once required', () => {
    const gated = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: true,
      hasEntitlement: (accountId) => accountId === ACCOUNT,
    });
    expect(gated.admit(socketWith({ auth: { token: token() } })).ok).toBe(true);
  });

  /*
   * Requiring entitlement with no way to check one must refuse rather than
   * admit. A gate that opens because nobody wired the check is not a gate.
   */
  it('refuses when entitlement is required but no checker was supplied', () => {
    const misconfigured = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: true,
    });
    expect(misconfigured.admit(socketWith({ auth: { token: token() } })).ok).toBe(false);
  });
});

/*
 * WHAT A REFUSED CALLER IS TOLD.
 *
 * The founder's screenshot (30 Aug 2026): a signed-in account reading "Not
 * signed in". One generic refusal for everything meant a real session that was
 * simply not on the allowlist was told to sign in, which it already had. The
 * line between the two messages is the signature -- an attacker holding no
 * valid token learns nothing new from either -- and these tests pin that line
 * from both sides.
 */
describe('what a refused operator is told', () => {
  const gated = () =>
    createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: true,
      hasEntitlement: (accountId) => accountId === ACCOUNT,
    });

  function refusal(admission: OperatorAdmission) {
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('expected a refusal');
    return { admission, notice: operatorRefusalNotice(admission.reason) };
  }

  it('admits a valid session for an enabled account', () => {
    expect(gated().admit(socketWith({ auth: { token: token() } })).ok).toBe(true);
  });

  it('tells a VALID session for an account that is not enabled exactly that', () => {
    const { admission, notice } = refusal(
      gated().admit(socketWith({ auth: { token: token({ accountId: OTHER_ACCOUNT }) } })),
    );

    expect(admission.reason).toBe('not-entitled');
    expect(notice).toEqual({ code: 'not-entitled', message: OPERATOR_NOT_ENTITLED_MESSAGE });
    expect(notice.message).toBe('This account is not enabled for the operator console.');
  });

  /*
   * THE SECURITY PROPERTY. Everything on the unverified side of the signature
   * collapses into one reason and one message. An expired session for the
   * NOT-enabled account must not get the entitlement message either: that
   * would let anybody with a stale token learn which accounts are enabled.
   */
  it.each([
    ['no token at all', socketWith({ query: { role: 'operator' } })],
    ['a forged token', socketWith({ auth: { token: 'not-a-token' } })],
    [
      'an expired token for an enabled account',
      socketWith({ auth: { token: token({ nowSeconds: NOW_SECONDS - 60 * 60 * 24 * 365 }) } }),
    ],
    [
      'an expired token for an account that is not enabled',
      socketWith({
        auth: {
          token: token({ accountId: OTHER_ACCOUNT, nowSeconds: NOW_SECONDS - 60 * 60 * 24 * 365 }),
        },
      }),
    ],
    [
      'a token signed with a different secret',
      socketWith({
        auth: {
          token: issueSessionToken({
            secret: requireSessionSecret('y'.repeat(48), 'OTHER'),
            accountId: ACCOUNT,
            version: 1,
            nowSeconds: NOW_SECONDS,
          }),
        },
      }),
    ],
  ])('gives the one generic refusal for %s', (_label, socket) => {
    const { admission, notice } = refusal(gated().admit(socket));

    expect(admission.reason).not.toBe('not-entitled');
    expect(notice).toEqual({ code: 'sign-in-required', message: OPERATOR_SIGN_IN_MESSAGE });
  });

  it('gives the generic refusal when the server has no secret, even to an enabled account', () => {
    const unconfigured = createOperatorAuthority({
      secret: undefined,
      requireEntitlement: true,
      hasEntitlement: () => true,
    });
    const { admission, notice } = refusal(
      unconfigured.admit(socketWith({ auth: { token: token() } })),
    );

    expect(admission.reason).toBe('not-configured');
    expect(notice.code).toBe('sign-in-required');
  });

  it('never consults the entitlement checker for a token that did not verify', () => {
    const consulted: string[] = [];
    const watched = createOperatorAuthority({
      secret: SECRET_VALUE,
      nowSeconds: () => NOW_SECONDS,
      requireEntitlement: true,
      hasEntitlement: (accountId) => {
        consulted.push(accountId);
        return true;
      },
    });

    watched.admit(socketWith({ auth: { token: 'not-a-token' } }));
    watched.admit(
      socketWith({ auth: { token: token({ nowSeconds: NOW_SECONDS - 60 * 60 * 24 * 365 }) } }),
    );
    watched.admit(socketWith({ query: { role: 'operator' } }));

    expect(consulted).toEqual([]);
  });

  it('never puts the token or the account id in a refusal, whichever side of the line', () => {
    const presented = token({ accountId: OTHER_ACCOUNT });
    const stale = token({ accountId: OTHER_ACCOUNT, nowSeconds: NOW_SECONDS - 60 * 60 * 24 * 365 });

    for (const socket of [
      socketWith({ auth: { token: presented } }),
      socketWith({ auth: { token: stale } }),
      socketWith({ query: { role: 'operator' } }),
    ]) {
      const { admission, notice } = refusal(gated().admit(socket));
      const surfaced = JSON.stringify({ admission, notice });

      expect(surfaced).not.toContain(OTHER_ACCOUNT);
      expect(surfaced).not.toContain(ACCOUNT);
      expect(surfaced).not.toContain(presented);
      expect(surfaced).not.toContain(stale);
      // Not even a prefix: the first segment of a token is its header.
      expect(surfaced).not.toContain(presented.slice(0, 12));
      expect(Object.keys(admission).sort()).toEqual(['ok', 'reason']);
      expect(Object.keys(notice).sort()).toEqual(['code', 'message']);
    }
  });
});
