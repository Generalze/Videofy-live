/** @owner masterzee001 */
/**
 * Videofy Connect join tokens — the single-use credential a partner's server
 * mints (via POST /v1/calls/:id/join-tokens) and a browser redeems exactly
 * once on `call:join`.
 *
 * The construction copies the discipline of `@videofy-live/account-tokens`
 * (JWT-shaped, deliberately not a JWT: no `alg` header to confuse, HMAC-SHA256
 * fixed in code, constant-time signature check BEFORE the payload is parsed
 * for meaning) but it is a SEPARATE credential system on purpose:
 *
 * - a different secret (CONNECT_AUTH_SECRET, never VIDEOFY_AUTH_SECRET), and
 * - an `aud` claim ('vc-join') that account session tokens do not carry,
 *
 * so cross-verification is structurally impossible in BOTH directions even if
 * the two secrets were ever misconfigured to the same value. A test proves it.
 *
 * Single-use enforcement does not live here: the token itself is stateless.
 * `ConnectJtiRegistry` below is the in-memory claim set the gateway consults
 * with a SYNCHRONOUS check-and-set before any await on the join path (R6).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONNECT_JOIN_TOKEN_AUDIENCE = 'vc-join';

/** R6: default five minutes, hard ceiling fifteen. Requests above it are refused, never clamped. */
export const CONNECT_JOIN_TOKEN_DEFAULT_TTL_SECONDS = 300;
export const CONNECT_JOIN_TOKEN_MAX_TTL_SECONDS = 900;

/** The minimum secret we will operate on. Shorter is not a secret. */
export const CONNECT_AUTH_SECRET_MIN_LENGTH = 32;

/** The participant preferences the partner locked into the token at mint time. */
export interface ConnectJoinTokenPrefs {
  readonly speak: string;
  readonly hear: string;
  readonly audioMode: 'translated' | 'interpretation' | 'original';
  readonly captions: boolean;
  readonly voiceGender: 'female' | 'male';
}

export interface ConnectJoinTokenClaims {
  readonly aud: typeof CONNECT_JOIN_TOKEN_AUDIENCE;
  /** The minting project. */
  readonly proj: string;
  /** The PUBLIC vc_ call id — internal ids never travel inside a credential a client holds. */
  readonly call: string;
  /** Partner-supplied stable opaque identity (R8). */
  readonly sub: string;
  /** Display name for the seat. */
  readonly name: string;
  readonly prefs: ConnectJoinTokenPrefs;
  /** Single-use claim id; burned on first presentation, success or not. */
  readonly jti: string;
  /** Issued-at / expiry, epoch seconds. */
  readonly iat: number;
  readonly exp: number;
}

export type ConnectJoinTokenVerification =
  /**
   * Two reasons only, and only because the caller may say so publicly
   * ('expired' maps to AUTH_EXPIRED_TOKEN, everything else to
   * AUTH_INVALID_TOKEN); no branch here becomes a finer oracle.
   */
  | { readonly ok: true; readonly claims: ConnectJoinTokenClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

/**
 * The signing key, or a refusal. Copied discipline: a service that cannot find
 * its secret must not invent one, and a short secret is not a secret.
 */
export function requireConnectAuthSecret(
  value: string | undefined,
  variableName: string,
): Buffer {
  if (!value || value.trim().length < CONNECT_AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `${variableName} must be set to at least ${CONNECT_AUTH_SECRET_MIN_LENGTH} characters before Connect join tokens can be issued or verified. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(value, 'utf8');
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(secret: Buffer, body: string): string {
  return base64url(createHmac('sha256', secret).update(body).digest());
}

export function issueConnectJoinToken(input: {
  readonly secret: Buffer;
  readonly proj: string;
  readonly call: string;
  readonly sub: string;
  readonly name: string;
  readonly prefs: ConnectJoinTokenPrefs;
  readonly jti: string;
  readonly nowSeconds: number;
  /** 1..900; default 300. Out of range throws — the mint endpoint refuses, never clamps. */
  readonly ttlSeconds?: number;
}): { token: string; expiresAtSeconds: number } {
  const ttl = input.ttlSeconds ?? CONNECT_JOIN_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > CONNECT_JOIN_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(
      `Connect join token TTL must be an integer between 1 and ${CONNECT_JOIN_TOKEN_MAX_TTL_SECONDS} seconds.`,
    );
  }
  const expiresAtSeconds = input.nowSeconds + ttl;
  const claims: ConnectJoinTokenClaims = {
    aud: CONNECT_JOIN_TOKEN_AUDIENCE,
    proj: input.proj,
    call: input.call,
    sub: input.sub,
    name: input.name,
    prefs: input.prefs,
    jti: input.jti,
    iat: input.nowSeconds,
    exp: expiresAtSeconds,
  };
  const body = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return { token: `${body}.${sign(input.secret, body)}`, expiresAtSeconds };
}

const AUDIO_MODES = new Set(['translated', 'interpretation', 'original']);
const VOICE_GENDERS = new Set(['female', 'male']);

function parsePrefs(candidate: unknown): ConnectJoinTokenPrefs | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  const prefs = candidate as Record<string, unknown>;
  const speak = prefs['speak'];
  const hear = prefs['hear'];
  const audioMode = prefs['audioMode'];
  const captions = prefs['captions'];
  const voiceGender = prefs['voiceGender'];
  if (typeof speak !== 'string' || speak.length === 0) return null;
  if (typeof hear !== 'string' || hear.length === 0) return null;
  if (typeof audioMode !== 'string' || !AUDIO_MODES.has(audioMode)) return null;
  if (typeof captions !== 'boolean') return null;
  if (typeof voiceGender !== 'string' || !VOICE_GENDERS.has(voiceGender)) return null;
  return {
    speak,
    hear,
    audioMode: audioMode as ConnectJoinTokenPrefs['audioMode'],
    captions,
    voiceGender: voiceGender as ConnectJoinTokenPrefs['voiceGender'],
  };
}

/**
 * Verify a token and return what it claims. The signature is checked BEFORE
 * the payload is parsed for meaning, the comparison is constant-time, and the
 * audience must be 'vc-join' — which is what makes an account session token
 * (no `aud`) structurally unverifiable here even under an identical secret.
 */
export function verifyConnectJoinToken(input: {
  readonly secret: Buffer;
  readonly token: string;
  readonly nowSeconds: number;
}): ConnectJoinTokenVerification {
  const parts = input.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid' };
  const [body, provided] = parts as [string, string];

  const expected = sign(input.secret, body);
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  // Length first: timingSafeEqual throws on mismatch, and a differing length
  // is already a failure, so nothing is leaked by returning.
  if (providedBytes.length !== expectedBytes.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(providedBytes, expectedBytes)) return { ok: false, reason: 'invalid' };

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fromBase64url(body).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid' };
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  // Audience discipline: 'vc-join' or nothing. This is the structural wall
  // between Connect join tokens and account session tokens.
  if (payload['aud'] !== CONNECT_JOIN_TOKEN_AUDIENCE) return { ok: false, reason: 'invalid' };

  const proj = payload['proj'];
  const call = payload['call'];
  const sub = payload['sub'];
  const name = payload['name'];
  const jti = payload['jti'];
  const iat = payload['iat'];
  const exp = payload['exp'];
  const prefs = parsePrefs(payload['prefs']);
  if (
    typeof proj !== 'string' ||
    proj.length === 0 ||
    typeof call !== 'string' ||
    call.length === 0 ||
    typeof sub !== 'string' ||
    sub.length === 0 ||
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    prefs === null
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.nowSeconds >= exp) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: { aud: CONNECT_JOIN_TOKEN_AUDIENCE, proj, call, sub, name, prefs, jti, iat, exp },
  };
}

/** Kept a little past expiry so clock skew cannot un-burn a token that verify would still accept. */
const JTI_RETENTION_MARGIN_SECONDS = 60;

/**
 * The single-use claim set (R6). `claim` is a synchronous check-and-set: the
 * join path MUST call it before its first await, so two joins racing on the
 * event loop resolve to exactly one winner. A claimed jti stays claimed even
 * when the join later fails — the token is BURNED and the partner re-mints.
 *
 * In-memory on purpose (R13): a gateway restart voids all jti state together
 * with the live-call registry, and outstanding tokens die with it because
 * connect joins fail closed on live-registry membership, not on this set.
 */
export class ConnectJtiRegistry {
  /** jti -> expiry epoch seconds, for pruning only. */
  private readonly claimed = new Map<string, number>();

  /** True when this call claimed the jti; false when it was already burned. */
  claim(jti: string, expiresAtSeconds: number, nowSeconds: number): boolean {
    this.prune(nowSeconds);
    if (this.claimed.has(jti)) return false;
    this.claimed.set(jti, expiresAtSeconds);
    return true;
  }

  /** Entries whose token could no longer verify anyway are dropped. */
  private prune(nowSeconds: number): void {
    for (const [jti, expiresAtSeconds] of this.claimed) {
      if (nowSeconds >= expiresAtSeconds + JTI_RETENTION_MARGIN_SECONDS) {
        this.claimed.delete(jti);
      }
    }
  }

  get size(): number {
    return this.claimed.size;
  }
}
