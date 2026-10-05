/** @author masterzee001 */
/**
 * The token that ties a provider callback to a login somebody actually began.
 *
 * WHAT GOES WRONG WITHOUT IT. A callback endpoint that accepts any code it is
 * handed will sign somebody in on the strength of a request they did not
 * make. An attacker completes a login with THEIR provider account, catches
 * the code, and gets a victim's browser to deliver it to our callback -- the
 * victim is now signed in as the attacker, and anything they go on to do, they
 * do in the attacker's account, where the attacker can read it afterwards.
 * KingsChat has no PKCE, so this token is the only thing standing there.
 *
 * WHY THE RETURN PATH IS STORED HERE RATHER THAN CARRIED IN THE TOKEN. The
 * value is echoed back by the provider verbatim, which makes it untrusted
 * input on arrival -- whatever we put in it, we get back whatever somebody
 * else chose to put in it. A path carried inside it is a redirect target
 * supplied by a stranger, which is an open redirect wearing our domain. So the
 * token is opaque and meaningless, and everything it stands for is held here,
 * where nobody else can reach it.
 *
 * SINGLE USE, and that is the point rather than a nicety. A token that can be
 * presented twice can be replayed, and replay is the attack above with an
 * extra step. `consume` deletes before it returns, with no await in between,
 * so two callbacks arriving together cannot both be told yes.
 */
import { randomBytes } from 'node:crypto';

/**
 * How long a login may take.
 *
 * Long enough for somebody to find their password, short enough that a token
 * caught in a log or a shoulder-surfed screen is dead by the time it is used.
 * Independent of the provider's own code lifetime -- theirs bounds the code,
 * this bounds the attempt.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * A ceiling on how many logins can be in flight at once.
 *
 * Without it, anybody can make us hold memory by starting logins and never
 * finishing them. When it is reached the OLDEST pending attempts are dropped,
 * which is the right way round: an attempt from twenty minutes ago is already
 * near expiry, while refusing new ones would turn a flood into an outage for
 * everybody trying to sign in.
 */
const DEFAULT_MAX_PENDING = 10_000;

export interface OAuthLoginAttempt {
  /** Which provider this attempt was started for. */
  readonly provider: 'google' | 'kingschat';
  /**
   * Where to send the person afterwards. A PATH within this application,
   * already validated by `issue`; never an absolute url.
   */
  readonly returnPath: string;
  readonly createdAtMs: number;
}

export interface OAuthStateOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  /** Overridable so tests can make collisions happen rather than hope. */
  readonly newToken?: () => string;
}

export class OAuthStateStore {
  private readonly pending = new Map<string, OAuthLoginAttempt>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly newToken: () => string;

  constructor(options: OAuthStateOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.newToken = options.newToken ?? (() => randomBytes(32).toString('base64url'));
  }

  /**
   * Begin a login and get the token to hand the provider.
   *
   * `returnPath` is normalised to a safe local path here, at the only moment
   * we are holding a value we chose ourselves. Validating it on the way back
   * instead would mean validating a string a stranger controls.
   */
  issue(provider: OAuthLoginAttempt['provider'], returnPath?: string): string {
    this.evictExpired();
    if (this.pending.size >= this.maxPending) this.evictOldest();

    const token = this.newToken();
    this.pending.set(token, {
      provider,
      returnPath: safeReturnPath(returnPath),
      createdAtMs: this.now(),
    });
    return token;
  }

  /**
   * Redeem a token exactly once.
   *
   * Returns null for a token we never issued, one that has expired, and one
   * already used -- deliberately the same answer for all three. Telling the
   * difference would say whether a given token was ever real, which is a
   * question only somebody guessing has reason to ask.
   */
  consume(token: string | null | undefined): OAuthLoginAttempt | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const attempt = this.pending.get(token);
    // Deleted whether or not it turns out to be expired: an expired token is
    // spent too, and leaving it would let a flood of dead tokens accumulate.
    this.pending.delete(token);
    if (!attempt) return null;
    if (attempt.createdAtMs + this.ttlMs <= this.now()) return null;
    return attempt;
  }

  /** How many logins are waiting. For a health surface, not for a decision. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, attempt] of this.pending) {
      if (attempt.createdAtMs <= cutoff) this.pending.delete(token);
    }
  }

  private evictOldest(): void {
    // Map preserves insertion order and `issue` only ever appends, so the
    // first entry is the oldest without sorting anything.
    const oldest = this.pending.keys().next();
    if (!oldest.done) this.pending.delete(oldest.value);
  }
}

/**
 * What the provider callback leaves behind for the page to collect.
 *
 * WHY A HANDOFF EXISTS AT ALL. The KingsChat callback is a form POST from the
 * browser to this server, so the sign-in completes on the server while the
 * person is looking at a page that knows nothing about it. Something has to
 * carry the result across that gap.
 *
 * WHY NOT JUST PUT THE SESSION TOKEN IN THE REDIRECT. Because the redirect
 * url is a url: it lands in browser history, and if anything on the way
 * follows a link it lands in a Referer header and somebody's access log. A
 * session token there is a working credential that outlives the moment. This
 * token is worth one exchange, within a minute, and is useless afterwards.
 *
 * WHY NOT A COOKIE. The apps hold their session in device storage and send it
 * as a bearer token; a cookie would be a second kind of session for one
 * surface, and two kinds of session eventually disagree about who is signed
 * in. The fragment also never reaches a server at all, which a cookie does on
 * every request.
 *
 * NO SESSION TOKEN IS STORED HERE. Only who to mint one for, and it is minted
 * at the moment of exchange, so nothing in this map is a credential.
 */
export interface SignInHandoff {
  readonly accountId: string;
  /**
   * The token version at sign-in.
   *
   * Carried so a sign-out-everywhere landing in the seconds between the
   * callback and the exchange invalidates this handoff too, rather than
   * minting a session from a version that has already been revoked.
   */
  readonly tokenVersion: number;
  readonly createdAtMs: number;
}

/** Sixty seconds: a page load, not a window of opportunity. */
const HANDOFF_TTL_MS = 60_000;

export class SignInHandoffStore {
  private readonly pending = new Map<string, SignInHandoff>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly newToken: () => string;

  constructor(options: OAuthStateOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? HANDOFF_TTL_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.newToken = options.newToken ?? (() => randomBytes(32).toString('base64url'));
  }

  issue(accountId: string, tokenVersion: number): string {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, held] of this.pending) {
      if (held.createdAtMs <= cutoff) this.pending.delete(token);
    }
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = this.newToken();
    this.pending.set(token, { accountId, tokenVersion, createdAtMs: this.now() });
    return token;
  }

  /** Redeem once. Unknown, expired and already-used are one answer. */
  consume(token: string | null | undefined): SignInHandoff | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const held = this.pending.get(token);
    this.pending.delete(token);
    if (!held) return null;
    if (held.createdAtMs + this.ttlMs <= this.now()) return null;
    return held;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Reduce an arbitrary string to a path inside this application, or to `/`.
 *
 * REFUSES rather than repairs, because every one of these shapes is a way to
 * leave our site while looking like we sent them:
 *
 *   https://evil.test/x   an absolute url
 *   //evil.test/x         protocol-relative; a browser treats it as absolute
 *   /\evil.test/x         some browsers normalise the backslash to a slash
 *   javascript:alert(1)   a scheme that runs rather than navigates
 *
 * Anything that is not plainly a single-slash local path becomes `/`, which
 * is always safe and never surprising.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (typeof value !== 'string') return '/';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return '/';
  // Must start with exactly one slash, and the next character must not be a
  // slash or a backslash -- that pair is what makes it absolute.
  if (!trimmed.startsWith('/')) return '/';
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return '/';
  /*
   * NO FRAGMENT. The callback appends `#c7_handoff=...` to this path, and a
   * path that already carries a `#` produces two of them. A browser folds
   * everything after the FIRST one into a single fragment, so the handoff
   * stops being a parameter the page can find and the sign-in silently
   * completes into a page that cannot see it.
   */
  if (trimmed.includes('#')) return '/';
  // No control characters, which can truncate or split a Location header.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '/';
  return trimmed;
}
