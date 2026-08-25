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
 * TWO GATES, AND ONLY ONE OF THEM NEEDS PRICING.
 *
 *   1. AUTHENTICATION — a valid C7 session token. Needs no commercial decision
 *      and closes the actual hole.
 *   2. ENTITLEMENT — a subscription that includes programme operation. Needs
 *      prices to exist, and slots in later against the entitlement model that
 *      workspace-authority already has.
 *
 * So the console is OPEN, and no longer ANONYMOUS. Any verified C7 account may
 * operate today; the second gate closes when there is something to subscribe to.
 *
 * ONE PROGRAMME AT A TIME, TODAY. The gateway holds a single
 * `latestProgrammeMediaState` and one set of audio-mode preferences, so two
 * operators would overwrite each other rather than run two programmes. This
 * module therefore establishes WHO an operator is, and deliberately does not
 * pretend to scope them to a channel — that scoping is a later change, and the
 * accountId this resolves is exactly what it will key on.
 */
import type { Socket } from 'socket.io';
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';

export type OperatorAdmission =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: 'no-token' | 'invalid-token' | 'not-configured' };

export interface OperatorAuthorityOptions {
  readonly secret: string | undefined;
  readonly nowSeconds?: () => number;
  /**
   * Whether an authenticated account additionally needs an entitlement.
   *
   * FALSE until pricing exists, and that is a deliberate, recorded product
   * decision rather than an oversight: the console is open to any verified
   * account for now. It is NOT a bypass of authentication — a caller with no
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
        const entitled = options.hasEntitlement?.(accountId) ?? false;
        if (!entitled) return { ok: false, reason: 'invalid-token' };
      }

      return { ok: true, accountId };
    },
  };
}

export type OperatorAuthority = ReturnType<typeof createOperatorAuthority>;
