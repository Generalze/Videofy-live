/** @author masterzee001 */
/**
 * Who may operate a programme.
 *
 * WHAT THIS FIXES. The operator role was claimed by a query parameter and
 * nothing else: `?role=operator` on a socket connection was the whole of the
 * check. Anybody who found the URL could start, stop, retarget and mute a live
 * programme going out to an audience. That is not a missing feature, it is an
 * open door, and it is the reason a boot guard has been holding this service
 * out of production.
 *
 * TWO GATES.
 *
 *   1. AUTHENTICATION -- a valid C7 session token. Closes the actual hole.
 *   2. ENTITLEMENT -- the account is one that may broadcast. Until pricing
 *      carries the grant, that population is the OPERATOR_CONSOLE_ACCOUNT_IDS
 *      allowlist the process wires in; an empty list refuses everybody.
 *
 * WHAT A REFUSED CALLER IS TOLD, AND WHY THE LINE SITS WHERE IT DOES.
 *
 * The signature is the line. Everything on the unverified side of it -- no
 * token, a forged one, an expired one, one signed by somebody else, a server
 * with no secret -- collapses into ONE reason and ONE message, because telling
 * those apart is exactly the feedback a guesser wants. On the verified side
 * there is one more refusal: a real, current session for an account that is
 * simply not enabled. That caller already knows who they are; the only fact
 * the distinct message adds is that this account cannot operate, which they
 * would otherwise discover by being told to sign in when they already have.
 * The founder's screenshot (30 Aug 2026) was that exact confusion.
 *
 * ONE PROGRAMME AT A TIME, TODAY. The gateway holds a single
 * `latestProgrammeMediaState` and one set of audio-mode preferences, so two
 * operators would overwrite each other rather than run two programmes. This
 * module therefore establishes WHO an operator is, and deliberately does not
 * pretend to scope them to a channel -- that scoping is a later change, and the
 * accountId this resolves is exactly what it will key on.
 */
import type { Socket } from 'socket.io';
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';

/**
 * Why an operator was refused. The first three sit on the unverified side of
 * the signature and are indistinguishable to the caller; `not-entitled` is
 * only ever produced for a token that verified.
 */
export type OperatorRefusalReason =
  'no-token' | 'invalid-token' | 'not-configured' | 'not-entitled';

export type OperatorAdmission =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: OperatorRefusalReason };

/** The one message every unverified refusal gets. */
export const OPERATOR_SIGN_IN_MESSAGE = 'Sign in to a C7 account with programme access to operate.';
/** Told only to the holder of a VALID session for the account it describes. */
export const OPERATOR_NOT_ENTITLED_MESSAGE =
  'This account is not enabled for the operator console.';

/**
 * What the socket is sent before it is closed.
 *
 * `code` is for the console to branch on and `message` is for a person to
 * read; they are a fixed pair, so the code adds nothing the message did not
 * already say. Neither field can carry the token or the account id: they are
 * chosen from two constants by a four-valued reason, and nothing else.
 */
export interface OperatorRefusalNotice {
  readonly code: 'sign-in-required' | 'not-entitled';
  readonly message: string;
}

export function operatorRefusalNotice(reason: OperatorRefusalReason): OperatorRefusalNotice {
  if (reason === 'not-entitled') {
    return { code: 'not-entitled', message: OPERATOR_NOT_ENTITLED_MESSAGE };
  }
  // no-token, invalid-token and not-configured: one answer, on purpose. A
  // server with no secret is a server whose signatures cannot be checked, and
  // "your token could not be verified" is all a caller may learn from that.
  return { code: 'sign-in-required', message: OPERATOR_SIGN_IN_MESSAGE };
}

export interface OperatorAuthorityOptions {
  readonly secret: string | undefined;
  readonly nowSeconds?: () => number;
  /**
   * Whether an authenticated account additionally needs an entitlement.
   *
   * The process sets this TRUE and supplies the allowlist as the checker. It
   * remains optional so a deployment with nothing to gate on can run an open
   * console knowingly; it is NOT a bypass of authentication -- a caller with no
   * valid token is refused either way.
   */
  readonly requireEntitlement?: boolean;
  readonly hasEntitlement?: (accountId: string) => boolean;
}

/**
 * The token, from wherever a socket client can put one.
 *
 * `auth` is the right place and is what socket.io provides for exactly this;
 * the query string is accepted because it is what a browser EventSource or a
 * hand-rolled client can manage, and refusing it would push people toward
 * putting the token somewhere worse. Both are equally visible to the server and
 * equally invisible to other clients.
 */
function tokenFrom(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
  const fromQuery = socket.handshake.query['token'];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  return null;
}

export function createOperatorAuthority(options: OperatorAuthorityOptions) {
  let secret: Buffer | null = null;
  try {
    secret = requireSessionSecret(options.secret, 'VIDEOFY_AUTH_SECRET');
  } catch {
    /*
     * FAIL CLOSED, unlike the personal-voice verifier next door.
     *
     * That one degrades to standard voices when the secret is unusable, because
     * the worst outcome is somebody sounding generic. Here the worst outcome is
     * an anonymous stranger controlling a live broadcast, so a missing secret
     * refuses every operator instead of admitting every one of them.
     */
    secret = null;
  }

  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return {
    admit(socket: Socket): OperatorAdmission {
      if (secret === null) return { ok: false, reason: 'not-configured' };

      const token = tokenFrom(socket);
      if (token === null) return { ok: false, reason: 'no-token' };

      const verified = verifySessionToken({ secret, token, nowSeconds: nowSeconds() });
      // Forged, expired, malformed and signed-by-somebody-else all arrive here
      // as one answer, because they all mean the same thing and telling them
      // apart only helps whoever is guessing.
      if (!verified.ok) return { ok: false, reason: 'invalid-token' };

      const accountId = verified.claims.accountId;

      if (options.requireEntitlement === true) {
        /*
         * BELOW THE SIGNATURE, SO THIS REASON IS SAFE TO BE DISTINCT. The
         * account id was read out of a token that just verified, which means
         * the caller holds a current session for it and already knows who they
         * are. "Not enabled" tells them nothing about anybody else and
         * nothing about the signing key; it stops a signed-in founder being
         * told to sign in. The checker is consulted ONLY here, so an
         * unverified account id never reaches it and cannot be probed
         * through it.
         */
        const entitled = options.hasEntitlement?.(accountId) ?? false;
        if (!entitled) return { ok: false, reason: 'not-entitled' };
      }

      return { ok: true, accountId };
    },
  };
}

export type OperatorAuthority = ReturnType<typeof createOperatorAuthority>;
