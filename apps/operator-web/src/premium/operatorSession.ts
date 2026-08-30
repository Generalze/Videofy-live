/** @author masterzee001 */
/**
 * The browser session, in ONE place for the console.
 *
 * Founder report (30 Aug 2026): the console said "Not signed in" and
 * "Gateway Disconnected" while she WAS signed in on the site. Two keys hold
 * one session in this browser -- `c7.session` (the site's original bare
 * token) and `videofy-account:session` (the `{accountId, token}` shape the
 * call app and this console read) -- and until now three files each read one
 * of them their own way. This module is the single reader and writer, so the
 * console can sign somebody in itself and every surface on the origin sees
 * the same result.
 *
 * The token is read, written and cleared here. It is never logged, never put
 * in an error message and never handed to anything but the account service
 * (as a bearer) and the gateway (as socket auth).
 */

/** The shape the call app and this console read. */
export const SHARED_SESSION_KEY = 'videofy-account:session';
/** The site's original bare token, still read by its verify and shell pages. */
export const BARE_SESSION_KEY = 'c7.session';

export interface OperatorSession {
  /** Null when only the bare token was found; the account service knows who it is. */
  readonly accountId: string | null;
  readonly token: string;
}

export interface WritableSession {
  readonly accountId: string;
  readonly token: string;
  readonly voiceGender?: string | undefined;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let storageListenerAttached = false;

function storage(): Storage | null {
  try {
    // `typeof` rather than `window.`: this also runs under node in tests.
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function parseShared(raw: string | null): OperatorSession | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { accountId?: unknown; token?: unknown };
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return { accountId: typeof parsed.accountId === 'string' && parsed.accountId.length > 0 ? parsed.accountId : null, token: parsed.token };
  } catch {
    return null;
  }
}

/**
 * The session this browser holds, or null.
 *
 * The shared key wins. A bare token found ONLY under the site's key is
 * accepted and rewritten into the shared shape (without an account id, which
 * a bare token does not carry), so the next reader finds it where it looks.
 */
export function readSession(): OperatorSession | null {
  const store = storage();
  if (store === null) return null;
  try {
    const shared = parseShared(store.getItem(SHARED_SESSION_KEY));
    if (shared !== null) return shared;
    const bare = store.getItem(BARE_SESSION_KEY);
    if (bare === null || bare.length === 0) return null;
    try {
      store.setItem(SHARED_SESSION_KEY, JSON.stringify({ token: bare }));
    } catch {
      /* read-only storage: the bare token is still a session */
    }
    return { accountId: null, token: bare };
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* one listener's failure is not another's */
    }
  }
}

/** Sign in here: BOTH keys the site uses, so every surface on this origin agrees. */
export function writeSession(session: WritableSession): void {
  const store = storage();
  if (store !== null) {
    try {
      store.setItem(BARE_SESSION_KEY, session.token);
      store.setItem(
        SHARED_SESSION_KEY,
        JSON.stringify({
          accountId: session.accountId,
          token: session.token,
          ...(session.voiceGender !== undefined ? { voiceGender: session.voiceGender } : {}),
        }),
      );
    } catch {
      /* storage unavailable; the session simply does not persist */
    }
  }
  notify();
}

/** Sign out here: both keys, so the site stops looking signed in too. */
export function clearSession(): void {
  const store = storage();
  if (store !== null) {
    try {
      store.removeItem(BARE_SESSION_KEY);
      store.removeItem(SHARED_SESSION_KEY);
    } catch {
      /* nothing was persisted */
    }
  }
  notify();
}

/* ------------------------------------------------------------ the account service */

export type SignInResult = { readonly ok: true; readonly session: WritableSession } | { readonly ok: false; readonly message: string };

export interface SignInDeps {
  readonly accountUrl: string;
  readonly email: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export const SIGN_IN_MISMATCH = 'That email address and password do not match.';
export const SIGN_IN_UNREACHABLE = 'Could not reach C7.';
const SIGN_IN_LOCKED_FALLBACK = 'Too many attempts. Try again in a few minutes.';

function servedError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

/**
 * POST <account>/sessions {email, password}, mapped onto what the dialog can
 * say. The result never carries the response beyond the parsed session.
 */
export async function signIn({ accountUrl, email, password, fetchImpl }: SignInDeps): Promise<SignInResult> {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) return { ok: false, message: SIGN_IN_UNREACHABLE };
  let response: Response;
  try {
    response = await doFetch(`${accountUrl.replace(/\/$/, '')}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, message: SIGN_IN_UNREACHABLE };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 401) return { ok: false, message: SIGN_IN_MISMATCH };
  if (response.status === 429) return { ok: false, message: servedError(body) ?? SIGN_IN_LOCKED_FALLBACK };
  if (!response.ok) return { ok: false, message: servedError(body) ?? `C7 answered ${response.status}.` };
  const record = typeof body === 'object' && body !== null ? (body as { accountId?: unknown; token?: unknown; voiceGender?: unknown }) : {};
  if (typeof record.accountId !== 'string' || record.accountId.length === 0 || typeof record.token !== 'string' || record.token.length === 0) {
    return { ok: false, message: 'C7 answered with a session this console could not read.' };
  }
  return {
    ok: true,
    session: {
      accountId: record.accountId,
      token: record.token,
      ...(typeof record.voiceGender === 'string' ? { voiceGender: record.voiceGender } : {}),
    },
  };
}

/**
 * DELETE <account>/sessions with the bearer, then clear the browser. Local
 * first would be the call app's contract; here the token is needed for the
 * request, so the order is request-then-clear, and the clear is unconditional.
 */
export async function signOut({ accountUrl, token, fetchImpl }: { readonly accountUrl: string; readonly token: string | null; readonly fetchImpl?: typeof fetch | undefined }): Promise<void> {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (token !== null && doFetch !== undefined) {
    try {
      await doFetch(`${accountUrl.replace(/\/$/, '')}/sessions`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      /* signed out here regardless; the server session ages out */
    }
  }
  clearSession();
}

function onStorage(event: StorageEvent): void {
  // A null key is `localStorage.clear()` from another tab.
  if (event.key === null || event.key === SHARED_SESSION_KEY || event.key === BARE_SESSION_KEY) notify();
}

/**
 * Hear about the session changing: another tab signing in or out (the
 * window "storage" event, which never fires in the tab that wrote) and this
 * tab's own writeSession/clearSession. Returns the unsubscribe.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', onStorage);
    storageListenerAttached = true;
  }
  return () => {
    listeners.delete(listener);
  };
}
