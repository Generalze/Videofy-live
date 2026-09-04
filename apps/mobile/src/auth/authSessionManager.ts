/** @author masterzee001 */
/**
 * Who is signed in, and the only thing that decides it.
 *
 * THE SERVER OWNS THE ANSWER. A stored token that has not expired is not a
 * valid session: `GET /sessions/current` is the only endpoint that checks the
 * token's `ver` against the account, which is what makes "sign out everywhere"
 * real. A client that trusted its own expiry arithmetic would keep a revoked
 * session alive for up to twelve hours after somebody revoked it -- which is
 * exactly the window an account recovery is trying to close.
 *
 * A DEVICE SESSION, UNTIL SIGN-OUT (founder ruling 29 Aug 2026). The phone
 * signs in as `client: 'device'` and receives a 180-day token; while the app
 * is used it renews (`POST /sessions/renew`, the server hands back the same
 * class), so the session lasts until the person signs out. No cached
 * password, no secondary credential: renewal presents the live token and
 * the server's version check still ends a revoked session on the next
 * launch. What stands in front of a long token on a lost phone is the app
 * lock (`appLock.ts`): one hour idle, then biometrics or the password.
 *
 * ONE OWNER OF THE CREDENTIAL. Nothing outside this module reads the token.
 * Callers ask for an authenticated request; they never ask for the secret.
 */
import type { SecureSessionStore, StoredSession } from './secureSessionStore';

/** Renew once the device session has under thirty days left. */
const RENEW_WHEN_REMAINING_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthState =
  | { readonly status: 'starting' }
  | { readonly status: 'signed-out'; readonly reason?: SignedOutReason }
  | { readonly status: 'validating' }
  | { readonly status: 'signed-in'; readonly accountId: string };

/**
 * Why somebody is signed out, when it was not simply their choice.
 *
 * Separated because they mean different things to a person: `expired` and
 * `revoked` are both "sign in again", but `revoked` means somebody ended this
 * session deliberately and the person may want to know that.
 */
export type SignedOutReason = 'never-signed-in' | 'signed-out' | 'expired' | 'revoked';

export interface SignUpResult {
  readonly ok: boolean;
  /**
   * `taken` covers BOTH a used email address and a used username, and merging
   * them is deliberate. Separating them would let anybody discover which
   * addresses and which handles are registered by trying them -- the same
   * account-existence oracle sign-in refuses to be, arriving through the
   * registration door instead.
   */
  readonly reason?: 'taken' | 'invalid' | 'rate-limited' | 'network' | 'server';
  /**
   * The server's own sentence, when it gave one -- "Use at least 12
   * characters", "A C7 username starts with c7 and a letter…". A screen that
   * collapses those into "check the details" sends a person guessing which
   * of three fields is wrong (founder hit this registering on the phone).
   */
  readonly message?: string;
}

export interface SignInResult {
  readonly ok: boolean;
  /**
   * Deliberately coarse.
   *
   * A sign-in failure must not distinguish "no such account" from "wrong
   * password": the pair is an account-existence oracle for anybody willing to
   * iterate addresses. The server already answers both identically; this
   * preserves that rather than reconstructing the distinction from a status
   * code.
   */
  readonly reason?: 'invalid-credentials' | 'rate-limited' | 'network' | 'server';
}

interface SessionResponse {
  accountId?: unknown;
  token?: unknown;
  expiresInSeconds?: unknown;
}

export interface AuthSessionManagerOptions {
  readonly accountBaseUrl: string;
  readonly store: SecureSessionStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onState?: (state: AuthState) => void;
}

export class AuthSessionManager {
  private readonly baseUrl: string;
  private readonly store: SecureSessionStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onState: ((state: AuthState) => void) | undefined;

  private state: AuthState = { status: 'starting' };
  private session: StoredSession | null = null;
  /**
   * Guards against a second sign-in starting while one is in flight.
   *
   * Two taps on a button is not a rare event on a phone -- it is what happens
   * when the first tap appears to do nothing. Without this, two sign-ins race
   * to write the store and the loser's token can overwrite the winner's.
   */
  private inFlight: Promise<SignInResult> | null = null;

  constructor(options: AuthSessionManagerOptions) {
    this.baseUrl = options.accountBaseUrl;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.onState = options.onState;
  }

  current(): AuthState {
    return this.state;
  }

  private set(state: AuthState): void {
    this.state = state;
    this.onState?.(state);
  }

  /**
   * Rehydrate on launch, then ASK THE SERVER.
   *
   * The local expiry check below is an optimisation and nothing more: a token
   * that has certainly expired is not worth a network round trip. A token that
   * has NOT expired still gets validated, because only the server knows whether
   * it was revoked.
   */
  async restore(): Promise<AuthState> {
    this.set({ status: 'validating' });
    const stored = await this.store.read();

    if (stored === null) {
      this.set({ status: 'signed-out', reason: 'never-signed-in' });
      return this.state;
    }

    const ageSeconds = (this.now() - stored.receivedAtMs) / 1000;
    if (ageSeconds >= stored.expiresInSeconds) {
      await this.store.clear();
      this.session = null;
      this.set({ status: 'signed-out', reason: 'expired' });
      return this.state;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/sessions/current`, {
        headers: { authorization: `Bearer ${stored.token}` },
      });
    } catch {
      /*
       * OFFLINE IS NOT SIGNED OUT. A phone in a lift must not lose its session
       * and force a sign-in when the network returns. The credential is kept
       * and the app stays in `validating` until the server can be reached.
       */
      this.session = stored;
      this.set({ status: 'validating' });
      return this.state;
    }

    if (response.ok) {
      this.session = stored;
      this.set({ status: 'signed-in', accountId: stored.accountId });
      return this.state;
    }

    /*
     * The server refused it: expired, or revoked by a sign-out elsewhere. Local
     * state is cleared either way -- a token the server will not accept must
     * not sit on the device pretending otherwise.
     */
    await this.store.clear();
    this.session = null;
    this.set({ status: 'signed-out', reason: response.status === 401 ? 'revoked' : 'expired' });
    return this.state;
  }

  /**
   * Create an account and take the session it returns.
   *
   * `POST /accounts` answers 201 with the same body as sign-in, so a new
   * account is signed in immediately. Everything else matches sign-in exactly:
   * nothing is persisted on failure, concurrent attempts join rather than race,
   * and the password is never stored.
   */
  async signUp(email: string, password: string, username: string): Promise<SignUpResult> {
    if (this.inFlight !== null) {
      // Joins whatever is already running rather than starting a second
      // account creation, which the server would answer with a conflict.
      const joined = await this.inFlight;
      return joined.ok ? { ok: true } : { ok: false, reason: 'server' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, username, client: 'device' }),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (!response.ok) {
      let message: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown; retryAfterMs?: unknown };
        if (typeof body.error === 'string' && body.error.length > 0) message = body.error;
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const minutes = retryAfter ? Math.max(1, Math.ceil(Number(retryAfter) / 60)) : null;
          message = minutes === null ? message : `Too many attempts. Try again in ${minutes} min.`;
        }
      } catch {
        // No JSON body: the reason word below is all we know.
      }
      return {
        ok: false,
        reason: response.status === 409 ? 'taken'
          : response.status === 429 ? 'rate-limited'
          : response.status === 400 ? 'invalid'
          : 'server',
        ...(message === undefined ? {} : { message }),
      };
    }

    const stored = await this.storeSessionFrom(response);
    return stored ? { ok: true } : { ok: false, reason: 'server' };
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    // Concurrent taps join the first attempt rather than starting a second.
    if (this.inFlight !== null) return this.inFlight;

    const attempt = this.performSignIn(email, password);
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = null;
    }
  }

  private async performSignIn(email: string, password: string): Promise<SignInResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, client: 'device' }),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (!response.ok) {
      /*
       * NOTHING IS PERSISTED ON FAILURE. A partial write here would leave a
       * credential-shaped value on the device that no server will accept, and
       * the next launch would spend a round trip discovering that.
       */
      return {
        ok: false,
        reason: response.status === 429 ? 'rate-limited'
          : response.status === 401 ? 'invalid-credentials'
          : 'server',
      };
    }

    return (await this.storeSessionFrom(response)) ? { ok: true } : { ok: false, reason: 'server' };
  }

  /**
   * Take a session out of a response and become signed in, or refuse.
   *
   * Shared by sign-in and sign-up because both are handed the identical body,
   * and because the refusal below must be identical too: a success status that
   * does not carry a usable session is a SERVER problem, and storing the
   * fragments would turn it into a client problem on the next launch.
   */
  private async storeSessionFrom(response: Response): Promise<boolean> {
    let body: SessionResponse;
    try {
      body = (await response.json()) as SessionResponse;
    } catch {
      return false;
    }

    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresInSeconds =
      typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 0;
    if (accountId === '' || token === '' || expiresInSeconds <= 0) return false;

    const session: StoredSession = {
      accountId,
      token,
      expiresInSeconds,
      receivedAtMs: this.now(),
    };
    await this.store.write(session);
    this.session = session;
    this.set({ status: 'signed-in', accountId });
    return true;
  }

  /**
   * Sign out. LOCAL STATE IS CLEARED WHETHER OR NOT THE SERVER IS TOLD.
   *
   * The network call is best-effort: it revokes the session everywhere, which
   * matters. But a person tapping sign-out on a train must end up signed out on
   * this device regardless, so the local clear happens first and nothing is
   * allowed to prevent it.
   */
  async signOut(): Promise<void> {
    const token = this.session?.token;

    await this.store.clear();
    this.session = null;
    this.set({ status: 'signed-out', reason: 'signed-out' });

    if (token === undefined) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/sessions`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // Already signed out locally. The server session ages out on its own.
    }
  }

  /**
   * The raw session token, for the ONE protocol that needs it in a payload.
   *
   * THIS IS A DELIBERATE EXCEPTION and is named so it can be found. Everything
   * else asks for an authenticated REQUEST via `authorizedFetch`, and that
   * remains the rule -- a caller that can hold the token can copy it somewhere
   * less careful.
   *
   * The call gateway is different in kind, not in convenience: `call:join`
   * carries `sessionToken` INSIDE a Socket.IO payload, because the gateway
   * derives the account from it and refuses to let a client name an account
   * itself. There is no header to attach it to, so there is nothing for
   * `authorizedFetch` to wrap.
   *
   * Returns null when signed out, which is a legitimate call state: joining an
   * existing call needs no session, only CREATING one does.
   */
  /**
   * Renew the device session while it is used, so it lasts until sign-out.
   *
   * Called on every foreground. Nothing happens until the token has under
   * thirty days left, so a phone used daily renews about five times a year
   * and a phone left in a drawer simply ages out. A refusal is NOT a
   * sign-out: `GET /sessions/current` on the next launch is the one
   * authority on that, as ever.
   */
  async renewIfNeeded(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    const remainingMs = this.sessionExpiresAtMs()! - this.now();
    if (remainingMs > RENEW_WHEN_REMAINING_MS) return;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/sessions/renew`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}` },
      });
    } catch {
      return;
    }
    if (!response.ok || this.session !== session) return;
    await this.storeSessionFrom(response);
  }

  /** When the current session stops being valid, in wall-clock ms; null when signed out. */
  sessionExpiresAtMs(): number | null {
    const session = this.session;
    if (session === null) return null;
    return session.receivedAtMs + session.expiresInSeconds * 1000;
  }

  callSessionToken(): string | null {
    return this.session?.token ?? null;
  }

  /**
   * Perform a request as the signed-in account.
   *
   * THE TOKEN IS NEVER RETURNED, only used. This is what keeps ownership in one
   * place: a caller that could ask for the credential would eventually store a
   * copy of it somewhere less careful.
   */
  async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
    const token = this.session?.token;
    if (token === undefined) return null;

    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });

    /*
     * A 401 ENDS THE SESSION, here, once. Leaving it to each caller means one
     * caller eventually treats it as a transient failure and retries forever
     * against a credential the server has already rejected.
     */
    if (response.status === 401) {
      await this.store.clear();
      this.session = null;
      this.set({ status: 'signed-out', reason: 'revoked' });
    }
    return response;
  }
}
