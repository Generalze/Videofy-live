/** @author masterzee001 */
/**
 * Choosing the sign-in providers from configuration, once, at startup.
 *
 * Modelled on `provider-selection.ts` in @videofy-live/account-trust and
 * obeying the same ruling: an unrecognised name throws, a selected provider
 * with a missing value throws, and it all happens before anything looks
 * healthy.
 *
 * WHERE THIS DELIBERATELY DIFFERS, and why. For the verification providers an
 * UNSET switch means `synthetic`, never `off`, because switching verification
 * off silently would let a deployment believe it had verified somebody. Here
 * an unset switch means OFF, and that is safe for the opposite reason: there
 * is no synthetic sign-in to fall back to, and the worst an accidental `off`
 * can do is leave a button out of the page. Nobody gets signed in wrongly;
 * they sign in the way they already could. Being wrong in that direction
 * costs a feature, while being wrong in the other direction costs an account.
 *
 * WHAT `on` COSTS. Everything the provider needs must be present or startup
 * fails. A half-configured provider would put a button in front of people
 * that cannot work, and they have no way to tell a broken deployment from a
 * rejected account -- so they retry, and blame themselves.
 */
import { GoogleIdTokenVerifier } from './google-id-token.js';
import { KingsChatIdentity } from './kingschat-identity.js';

export class FederatedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederatedConfigurationError';
  }
}

export interface FederatedSignInEnv {
  readonly C7_GOOGLE_SIGN_IN?: string;
  readonly C7_GOOGLE_WEB_CLIENT_ID?: string;
  readonly C7_GOOGLE_ANDROID_CLIENT_ID?: string;
  readonly C7_GOOGLE_IOS_CLIENT_ID?: string;

  readonly C7_KINGSCHAT_SIGN_IN?: string;
  readonly C7_KINGSCHAT_BASE_URL?: string;
  readonly C7_KINGSCHAT_API_KEY?: string;
  readonly C7_KINGSCHAT_WEB_CLIENT_ID?: string;
  readonly C7_KINGSCHAT_ANDROID_CLIENT_ID?: string;
  readonly C7_KINGSCHAT_IOS_CLIENT_ID?: string;
}

/** Which application a callback or token belongs to. */
export type ClientPlatform = 'web' | 'android' | 'ios';

export interface FederatedProviders {
  /** Null when Google sign-in is off on this deployment. */
  readonly google: GoogleIdTokenVerifier | null;
  /**
   * One per platform, because a KingsChat client id identifies an
   * APPLICATION, not a project -- the web callback must redeem its code with
   * the web application's id or their token endpoint refuses it.
   */
  readonly kingschat: ReadonlyMap<ClientPlatform, KingsChatIdentity> | null;
}

export interface FederatedSelectionOptions {
  readonly fetchImpl?: typeof fetch;
  readonly warn?: (message: string) => void;
  /** Reports what was selected, so a deployment can be read from its log. */
  readonly onSelected?: (summary: string) => void;
}

export function createFederatedProviders(
  env: FederatedSignInEnv,
  options: FederatedSelectionOptions = {},
): FederatedProviders {
  const google = createGoogle(env, options);
  const kingschat = createKingsChat(env, options);

  /*
   * Said out loud at INFO, at startup, for both states.
   *
   * An `off` provider that logs nothing is indistinguishable from one that is
   * on and broken, and this codebase has already spent four outages on the
   * difference between a guard that did not fire and a guard whose log nobody
   * could see. "Off" is a sentence here, not an absence.
   */
  options.onSelected?.(
    `federated sign-in: google=${google === null ? 'off' : `on (${google.audienceCount} client ids)`}, ` +
      `kingschat=${kingschat === null ? 'off' : `on (${[...kingschat.keys()].join(', ')})`}`,
  );

  return { google, kingschat };
}

function switchValue(raw: string | undefined, name: string): boolean {
  const selected = (raw ?? 'off').trim().toLowerCase();
  if (selected === 'off' || selected === '') return false;
  if (selected === 'on') return true;
  /*
   * A typo must never resolve to a default. `C7_GOOGLE_SIGN_IN=true` reading
   * as `off` would be a provider silently absent; reading as `on` would be a
   * value we never agreed to honour. Neither: refuse and name it.
   */
  throw new FederatedConfigurationError(
    `${name}="${selected}" is not a value. Use "on" or "off".`,
  );
}

function required(value: string | undefined, name: string, provider: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) {
    throw new FederatedConfigurationError(
      `${provider} sign-in is on but ${name} is not set. Refusing to start rather than ` +
        `showing a sign-in button that cannot work.`,
    );
  }
  return trimmed;
}

function createGoogle(
  env: FederatedSignInEnv,
  options: FederatedSelectionOptions,
): (GoogleIdTokenVerifier & { audienceCount: number }) | null {
  if (!switchValue(env.C7_GOOGLE_SIGN_IN, 'C7_GOOGLE_SIGN_IN')) return null;

  /*
   * Every client id we hold is an acceptable audience, because the same
   * account service answers the browser, the Android app and the iOS app, and
   * each platform's token names its own client id.
   *
   * The WEB one is required and the mobile ones are not: a deployment can
   * legitimately have no mobile apps yet, but a Google verifier with no
   * audiences at all accepts every token on earth -- which is why the
   * verifier itself also refuses to be built that way, rather than trusting
   * this function to have got it right.
   */
  const audiences = [
    required(env.C7_GOOGLE_WEB_CLIENT_ID, 'C7_GOOGLE_WEB_CLIENT_ID', 'Google'),
    ...[env.C7_GOOGLE_ANDROID_CLIENT_ID, env.C7_GOOGLE_IOS_CLIENT_ID]
      .map((value) => (value ?? '').trim())
      .filter((value) => value.length > 0),
  ];

  const verifier = new GoogleIdTokenVerifier({
    audiences,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // Carried alongside so the startup line can say how many without this
  // module reaching into the verifier's private state.
  return Object.assign(verifier, { audienceCount: audiences.length });
}

function createKingsChat(
  env: FederatedSignInEnv,
  options: FederatedSelectionOptions,
): ReadonlyMap<ClientPlatform, KingsChatIdentity> | null {
  if (!switchValue(env.C7_KINGSCHAT_SIGN_IN, 'C7_KINGSCHAT_SIGN_IN')) return null;

  // One project-wide key for every application, which is exactly why it must
  // never leave this process.
  const apiKey = required(env.C7_KINGSCHAT_API_KEY, 'C7_KINGSCHAT_API_KEY', 'KingsChat');
  const baseUrl = (env.C7_KINGSCHAT_BASE_URL ?? '').trim();

  const clients: Array<[ClientPlatform, string | undefined]> = [
    ['web', env.C7_KINGSCHAT_WEB_CLIENT_ID],
    ['android', env.C7_KINGSCHAT_ANDROID_CLIENT_ID],
    ['ios', env.C7_KINGSCHAT_IOS_CLIENT_ID],
  ];

  const built = new Map<ClientPlatform, KingsChatIdentity>();
  for (const [platform, clientId] of clients) {
    const trimmed = (clientId ?? '').trim();
    // Web is required for the same reason as Google's: the callback this
    // service exposes is a web callback, and without it the feature is on
    // with nothing able to use it.
    if (trimmed.length === 0) {
      if (platform === 'web') {
        required(clientId, 'C7_KINGSCHAT_WEB_CLIENT_ID', 'KingsChat');
      }
      continue;
    }
    built.set(
      platform,
      new KingsChatIdentity({
        clientId: trimmed,
        apiKey,
        ...(baseUrl.length > 0 ? { baseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.warn ? { warn: options.warn } : {}),
      }),
    );
  }
  return built;
}
