/**
 * Who may START a call.
 *
 * WHAT THIS CLOSES. The account shell has been telling people "You cannot yet
 * host calls, create conferences or create an organization" while nothing
 * anywhere enforced it. `session.host` was defined in workspace-authority and
 * computed for every account, and consulted in exactly no place along the call
 * path — so the restriction was a sentence on a page, and anybody who navigated
 * to the call app could originate a call. Given that the reason for the gate is
 * people using a video product to approach strangers, an unenforced version of
 * it is worse than none: it reads as a safeguard while being decoration.
 *
 * TWO STEPS, AND THE ORDER MATTERS. The token is verified LOCALLY first, which
 * is cheap and rejects the overwhelming majority of bad callers without leaving
 * the process. Only a caller who already holds a valid session costs an HTTP
 * round trip to the account service.
 *
 * WHY IT ASKS RATHER THAN READS A CLAIM. Capabilities depend on trust, and
 * trust changes after a token is minted — an account can be verified, or
 * restricted, minutes later. A claim baked into the token would keep answering
 * with whatever was true at sign-in, which is the same staleness the step-up
 * design refuses. The cost is one request per call CREATION, which is rare;
 * joining an existing call never touches this.
 *
 * FAILS CLOSED, EVERY WAY. No secret, no account URL, an unreachable service, a
 * timeout, a malformed answer, a missing capability — all of them refuse. The
 * failure mode of the alternative is that an outage silently opens the gate,
 * and nobody finds out until it is used.
 */
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';
import { logger } from './logger.js';

/** The capability the account service computes for starting a call. */
const HOST_CAPABILITY = 'session.host';

export interface CallHostAuthorityOptions {
  /** The same secret the account service signs sessions with. */
  readonly secret: string | undefined;
  /** Where the account service lives, internally. */
  readonly accountServiceUrl: string | undefined;
  /**
   * Short on purpose. Somebody pressing "start a call" is waiting, and a
   * gate that hangs is indistinguishable from a product that is broken.
   */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The pair's conversation mode, from the account service, for a DIRECT call.
 *
 * Asked with the CALLER's session token against the same route the chat
 * screens use (`GET /messages/with/:peer/mode`), so the answer is exactly
 * what both people see in their chat: normal unless they switched it.
 * Null on any failure -- the caller then gets a NORMAL call, the free
 * default, never a silently translated (billable) one.
 */
export function createDirectCallModeResolver(
  options: CallHostAuthorityOptions,
): (sessionToken: string | null, peerAccountId: string) => Promise<'normal' | 'translated' | null> {
  const accountUrl = options.accountServiceUrl?.replace(/\/+$/, '') ?? null;
  const timeoutMs = options.timeoutMs ?? 4000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async function resolveDirectCallMode(sessionToken, peerAccountId) {
    if (accountUrl === null || typeof sessionToken !== 'string' || sessionToken.length === 0) {
      return null;
    }
    if (!/^acct_[0-9a-f]{16}$/.test(peerAccountId)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${accountUrl}/messages/with/${encodeURIComponent(peerAccountId)}/mode`,
        { headers: { authorization: `Bearer ${sessionToken}` }, signal: controller.signal },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { mode?: unknown };
      return body.mode === 'translated' ? 'translated' : body.mode === 'normal' ? 'normal' : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createCallHostAuthority(
  options: CallHostAuthorityOptions,
): (sessionToken: string | null) => Promise<boolean> {
  let secret: Buffer | null = null;
  try {
    secret = requireSessionSecret(options.secret, 'VIDEOFY_AUTH_SECRET');
  } catch {
    secret = null;
  }

  const accountUrl = options.accountServiceUrl?.replace(/\/+$/, '') ?? null;
  const timeoutMs = options.timeoutMs ?? 4000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (secret === null || accountUrl === null) {
    logger.warn(
      'Call hosting is refused for everybody: VIDEOFY_AUTH_SECRET or ACCOUNT_SERVICE_URL is not set. ' +
        'Joining a call is unaffected.',
    );
  }

  return async function authorizeCallHost(sessionToken: string | null): Promise<boolean> {
    if (secret === null || accountUrl === null) return false;
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) return false;

    // Local first: a forged or expired token never reaches the network.
    const verified = verifySessionToken({
      secret,
      token: sessionToken,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${accountUrl}/me`, {
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: controller.signal,
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { capabilities?: unknown };
      if (!Array.isArray(body.capabilities)) return false;
      return body.capabilities.includes(HOST_CAPABILITY);
    } catch {
      /*
       * A timeout or an unreachable account service refuses. That is a real
       * cost -- an account-service outage stops new calls being started -- and
       * it is the correct direction: the alternative is that the same outage
       * silently removes the gate, which is exactly when nobody is watching.
       */
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
