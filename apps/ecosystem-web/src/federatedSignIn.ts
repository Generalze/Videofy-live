/** @author masterzee001 */
/**
 * Signing in with Google or KingsChat, from the browser.
 *
 * The two providers do NOT share a shape, and pretending they did would make
 * both worse:
 *
 *   Google never leaves the page. Google's own script hands this page a
 *   signed ID token, we post it to the account service, and a session comes
 *   back in the reply.
 *
 *   KingsChat leaves and comes back. The person goes to
 *   accounts.kingschat.online, and their browser returns by POSTING a code to
 *   the account service -- not to this page. By the time this page loads
 *   again the sign-in has already happened somewhere it cannot see, and all
 *   that is left for it is a handoff in the url fragment.
 *
 * WHY THE FRAGMENT IS CLEARED IMMEDIATELY. A fragment is never sent to a
 * server, which is why the handoff is put there, but it does stay in the
 * address bar and in browser history. Clearing it with `replaceState` keeps
 * it out of the back button and out of anything the person copies out of the
 * url bar. The handoff is single-use and short-lived anyway -- this is the
 * second lock, not the only one.
 *
 * Everything in here is DOM-free except where it says otherwise, so the parts
 * worth getting right can be tested without a browser.
 */
import type { SessionResult } from './JoinC7';

/** Which providers this deployment actually has. */
export interface AvailableProviders {
  readonly google: boolean;
  readonly kingschat: boolean;
}

/** Nothing is offered until the service says it exists. */
export const NO_PROVIDERS: AvailableProviders = { google: false, kingschat: false };

export interface FederatedDeps {
  readonly accountUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const json = { 'content-type': 'application/json' } as const;

/**
 * Ask which buttons to draw.
 *
 * NEVER GUESSES. A failure answers "none", because a button drawn for a
 * provider that is off answers 503, and the person pressing it cannot tell
 * that from their own account being refused -- so they try again, and
 * conclude the fault is theirs. Showing nothing is honest; showing a dead
 * control is not.
 */
export async function fetchProviders(deps: FederatedDeps): Promise<AvailableProviders> {
  const call = deps.fetchImpl ?? fetch;
  try {
    const response = await call(`${deps.accountUrl}/oauth/providers`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return NO_PROVIDERS;
    const body = (await response.json()) as Partial<AvailableProviders>;
    // Strictly boolean: a service answering something unexpected must not be
    // read as a yes.
    return { google: body.google === true, kingschat: body.kingschat === true };
  } catch {
    return NO_PROVIDERS;
  }
}

/** What the provider row should actually put on screen. */
export interface ProviderRowPlan {
  readonly showRow: boolean;
  readonly showGoogle: boolean;
  readonly showKingsChat: boolean;
}

export const NOTHING_TO_SHOW: ProviderRowPlan = {
  showRow: false,
  showGoogle: false,
  showKingsChat: false,
};

/**
 * Decide the row, separately from drawing it.
 *
 * EXTRACTED SO THE SEAM IS TESTABLE, the same way `joinRequestBody` was: this
 * app renders without a DOM test harness, so a decision left inside a
 * component is a decision nothing checks. And this one is worth checking,
 * because its important behaviour is a negative: both switches ship off, so
 * for most of this feature's life the correct answer is "draw nothing", and
 * the way that breaks is a button added while somebody is in the file --
 * which then answers 503 to everybody who presses it.
 *
 * `null` providers means the question has not been answered yet. That is
 * also nothing, deliberately: a row that appears a second after the page
 * settles moves the submit button out from under somebody's cursor.
 */
export function providerRowPlan(
  providers: AvailableProviders | null,
  googleClientId: string | undefined,
): ProviderRowPlan {
  if (providers === null) return NOTHING_TO_SHOW;
  /*
   * Google needs a client id as well as a switch. Its own script draws the
   * button and cannot do it without one, so a slot rendered without a client
   * id is an empty box where a control should be.
   */
  const showGoogle =
    providers.google && typeof googleClientId === 'string' && googleClientId.trim().length > 0;
  const showKingsChat = providers.kingschat;
  return { showRow: showGoogle || showKingsChat, showGoogle, showKingsChat };
}

/** The handoff token in a url fragment, or null. */
export function readHandoff(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  const value = new URLSearchParams(raw).get('c7_handoff');
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The same fragment with the handoff removed.
 *
 * Preserves anything else that was in there: the return path may legitimately
 * carry an anchor, and dropping it would land somebody at the top of a page
 * they asked to arrive part-way down.
 */
export function hashWithoutHandoff(hash: string): string {
  /*
   * Untouched when there is nothing of ours in it. Round-tripping through
   * URLSearchParams rewrites a plain anchor: `#pricing` comes back as
   * `#pricing=`, which is a different anchor and matches nothing on the page.
   * Only a fragment we actually put something in gets rebuilt.
   */
  if (readHandoff(hash) === null) return hash;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  params.delete('c7_handoff');
  const rest = params.toString();
  return rest.length > 0 ? `#${rest}` : '';
}

/** What the account service sends back when a callback went wrong. */
export type SignInError =
  | 'expired'
  | 'unavailable'
  | 'cancelled'
  | 'no-email'
  | 'unverified-email-conflict'
  | 'account-already-linked'
  | 'account-not-created';

/**
 * Wording for a failed provider sign-in.
 *
 * The account service deliberately sends a REASON rather than a sentence,
 * because the redirect carrying it is a url and a url ends up in history and
 * in logs. The sentence lives here.
 */
export function describeSignInError(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'expired':
      return 'That sign-in took too long or was already used. Please try again.';
    case 'cancelled':
      return 'That sign-in was not completed.';
    case 'unavailable':
      return 'We could not complete that sign-in just now. Please try again shortly.';
    case 'no-email':
      // KingsChat shares an address only once the person has verified it there.
      return 'Your KingsChat email address is not verified yet, so KingsChat did not share it with us. Verify your email in the KingsChat app and try again, or create a C7 account with your email and password.';
    case 'unverified-email-conflict':
      /*
       * The careful one. It must NOT say whether an account exists for that
       * address -- that would turn this into a way to ask -- while still
       * telling somebody who genuinely has one what to do next.
       */
      return 'We could not use that to sign you in. If you already have a C7 account, sign in the way you usually do and connect it from your settings.';
    case 'account-already-linked':
      return 'That C7 account is already connected to a different account with this provider.';
    case 'account-not-created':
      return 'We could not open your account just now. Please try again shortly.';
    default:
      return 'That sign-in could not be completed. Please try again.';
  }
}

/**
 * Exchange a handoff for a session.
 *
 * Returns null when there is no handoff, which is the ordinary case on every
 * page load that is not a return from KingsChat -- an absent handoff is not
 * an error and must not be reported as one.
 */
export async function completeHandoff(
  deps: FederatedDeps & { readonly hash: string },
): Promise<SessionResult | null> {
  const handoff = readHandoff(deps.hash);
  if (handoff === null) return null;

  const call = deps.fetchImpl ?? fetch;
  const response = await call(`${deps.accountUrl}/oauth/handoff`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ handoff }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as SessionResult;
  if (typeof body.token !== 'string' || typeof body.accountId !== 'string') return null;
  return body;
}

export type GoogleSignInResult =
  | { readonly ok: true; readonly session: SessionResult }
  | { readonly ok: false; readonly reason: string };

/** Post a Google ID token and get a session. */
export async function signInWithGoogle(
  deps: FederatedDeps & { readonly idToken: string },
): Promise<GoogleSignInResult> {
  const call = deps.fetchImpl ?? fetch;
  try {
    const response = await call(`${deps.accountUrl}/oauth/google`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ idToken: deps.idToken }),
    });
    const body = (await response.json().catch(() => ({}))) as SessionResult & { error?: string };
    if (!response.ok) {
      return { ok: false, reason: body.error ?? 'That sign-in could not be completed.' };
    }
    if (typeof body.token !== 'string' || typeof body.accountId !== 'string') {
      return { ok: false, reason: 'That sign-in could not be completed.' };
    }
    return { ok: true, session: body };
  } catch {
    return { ok: false, reason: 'Could not reach C7 right now.' };
  }
}

/**
 * Ask the account service where to send somebody for KingsChat.
 *
 * The url is BUILT BY THE SERVER, which holds the client id and issues the
 * CSRF token that has to come back with the code. A url assembled here would
 * be one this page invented, and the callback would refuse it -- correctly.
 */
export async function kingsChatLoginUrl(
  deps: FederatedDeps & { readonly returnPath?: string },
): Promise<string | null> {
  const call = deps.fetchImpl ?? fetch;
  const query =
    deps.returnPath === undefined ? '' : `?returnPath=${encodeURIComponent(deps.returnPath)}`;
  try {
    const response = await call(`${deps.accountUrl}/oauth/kingschat/start${query}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { authorizationUrl?: unknown };
    return typeof body.authorizationUrl === 'string' ? body.authorizationUrl : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Below here touches the DOM.
 * ------------------------------------------------------------------ */

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback: (response: { credential?: string }) => void;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }): void;
      renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoad: Promise<GoogleIdentityServices | null> | null = null;

/**
 * Load Google's sign-in script, once, and only when it is wanted.
 *
 * LAZY ON PURPOSE. This is third-party code with the run of the page, so it
 * is not on every visit to the site -- only where somebody is actually being
 * offered the button. A failure resolves to null rather than throwing: the
 * page still has a password form, and a blocked script must not take the
 * whole sign-in panel down with it.
 */
export function loadGoogleIdentityServices(): Promise<GoogleIdentityServices | null> {
  if (gsiLoad) return gsiLoad;
  gsiLoad = new Promise<GoogleIdentityServices | null>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const existing = (window as unknown as { google?: GoogleIdentityServices }).google;
    if (existing?.accounts?.id) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () =>
      resolve((window as unknown as { google?: GoogleIdentityServices }).google ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return gsiLoad;
}

/** Remove the handoff from the address bar without reloading or adding history. */
export function scrubHandoffFromUrl(): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  const { pathname, search, hash } = window.location;
  if (readHandoff(hash) === null) return;
  // replaceState, not pushState: the url with the handoff in it must not
  // become a place the back button can return to.
  window.history.replaceState(null, '', `${pathname}${search}${hashWithoutHandoff(hash)}`);
}
