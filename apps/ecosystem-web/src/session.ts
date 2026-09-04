/** @author masterzee001 */
/**
 * The browser session, in ONE place for this app.
 *
 * Two keys hold one session -- `c7.session` (this app's original bare token)
 * and `videofy-account:session` (the `{accountId, token, voiceGender?}` shape
 * call-web and operator-web read). Every write and every clear touches BOTH:
 * clearing one leaves the other signed in, which is worse than clearing
 * neither, because the person believes they have left while a product surface
 * still holds their credential.
 *
 * This module is the ONLY reader and the ONLY writer of those keys in this
 * app. The join flow, the nav, the shell and the verification landing all
 * come through here. The last time each kept its own copy of the key name,
 * the operator console and the public site disagreed about whether somebody
 * was signed in at all.
 *
 * PRESENCE IS NOT VALIDITY. `hasSession` says a token is STORED, and that is
 * all it says: a token outlives its twelve-hour lifetime in localStorage
 * indefinitely, and a browser that signed in on ANOTHER origin never had one
 * here. Both look identical to a key check. The founder's screenshot -- the
 * operator console saying "not signed in" while the site said she was -- is
 * exactly a stored token the server no longer honours. `validateSession` is
 * the part that asks, and on a refusal it clears both keys so every surface
 * on this origin tells the same story.
 *
 * The cross-APP unification (call-web and operator-web read the shared key
 * with their own readers) remains the recorded follow-up.
 */

const TOKEN_KEY = 'c7.session';
const SHARED_KEY = 'videofy-account:session';
/**
 * Set for THIS TAB when the server refused a stored session, so the signed-out
 * state that follows can say "your session has ended" once instead of greeting
 * a returning person as a stranger. Session storage, not local: the notice
 * belongs to the tab that lost the session and must not outlive it.
 */
const ENDED_KEY = 'c7.session-ended';

/** The shape every browser surface on this origin reads. */
export interface BrowserSession {
  readonly accountId: string;
  readonly token: string;
  /** Stated at sign-up; the call form starts on it. Absent means not stated. */
  readonly voiceGender?: 'male' | 'female';
}

/** The slice of Storage this module uses; tests pass an in-memory one. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): SessionStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage access itself throws in some privacy modes.
    return null;
  }
}

function tabStore(): SessionStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The stored session, or null. Never invents one.
 *
 * A stored value that is not the shared shape is treated as absent rather
 * than trusted, because it did not come from here. The legacy bare token is
 * deliberately NOT enough for this reader: without an account id it is not a
 * session the other surfaces can use. `readSessionToken` still honours it, so
 * a browser that signed in before the shared key existed is not signed out by
 * an upgrade, and `validateSession` promotes it the first time the server
 * confirms it.
 */
export function readSession(
  storage: SessionStorageLike | null = localStore(),
): BrowserSession | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(SHARED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { accountId, token, voiceGender } = parsed as Record<string, unknown>;
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    if (typeof token !== 'string' || token.length === 0) return null;
    return {
      accountId,
      token,
      ...(voiceGender === 'male' || voiceGender === 'female' ? { voiceGender } : {}),
    };
  } catch {
    return null;
  }
}

/** The stored token, from the shared shape first and the legacy bare key second. */
export function readSessionToken(storage: SessionStorageLike | null = localStore()): string | null {
  const session = readSession(storage);
  if (session !== null) return session.token;
  if (storage === null) return null;
  try {
    const bare = storage.getItem(TOKEN_KEY);
    return bare !== null && bare.length > 0 ? bare : null;
  } catch {
    return null;
  }
}

/** Store the session under both keys. The only place either key is set. */
export function writeSession(
  session: BrowserSession,
  storage: SessionStorageLike | null = localStore(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(TOKEN_KEY, session.token);
    storage.setItem(
      SHARED_KEY,
      JSON.stringify({
        accountId: session.accountId,
        token: session.token,
        ...(session.voiceGender ? { voiceGender: session.voiceGender } : {}),
      }),
    );
  } catch {
    /* storage unavailable; the session simply does not persist */
  }
}

/** Forget the session here. The only place either key is removed. */
export function clearSession(storage: SessionStorageLike | null = localStore()): void {
  if (storage === null) return;
  try {
    storage.removeItem(TOKEN_KEY);
    storage.removeItem(SHARED_KEY);
  } catch {
    /* storage unavailable; nothing was persisted */
  }
}

/** Whether a session is STORED. Synchronous, and silent about validity. */
export function hasSession(storage: SessionStorageLike | null = localStore()): boolean {
  return readSessionToken(storage) !== null;
}

/**
 * The stored session is gone because the server refused it, not because the
 * person left. Clears both keys and leaves the one-time notice for this tab.
 */
export function expireSession(
  storage: SessionStorageLike | null = localStore(),
  tab: SessionStorageLike | null = tabStore(),
): void {
  clearSession(storage);
  if (tab === null) return;
  try {
    tab.setItem(ENDED_KEY, '1');
  } catch {
    /* the notice is a courtesy; the sign-out itself already happened */
  }
}

/** True ONCE after an expiry in this tab; the read consumes the flag. */
export function consumeSessionEndedNotice(tab: SessionStorageLike | null = tabStore()): boolean {
  if (tab === null) return false;
  try {
    if (tab.getItem(ENDED_KEY) === null) return false;
    tab.removeItem(ENDED_KEY);
    return true;
  } catch {
    return false;
  }
}

export type SessionValidity = 'valid' | 'expired' | 'offline' | 'absent';

export interface ValidateSessionOptions {
  readonly storage?: SessionStorageLike | null;
  readonly tab?: SessionStorageLike | null;
  readonly fetch?: typeof fetch;
}

/**
 * Ask the account service whether the stored session is still honoured.
 *
 *   valid    the server knows this token. If only a legacy bare token was
 *            stored, the shared shape is filled in from the answer.
 *   expired  the server refused it (401/403): aged out, revoked by "sign out
 *            everywhere", or minted by a different deployment. BOTH keys are
 *            cleared and the one-time notice is left for this tab.
 *   offline  the service could not be reached, or answered with a server
 *            error. Nothing changes: a flaky proxy is not a sign-out.
 *   absent   nothing is stored, so nothing was asked.
 *
 * Only a refusal signs anybody out. The two failure modes need opposite
 * responses -- an expired token must go so every surface agrees, and an
 * unreachable server must NOT take the session with it.
 */
export async function validateSession(
  accountUrl: string,
  options: ValidateSessionOptions = {},
): Promise<SessionValidity> {
  const storage = options.storage === undefined ? localStore() : options.storage;
  const tab = options.tab === undefined ? tabStore() : options.tab;
  const token = readSessionToken(storage);
  if (token === null) return 'absent';
  const request =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await request(`${accountUrl}/sessions/current`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return 'offline';
  }
  if (response.status === 401 || response.status === 403) {
    expireSession(storage, tab);
    return 'expired';
  }
  if (!response.ok) return 'offline';
  if (readSession(storage) === null) {
    // A bare legacy token the server just confirmed becomes the shared shape,
    // so the call and operator surfaces stop disagreeing with this one.
    try {
      const body = (await response.json()) as { accountId?: unknown; voiceGender?: unknown };
      if (typeof body.accountId === 'string' && body.accountId.length > 0) {
        writeSession(
          {
            accountId: body.accountId,
            token,
            ...(body.voiceGender === 'male' || body.voiceGender === 'female'
              ? { voiceGender: body.voiceGender }
              : {}),
          },
          storage,
        );
      }
    } catch {
      /* still valid; the shared shape is filled in next time */
    }
  }
  return 'valid';
}

/**
 * Sign out of this browser, then land on the homepage.
 *
 * LOCAL FIRST AND UNCONDITIONALLY, the same contract as everywhere else:
 * somebody tapping sign out on a flaky connection must end up signed out HERE.
 * The server call revokes the session everywhere and is best-effort. This is
 * a chosen exit, so it leaves no "session ended" notice behind.
 */
export async function signOutEverywhere(accountUrl: string): Promise<void> {
  const token = readSessionToken();
  clearSession();
  if (token !== null) {
    try {
      await fetch(`${accountUrl}/sessions`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      /* already signed out locally; the server session ages out */
    }
  }
  window.location.assign('/');
}
