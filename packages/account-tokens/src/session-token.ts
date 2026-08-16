/** @author masterzee001 */
/**
 * Proving who is calling, without asking the account service every time.
 *
 * A signed bearer token rather than an opaque one, for a specific reason: the
 * gateway and media-ingest both need to know who somebody is, and an opaque
 * token would make every call join and every enrolment depend on the account
 * service being reachable. Nobody should be unable to join a call because a
 * sign-in service is restarting.
 *
 * This is JWT-SHAPED and is deliberately not a JWT. There is no `alg` header,
 * so there is no algorithm to confuse and no `none` to accept; the algorithm is
 * fixed at HMAC-SHA256 in code. Verification is constant-time, and the payload
 * is only trusted after the signature has been checked — the ordering that JWT
 * libraries have historically got wrong in public.
 *
 * WHAT THIS DOES NOT DO: a token stays valid until it expires. Signing out
 * clears it from the browser, which is not the same as making it unusable. The
 * account service checks `ver` against the account so "sign out everywhere" can
 * invalidate tokens where it matters most; every other service verifies
 * signature and expiry only, and cannot know about a revocation until the token
 * ages out. That is the price of not needing a round trip, it is bounded by the
 * lifetime below, and it is written down here rather than discovered later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseAccountId, type AccountId } from '@videofy-live/participant-contracts';

/**
 * Twelve hours. Long enough that a call is never interrupted by a token ageing
 * out mid-conversation, short enough that a stolen one is not indefinite.
 */
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

/** The minimum secret we will operate on. Shorter is not a secret. */
const MIN_SECRET_LENGTH = 32;

export interface SessionClaims {
  /** The account. */
  readonly accountId: AccountId;
  /** Issued-at, epoch seconds. */
  readonly issuedAt: number;
  /** Expiry, epoch seconds. */
  readonly expiresAt: number;
  /**
   * The account's token generation. Bumping it on the account invalidates every
   * token issued before — the account service's "sign out everywhere".
   */
  readonly version: number;
}

export type SessionVerification =
  | { readonly ok: true; readonly claims: SessionClaims }
  /**
   * One reason shape for every failure, so a caller cannot accidentally tell a
   * client whether their token was forged, stale or simply wrong — and so no
   * branch here becomes an oracle.
   */
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

interface TokenPayload {
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  ver?: unknown;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * The signing key, or a refusal.
 *
 * A service that cannot find its secret must not invent one. Two services that
 * each generated their own would sign tokens the other rejects, and a shared
 * default baked into the repository is a secret that is not secret — the
 * failure mode where every deployment in the world shares one key.
 */
export function requireSessionSecret(value: string | undefined, variableName: string): Buffer {
  if (!value || value.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${variableName} must be set to at least ${MIN_SECRET_LENGTH} characters before this service can verify sign-ins. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(value, 'utf8');
}

function sign(secret: Buffer, body: string): string {
  return base64url(createHmac('sha256', secret).update(body).digest());
}

export function issueSessionToken(input: {
  readonly secret: Buffer;
  readonly accountId: AccountId;
  readonly version: number;
  readonly nowSeconds: number;
  readonly lifetimeSeconds?: number;
}): string {
  const payload = {
    sub: input.accountId,
    iat: input.nowSeconds,
    exp: input.nowSeconds + (input.lifetimeSeconds ?? SESSION_LIFETIME_SECONDS),
    ver: input.version,
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(input.secret, body)}`;
}

/**
 * Verify a token and return what it claims.
 *
 * The signature is checked BEFORE the payload is parsed for meaning, and the
 * comparison is constant-time. Everything after that point is trusted only
 * because the signature held.
 */
export function verifySessionToken(input: {
  readonly secret: Buffer;
  readonly token: string;
  readonly nowSeconds: number;
}): SessionVerification {
  const parts = input.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid' };
  const [body, provided] = parts as [string, string];

  const expected = sign(input.secret, body);
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  // Length is compared first because timingSafeEqual throws on a mismatch; a
  // differing length is already a failure, so nothing is leaked by returning.
  if (providedBytes.length !== expectedBytes.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(providedBytes, expectedBytes)) return { ok: false, reason: 'invalid' };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const accountId = parseAccountId(payload.sub);
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const version = payload.ver;
  if (
    accountId === null ||
    typeof issuedAt !== 'number' ||
    typeof expiresAt !== 'number' ||
    typeof version !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.nowSeconds >= expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true, claims: { accountId, issuedAt, expiresAt, version } };
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1]?.trim() || null;
}
