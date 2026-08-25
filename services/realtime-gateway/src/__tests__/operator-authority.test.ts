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
import { createOperatorAuthority } from '../operator-authority.js';

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
    expect(gated.admit(socketWith({ auth: { token: token() } })).ok).toBe(false);
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
