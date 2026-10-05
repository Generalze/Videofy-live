/** @author masterzee001 */
/**
 * Signing in with Google or KingsChat, on the phone.
 *
 * TWO PROVIDERS, TWO MECHANISMS, AND THE REASON IS NOT PREFERENCE.
 *
 *   Google has a native path. The phone asks Google directly, gets a signed
 *   ID token back, and posts it to the account service. Nothing leaves the
 *   app except the token, and the account service verifies it against
 *   Google's published keys.
 *
 *   KingsChat has no usable native path for us. Their mobile route is a
 *   CocoaPods / JitPack SDK that would need a config plugin, Kotlin and
 *   Swift -- none of which can be proven without spending an APK build. It
 *   is not needed: their callback url is fixed per application and cannot be
 *   supplied at request time, so the phone opens the SAME web login in a
 *   system browser, the SAME registered callback receives the code, and the
 *   account service sends the result back through this app's url scheme
 *   because the login attempt recorded that a phone started it. One
 *   application, one review, no native SDK.
 *
 * WHY A SYSTEM BROWSER AND NOT A WEBVIEW. An embedded webview would let this
 * app read what somebody types into a provider's login form. Google refuses
 * OAuth from one outright for that reason, and it would be the wrong thing
 * to do even where it is allowed.
 */
import * as AuthSession from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

/**
 * Required once, at module load, so a completed browser session hands control
 * back to the app instead of leaving somebody staring at a finished page.
 */
WebBrowser.maybeCompleteAuthSession();

/** The scheme in app.json. The account service is configured with the same one. */
export const APP_SCHEME = 'videofy';

export type ProviderSignInOutcome =
  | { readonly ok: true; readonly kind: 'google'; readonly idToken: string }
  | { readonly ok: true; readonly kind: 'handoff'; readonly handoff: string }
  | { readonly ok: false; readonly reason: ProviderSignInFailure };

export type ProviderSignInFailure =
  /** They closed the browser or pressed back. Not an error to apologise for. */
  | 'cancelled'
  /** This deployment does not offer that provider. */
  | 'unavailable'
  /** The provider or the network let us down. */
  | 'failed';

/** Which providers the account service actually has switched on. */
export interface AvailableProviders {
  readonly google: boolean;
  readonly kingschat: boolean;
}

export const NO_PROVIDERS: AvailableProviders = { google: false, kingschat: false };

/**
 * Ask which buttons to draw.
 *
 * ANY FAILURE MEANS NONE. A button drawn for a provider that is off answers
 * 503, and on a phone that reads as a tap that did nothing -- so the person
 * taps it again. Showing nothing is honest; showing a dead control is not.
 */
export async function fetchProviders(
  accountBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableProviders> {
  try {
    const response = await fetchImpl(`${accountBaseUrl}/oauth/providers`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return NO_PROVIDERS;
    const body = (await response.json()) as Partial<AvailableProviders>;
    // Strictly boolean: an unexpected answer must not read as a yes.
    return { google: body.google === true, kingschat: body.kingschat === true };
  } catch {
    return NO_PROVIDERS;
  }
}

/**
 * The handoff carried on a url the app was opened with.
 *
 * The account service puts it in the FRAGMENT, which no server ever receives.
 * `Linking`-delivered urls keep it, so the same placement that protects it on
 * the web protects it here.
 */
export function readHandoffFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const hash = url.indexOf('#');
  if (hash === -1) return null;
  const value = new URLSearchParams(url.slice(hash + 1)).get('c7_handoff');
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The failure reason on a url the app was opened with, if any. */
export function readErrorFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const query = url.indexOf('?');
  if (query === -1) return null;
  const end = url.indexOf('#', query);
  const search = url.slice(query + 1, end === -1 ? undefined : end);
  const value = new URLSearchParams(search).get('error');
  return value !== null && value.length > 0 ? value : null;
}

/**
 * Run the KingsChat login in a system browser and bring the result back.
 *
 * The url is BUILT BY THE SERVER. It holds the client id and issues the CSRF
 * token that has to come back with the code; a url assembled here would be
 * one this app invented, and the callback would refuse it -- correctly.
 */
export async function signInWithKingsChat(
  accountBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderSignInOutcome> {
  let authorizationUrl: string;
  try {
    const response = await fetchImpl(
      // `client=device` is what records that a phone started this, so the
      // callback returns through the app scheme rather than to a web page.
      `${accountBaseUrl}/oauth/kingschat/start?client=device`,
      { headers: { accept: 'application/json' } },
    );
    if (response.status === 503) return { ok: false, reason: 'unavailable' };
    if (!response.ok) return { ok: false, reason: 'failed' };
    const body = (await response.json()) as { authorizationUrl?: unknown };
    if (typeof body.authorizationUrl !== 'string') return { ok: false, reason: 'failed' };
    authorizationUrl = body.authorizationUrl;
  } catch {
    return { ok: false, reason: 'failed' };
  }

  try {
    const result = await WebBrowser.openAuthSessionAsync(
      authorizationUrl,
      `${APP_SCHEME}://auth`,
    );
    if (result.type !== 'success') {
      // dismiss and cancel are both somebody changing their mind.
      return { ok: false, reason: 'cancelled' };
    }
    const handoff = readHandoffFromUrl(result.url);
    if (handoff === null) return { ok: false, reason: 'failed' };
    return { ok: true, kind: 'handoff', handoff };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * The Google client ids, per platform.
 *
 * PUBLIC, and compiled into the bundle on purpose. What protects the Android
 * one is the signing certificate registered beside it -- an APK signed with
 * any other key cannot use it -- and the iOS one is bound to the bundle id.
 * Secrecy protects neither, which is why they are `EXPO_PUBLIC_`.
 */
export const GOOGLE_CLIENT_IDS = {
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
} as const;

/**
 * Whether a Google button can work at all on this build.
 *
 * Checked before anything is drawn. Without a client id the request fails at
 * Google with an error the person cannot act on, which on a phone looks like
 * a button that does nothing.
 */
export function googleConfigured(): boolean {
  return GOOGLE_CLIENT_IDS.android.length > 0 || GOOGLE_CLIENT_IDS.ios.length > 0;
}

/**
 * The Google request configuration, for `Google.useIdTokenAuthRequest`.
 *
 * ID TOKEN, not an access token. We want to know who somebody is and nothing
 * else: no Google API is called, no scope beyond identity is asked for, and
 * nothing is stored that could be used against their Google account later.
 */
export function googleAuthRequestConfig(): Parameters<typeof Google.useIdTokenAuthRequest>[0] {
  return {
    ...(GOOGLE_CLIENT_IDS.android ? { androidClientId: GOOGLE_CLIENT_IDS.android } : {}),
    ...(GOOGLE_CLIENT_IDS.ios ? { iosClientId: GOOGLE_CLIENT_IDS.ios } : {}),
    /*
     * The web client id goes in as well, and it is not a mistake. Google
     * mints the ID TOKEN with the web client as its audience when one is
     * given, and that is the audience the account service checks first --
     * see C7_GOOGLE_WEB_CLIENT_ID. All three are accepted there, so this is
     * belt and braces rather than a requirement.
     */
    ...(GOOGLE_CLIENT_IDS.web ? { webClientId: GOOGLE_CLIENT_IDS.web } : {}),
    scopes: ['openid', 'profile', 'email'],
  };
}

/** The redirect this app claims, for diagnostics and for tests. */
export function appRedirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: APP_SCHEME, path: 'auth' });
}

/**
 * Wording for a failed provider sign-in.
 *
 * `cancelled` returns null deliberately: somebody who pressed back has not
 * had anything go wrong, and an error banner for their own decision is the
 * app arguing with them.
 */
export function describeProviderFailure(reason: ProviderSignInFailure): string | null {
  switch (reason) {
    case 'cancelled':
      return null;
    case 'unavailable':
      return 'That way of signing in is not available right now.';
    case 'failed':
      return 'That sign-in could not be completed. Please try again.';
  }
}
