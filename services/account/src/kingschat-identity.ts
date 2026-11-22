/** @author masterzee001 */
/**
 * Turning a KingsChat authorization code into a verified identity.
 *
 * WHY THIS LOOKS NOTHING LIKE THE GOOGLE VERIFIER. Google hands the browser a
 * signed assertion we can check locally and be done. KingsChat hands us a
 * code, which is a claim about nothing until we redeem it, so the proof here
 * is the round trip itself: only a caller holding our api key can turn a code
 * into a profile, and the profile comes from KingsChat rather than from the
 * client.
 *
 * WHAT CARRIES THE WEIGHT, given there is NO CLIENT SECRET. Their token
 * exchange takes `grant_type`, `client_id` and `code` -- nothing that proves
 * the caller is us, so a code intercepted in flight is redeemable by whoever
 * holds it. Four things close that, and only two of them are ours:
 *
 *   1. THEIRS, and the strongest of the four: the redirect url is fixed when
 *      the application is registered and cannot be supplied at request time.
 *      A code can only ever be delivered to the endpoint we registered, so
 *      there is no way to ask them to send one somewhere else.
 *   2. THEIRS: codes are single use and expire -- an hour under Form POST,
 *      five minutes under Redirect delivery, which is why Form POST is
 *      registered on both web applications.
 *   3. OURS: Form POST means the code arrives in a request body, so it never
 *      touches a URL, browser history, a Referer header or an access log.
 *   4. OURS: the CSRF check at the callback, which is NOT in this file -- see
 *      `oauth-state.ts`. There is no PKCE here, so it is the only thing tying
 *      a callback to a login somebody actually started.
 *
 * NOTE ON NAMING, because it is a trap. The CSRF parameter is called `origin`
 * in their API, not `state`. It is an arbitrary string we attach to the login
 * url and they echo back verbatim -- which also makes it UNTRUSTED INPUT on
 * arrival. It is an opaque token here and never a redirect target; putting a
 * path in it and following that path is an open redirect with our own domain
 * in front of it.
 *
 * The api key never leaves this process. It is a PROJECT-wide secret shared
 * by all four applications, so leaking it into an APK or a browser bundle
 * would hand over every one of them at once.
 */

/** Where their API lives. Deliberately not the developer portal's host. */
export const DEFAULT_KINGSCHAT_BASE_URL = 'https://connect.kingsch.at';

/** Their documented ceiling on a request body, which bounds what we read. */
const MAX_RESPONSE_BYTES = 1_048_576;

export type KingsChatVerification =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly email: string | null;
      readonly emailVerified: boolean;
      readonly displayName: string | null;
      /** Their handle, without the @. Not an identifier we join on. */
      readonly username: string | null;
    }
  | { readonly ok: false; readonly reason: KingsChatRefusal };

export type KingsChatRefusal =
  /** The code was missing, already used, expired, or issued for another client. */
  | 'code-rejected'
  /** Our client id is unknown to them, or the application is not approved. */
  | 'client-rejected'
  /** Our api key is missing or wrong -- our misconfiguration, not their problem. */
  | 'api-key-rejected'
  /** They have the token but will not give us the profile. */
  | 'profile-unavailable'
  /** A profile with no id is not an identity we can join on. */
  | 'no-subject'
  /** We could not reach them, or they answered with something unreadable. */
  | 'provider-unavailable';

export interface KingsChatIdentityOptions {
  /** The client id of the application whose redirect url received the code. */
  readonly clientId: string;
  /** The PROJECT api key. Never logged, never returned, never sent anywhere else. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Said out loud when THEY fail, so an outage at their end is visible here
   * rather than showing up only as people unable to sign in.
   */
  readonly warn?: (message: string) => void;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in_millis?: unknown;
}

interface ProfileResponse {
  profile?: {
    id?: unknown;
    name?: unknown;
    username?: unknown;
    email?: unknown;
    is_email_verified?: unknown;
  };
}

export class KingsChatIdentity {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly warn: (message: string) => void;

  constructor(private readonly options: KingsChatIdentityOptions) {
    if (options.clientId.trim().length === 0) {
      throw new Error('KingsChatIdentity: a client id is required');
    }
    if (options.apiKey.trim().length === 0) {
      /*
       * Refused at construction rather than at the first sign-in. An empty
       * api key produces a 401 from their profile endpoint, which would
       * surface to people as "sign-in is broken" long after the deploy that
       * caused it -- and would look like THEIR outage, not our missing line.
       */
      throw new Error('KingsChatIdentity: an api key is required to read a profile');
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_KINGSCHAT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * The application's client id, which the login url has to carry.
   *
   * Public because it is public: it travels in the url the browser is sent
   * to, so anyone using the app can read it. The api key beside it is not,
   * and is deliberately not exposed anywhere on this class.
   */
  get clientId(): string {
    return this.options.clientId.trim();
  }

  /**
   * Redeem the code and read who it belongs to.
   *
   * The code is used exactly once here and never written down. Their codes
   * are single-use at their end too, so a stored code is at best useless and
   * at worst a credential sitting in our logs.
   */
  async verify(code: string): Promise<KingsChatVerification> {
    if (code.trim().length === 0) return { ok: false, reason: 'code-rejected' };

    const token = await this.exchange(code.trim());
    if (typeof token !== 'string') return { ok: false, reason: token.reason };

    return this.readProfile(token);
  }

  private async exchange(
    code: string,
  ): Promise<string | { readonly reason: KingsChatRefusal }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/developer/api/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'code',
          client_id: this.options.clientId,
          code,
        }),
      });
    } catch {
      this.warn('kingschat: token exchange could not reach the provider');
      return { reason: 'provider-unavailable' };
    }

    if (!response.ok) {
      /*
       * 403 is `invalid_client`: our client id is unknown or the application
       * is not approved. That is OUR configuration, and reporting it as a bad
       * code would send somebody to try signing in again forever against a
       * deployment that can never succeed.
       */
      if (response.status === 403) {
        this.warn('kingschat: the provider refused our client id (unknown or unapproved)');
        return { reason: 'client-rejected' };
      }
      // 422 is a missing, expired, reused, or wrong-client code.
      if (response.status === 422) return { reason: 'code-rejected' };
      this.warn(`kingschat: token exchange answered ${response.status}`);
      return { reason: 'provider-unavailable' };
    }

    const body = await readJson<TokenResponse>(response);
    if (body === null) return { reason: 'provider-unavailable' };
    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    if (accessToken.length === 0) {
      this.warn('kingschat: token exchange succeeded but carried no access token');
      return { reason: 'provider-unavailable' };
    }
    return accessToken;
  }

  private async readProfile(accessToken: string): Promise<KingsChatVerification> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/developer/api/user/profile`, {
        method: 'GET',
        headers: {
          // Both are required: the project api key AND this person's token.
          'api-key': this.options.apiKey,
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      });
    } catch {
      this.warn('kingschat: profile read could not reach the provider');
      return { ok: false, reason: 'provider-unavailable' };
    }

    if (!response.ok) {
      if (response.status === 401) {
        /*
         * Their 401 covers both a bad api key and an expired access token. We
         * just minted that token seconds ago, so in practice this is our key.
         * Said out loud for that reason -- it is a deployment fault that will
         * otherwise read as every KingsChat user suddenly being rejected.
         *
         * THEIR ERROR CODE IS KEPT. The first live refusal said only "check
         * the api key", and the body -- which names whether it was the key or
         * the bearer -- had been thrown away. The code is a short identifier
         * (e.g. invalid_api_key); the message is prose they may reword, and
         * neither carries a credential.
         */
        const detail = await readJson<{ error?: unknown; message?: unknown }>(response.clone());
        const code = typeof detail?.error === 'string' ? detail.error.slice(0, 64) : 'no-code';
        this.warn(`kingschat: profile read was refused (${code}) -- check the project api key`);
        return { ok: false, reason: 'api-key-rejected' };
      }
      if (response.status === 403 || response.status === 404) {
        return { ok: false, reason: 'profile-unavailable' };
      }
      this.warn(`kingschat: profile read answered ${response.status}`);
      return { ok: false, reason: 'provider-unavailable' };
    }

    const body = await readJson<ProfileResponse>(response);
    if (body === null || typeof body.profile !== 'object' || body.profile === null) {
      return { ok: false, reason: 'provider-unavailable' };
    }
    const profile = body.profile;

    const subject = typeof profile.id === 'string' ? profile.id.trim() : '';
    if (subject.length === 0) return { ok: false, reason: 'no-subject' };

    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    const username = typeof profile.username === 'string' ? profile.username.trim() : '';

    return {
      ok: true,
      subject,
      email: email.length > 0 ? email : null,
      /*
       * Strictly true. Their field is documented as a boolean, but the string
       * "false" is truthy, and a truthy read here would mark an unproven
       * address proven -- which is precisely the input the linking rule
       * exists to refuse. Absent means no.
       */
      emailVerified: profile.is_email_verified === true,
      displayName: name.length > 0 ? name : null,
      username: username.length > 0 ? username : null,
    };
  }
}

/**
 * Read a JSON body, bounded.
 *
 * An unbounded read of somebody else's response is an unbounded allocation
 * driven by somebody else, and their own gateway already refuses bodies past
 * this size -- so anything larger is not a response we should be parsing.
 */
async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
