/** @author masterzee001 */
/**
 * Who may operate a programme.
 *
 * `/microphone/sessions` and `/sessions/:id/*` are remote control of a live
 * broadcast: create, pause, resume, cancel, retry, read the transcript. Until
 * 30 Aug 2026 they authenticated nobody, and a boot guard kept the service out
 * of production for exactly that reason. This module is the fix that guard was
 * waiting for, and it is the SAME rule the gateway already applies to the
 * operator socket, so a console that can connect can also operate and one that
 * cannot connect cannot operate either:
 *
 *   1. a verified C7 session token (bearer, signed with VIDEOFY_AUTH_SECRET,
 *      verified locally exactly as the personal-voice routes verify it), AND
 *   2. the operator entitlement -- the OPERATOR_CONSOLE_ACCOUNT_IDS allowlist,
 *      fail-closed: unset or empty means NOBODY operates.
 *
 * Refusals are two deliberately different sentences. A missing, malformed or
 * expired token is told to sign in (401). A valid token whose account is not
 * on the allowlist is told so (403) -- safe, because only somebody who already
 * holds a real session learns it. Neither reveals whether the programme exists:
 * the guard runs BEFORE the route, so an anonymous caller gets the same answer
 * for a real session id as for a made-up one.
 *
 * The internal token the gateway presents on `/internal/*` is honoured here
 * too. It is a server-only credential that can already create sessions and
 * inject audio through the internal media API, so accepting it on the
 * operator routes grants nothing it did not have; what it buys is that a
 * server-side probe holding the token can drive a programme without minting a
 * browser session. It is consulted ONLY when the header is actually presented.
 */
import type express from 'express';
import type { AuthenticateRequest } from './account-authentication.js';

export const SIGN_IN_TO_OPERATE = 'Sign in to operate.';
export const NOT_ENABLED_FOR_OPERATOR_CONSOLE =
  'This account is not enabled for the operator console.';

/** The env name, spelled once, identical to the gateway's. */
export const OPERATOR_CONSOLE_ACCOUNT_IDS_VARIABLE = 'OPERATOR_CONSOLE_ACCOUNT_IDS';
export const INTERNAL_TOKEN_HEADER = 'X-Videofy-Internal-Token';

export interface OperatorEntitlement {
  /** How many accounts the allowlist names; zero means everybody is refused. */
  readonly allowedCount: number;
  readonly hasEntitlement: (accountId: string) => boolean;
}

/**
 * Parse the allowlist the way the gateway parses it: comma-separated,
 * trimmed, blanks dropped. Unset, empty or whitespace-only names nobody.
 */
export function operatorEntitlementFromAllowlist(raw: string | undefined): OperatorEntitlement {
  const allowed = new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return {
    allowedCount: allowed.size,
    hasEntitlement: (accountId) => allowed.has(accountId),
  };
}

export interface ProgrammeControlGuardOptions {
  /** The verified account behind a bearer token, or null. Never throws. */
  readonly authenticate: AuthenticateRequest;
  readonly entitlement: OperatorEntitlement;
  /**
   * Does this presented internal token match the deployment's? Called only
   * when the header is present. Omit to accept no internal caller at all.
   */
  readonly internalTokenAllowed?: (presented: string) => boolean;
}

/**
 * Generic in the route's params so that mounting the guard does not widen
 * `req.params.sessionId` to `string | undefined` for the handler behind it;
 * a plain `RequestHandler` would, and every route would then need a guard of
 * its own against a value the path guarantees.
 */
export type ProgrammeControlGuard = <P extends Record<string, string>>(
  req: express.Request<P>,
  res: express.Response,
  next: express.NextFunction,
) => void;

/** Set on `res.locals` by the guard, for a route that wants to know who acted. */
export const OPERATOR_ACCOUNT_LOCAL = 'operatorAccountId';

/**
 * Express middleware: continue only for an entitled operator or the internal
 * service token; otherwise answer 401 or 403 and stop.
 */
export function createProgrammeControlGuard(
  options: ProgrammeControlGuardOptions,
): ProgrammeControlGuard {
  return (req, res, next) => {
    const internal = req.header(INTERNAL_TOKEN_HEADER);
    if (internal !== undefined && options.internalTokenAllowed?.(internal) === true) {
      next();
      return;
    }
    const accountId = options.authenticate(req);
    if (accountId === null) {
      res.status(401).json({ error: SIGN_IN_TO_OPERATE });
      return;
    }
    if (!options.entitlement.hasEntitlement(accountId)) {
      res.status(403).json({ error: NOT_ENABLED_FOR_OPERATOR_CONSOLE });
      return;
    }
    res.locals[OPERATOR_ACCOUNT_LOCAL] = accountId;
    next();
  };
}
