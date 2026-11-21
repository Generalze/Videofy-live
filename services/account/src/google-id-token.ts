/** @author masterzee001 */
/**
 * Verifying a Google ID token, which is the whole of the security boundary for
 * signing in with Google.
 *
 * Everything downstream -- the linking rule, the identity table, the account --
 * trusts whatever this file returns. If this accepts a token it should not,
 * nothing later notices, because by then the assertion looks exactly like a
 * real one. So the refusals here are the product, and each one below says
 * which attack it is refusing.
 *
 * WHY WE VERIFY RATHER THAN CALL GOOGLE. An ID token is signed with Google's
 * RSA keys and carries everything we need, so checking it locally costs no
 * round trip on the sign-in path. The keys themselves are public and cached.
 * There is no client secret anywhere in this flow and none is needed: the
 * signature is what proves the token came from Google, and the audience check
 * is what proves it was minted for us.
 */
import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

/** Google's published keys, and the issuers it signs as. */
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ACCEPTED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * How far a token may be out of step with our clock.
 *
 * Small on purpose. This exists for ordinary clock drift between Google's
 * servers and ours, not to be generous: every second of leeway is a second an
 * expired token keeps working.
 */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Keys are refetched at most this often when a token names one we do not hold.
 *
 * Without this, anybody can make us hammer Google by sending tokens with
 * invented `kid` values -- our own verifier turned into a request amplifier
 * against the service we depend on to sign anybody in at all.
 */
const MIN_REFETCH_INTERVAL_MS = 60_000;

/** Used when Google's response carries no usable max-age. */
const FALLBACK_CACHE_MS = 60 * 60 * 1000;

export type GoogleVerification =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly email: string | null;
      readonly emailVerified: boolean;
      readonly displayName: string | null;
      /** Which of our client ids the token was minted for. */
      readonly audience: string;
    }
  | { readonly ok: false; readonly reason: GoogleRefusal };

export type GoogleRefusal =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'no-subject'
  | 'keys-unavailable';

export interface GoogleIdTokenVerifierOptions {
  /**
   * Every client id a token may legitimately name.
   *
   * MUST NOT BE EMPTY. An empty list with a "no audiences configured means
   * accept any" reading would turn the single most important check into a
   * no-op the moment a line goes missing from an env file -- and it would look
   * like it was working. The constructor refuses instead.
   */
  readonly audiences: readonly string[];
  readonly jwksUrl?: string;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

interface CachedKeys {
  readonly keys: Map<string, ReturnType<typeof createPublicKey>>;
  readonly expiresAtMs: number;
  readonly fetchedAtMs: number;
}

interface JsonWebKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export class GoogleIdTokenVerifier {
  private readonly audiences: ReadonlySet<string>;
  private readonly jwksUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private cache: CachedKeys | null = null;
  private inFlight: Promise<CachedKeys | null> | null = null;

  constructor(options: GoogleIdTokenVerifierOptions) {
    const audiences = options.audiences.map((value) => value.trim()).filter((v) => v.length > 0);
    if (audiences.length === 0) {
      throw new Error(
        'GoogleIdTokenVerifier: at least one audience is required; without one every token would be accepted',
      );
    }
    this.audiences = new Set(audiences);
    this.jwksUrl = options.jwksUrl ?? DEFAULT_JWKS_URL;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verify(idToken: string): Promise<GoogleVerification> {
    const parts = idToken.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (header === null || payload === null) return { ok: false, reason: 'malformed' };

    /*
     * ALGORITHM CONFUSION, refused first and by name.
     *
     * Two classic attacks live here. `alg: none` asks us to skip the signature
     * entirely. `alg: HS256` asks us to treat Google's PUBLIC key as an HMAC
     * secret -- and it is public, so anybody can forge a token that verifies.
     * We never read `alg` to decide HOW to verify; we read it only to refuse
     * anything that is not the one algorithm we accept.
     */
    if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported-algorithm' };
    const kid = typeof header.kid === 'string' ? header.kid : null;
    if (kid === null) return { ok: false, reason: 'malformed' };

    const key = await this.keyFor(kid);
    if (key === 'unavailable') return { ok: false, reason: 'keys-unavailable' };
    if (key === null) return { ok: false, reason: 'unknown-key' };

    const signed = `${encodedHeader}.${encodedPayload}`;
    const signature = Buffer.from(encodedSignature, 'base64url');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signed);
    verifier.end();
    if (!verifier.verify(key, signature)) return { ok: false, reason: 'bad-signature' };

    /*
     * Claims are only read AFTER the signature holds. Reading them earlier
     * would mean deciding things -- which account, which audience -- from a
     * document nobody has shown us the provenance of yet.
     */
    const issuer = typeof payload.iss === 'string' ? payload.iss : '';
    if (!ACCEPTED_ISSUERS.has(issuer)) return { ok: false, reason: 'wrong-issuer' };

    /*
     * THE AUDIENCE CHECK, which is what stops a valid Google token minted for
     * SOMEBODY ELSE'S app from signing its holder into Videofy. Every app that
     * uses Google gets real, correctly signed tokens; `aud` is the only field
     * that says which app a token was for. Compared in constant time so the
     * check cannot be turned into a way to read our client ids back out.
     */
    const audience = typeof payload.aud === 'string' ? payload.aud : '';
    if (!this.audienceAccepted(audience)) return { ok: false, reason: 'wrong-audience' };

    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (exp + CLOCK_SKEW_SECONDS <= nowSeconds) return { ok: false, reason: 'expired' };
    const nbf = typeof payload.nbf === 'number' ? payload.nbf : null;
    if (nbf !== null && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      return { ok: false, reason: 'not-yet-valid' };
    }

    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (subject.length === 0) return { ok: false, reason: 'no-subject' };

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const displayName = typeof payload.name === 'string' ? payload.name.trim() : '';

    return {
      ok: true,
      subject,
      email: email.length > 0 ? email : null,
      /*
       * Strictly true, never truthy. Google sends a boolean, but some clients
       * and some providers send the STRING "false", which is truthy -- and a
       * truthy check there would mark an unproven address as proven, which is
       * the exact input the linking rule exists to refuse.
       */
      emailVerified: payload.email_verified === true,
      displayName: displayName.length > 0 ? displayName : null,
      audience,
    };
  }

  private audienceAccepted(audience: string): boolean {
    if (audience.length === 0) return false;
    const candidate = Buffer.from(audience);
    for (const accepted of this.audiences) {
      const expected = Buffer.from(accepted);
      if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) return true;
    }
    return false;
  }

  /**
   * The key for this `kid`, fetching or refreshing as needed.
   *
   * Returns `null` when the keys are current and simply do not contain it, and
   * `'unavailable'` when we could not get keys at all -- which are different
   * answers: the first is a bad token, the second is our own outage, and
   * reporting an outage as a bad token sends somebody to reset a password that
   * was never the problem.
   */
  private async keyFor(
    kid: string,
  ): Promise<ReturnType<typeof createPublicKey> | null | 'unavailable'> {
    const fresh = this.cache !== null && this.cache.expiresAtMs > this.now();
    if (fresh) {
      const hit = this.cache?.keys.get(kid);
      if (hit) return hit;
      /*
       * Google rotates keys, so an unknown kid against a cache that has not
       * expired is normal and is worth one refetch -- but only one per
       * interval, or invented kids become a way to make us flood Google.
       */
      const since = this.now() - (this.cache?.fetchedAtMs ?? 0);
      if (since < MIN_REFETCH_INTERVAL_MS) return null;
    }

    const loaded = await this.loadKeys();
    if (loaded === null) {
      // The fetch failed. A cache past its max-age is still better evidence
      // than nothing: Google's keys outlive their cache header by design.
      const stale = this.cache?.keys.get(kid);
      return stale ?? 'unavailable';
    }
    return loaded.keys.get(kid) ?? null;
  }

  /** One fetch at a time, however many sign-ins arrive together. */
  private async loadKeys(): Promise<CachedKeys | null> {
    if (this.inFlight) return this.inFlight;
    const work = (async (): Promise<CachedKeys | null> => {
      try {
        const response = await this.fetchImpl(this.jwksUrl, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { keys?: JsonWebKey[] };
        if (!Array.isArray(body.keys)) return null;

        const keys = new Map<string, ReturnType<typeof createPublicKey>>();
        for (const jwk of body.keys) {
          // Only signing keys, only RSA, only ones we can name.
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          if (jwk.use !== undefined && jwk.use !== 'sig') continue;
          if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
          if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
          try {
            keys.set(
              jwk.kid,
              createPublicKey({
                key: { kty: 'RSA', n: jwk.n, e: jwk.e },
                format: 'jwk',
              }),
            );
          } catch {
            // One unusable key must not discard the others in the set.
          }
        }
        if (keys.size === 0) return null;

        const fetchedAtMs = this.now();
        const cached: CachedKeys = {
          keys,
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + maxAgeMs(response.headers.get('cache-control')),
        };
        this.cache = cached;
        return cached;
      } catch {
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = work;
    return work;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function maxAgeMs(cacheControl: string | null): number {
  if (cacheControl === null) return FALLBACK_CACHE_MS;
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match?.[1]) return FALLBACK_CACHE_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_CACHE_MS;
  return seconds * 1000;
}
