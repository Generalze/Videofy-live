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
 * NO REFRESH, BECAUSE THE SERVER HAS NONE. `POST /sessions` returns a token
 * with `expiresInSeconds` and there is no refresh endpoint anywhere in the
 * account service. Inventing one here -- a silent re-authentication, a cached
 * password, a long-lived secondary credential -- would be building an
 * authentication protocol the server does not implement, in the client, where
 * it cannot be enforced. When the session ends the person signs in again.
 *
 * (Worth stating plainly: sessions last twelve hours, so that is a daily
 * sign-in on a phone. That is a server-side product decision, and the right
 * place to fix it is the server, not a workaround here.)
 *
 * ONE OWNER OF THE CREDENTIAL. Nothing outside this module reads the token.
 * Callers ask for an authenticated request; they never ask for the secret.
 */
import type { SecureSessionStore, StoredSession } from './secureSessionStore';

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
        body: JSON.stringify({ email, password }),
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

    let body: SessionResponse;
    try {
      body = (await response.json()) as SessionResponse;
    } catch {
      return { ok: false, reason: 'server' };
    }

    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresInSeconds =
      typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 0;

    // A 200 that does not carry a usable session is a server problem, and
    // storing the fragments would turn it into a client problem later.
    if (accountId === '' || token === '' || expiresInSeconds <= 0) {
      return { ok: false, reason: 'server' };
    }

    const session: StoredSession = {
      accountId,
      token,
      expiresInSeconds,
      receivedAtMs: this.now(),
    };
    await this.store.write(session);
    this.session = session;
    this.set({ status: 'signed-in', accountId });
    return { ok: true };
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
