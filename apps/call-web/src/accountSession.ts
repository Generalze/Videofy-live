// The signed-in account, and how the browser remembers it.
//
// This replaces the `devid_` value that used to be minted here. That identity
// was scoped to a browser profile rather than a person: two people sharing one
// browser shared one voice, and the same person on a second device could not
// find theirs. For something that authorises speaking in somebody's voice, the
// subject was simply wrong.
//
// Signing in is required to enrol a voice and NOT to join a call. Translation
// is the product; a personal voice is a thing you opt into, and putting a login
// wall in front of joining a conversation would be charging everybody for a
// feature most of them are not using.
//
// The token is held in localStorage. That is readable by any script running on
// this origin, so it is not where a bearer token belongs in production — an
// httpOnly cookie is — and it is recorded here rather than discovered later.
// It survives a reload deliberately: being signed out by refreshing a page is
// the kind of thing that makes people write their password on a note.
import { parseAccountId } from '@videofy-live/participant-contracts';

export interface AccountSession {
  readonly accountId: string;
  readonly token: string;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const ACCOUNT_SESSION_STORAGE_KEY = 'videofy-account:session';

export function defaultSessionStorage(): SessionStorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage access itself throws in some privacy modes.
    return null;
  }
}

/**
 * The stored session, or null. Never invents one.
 *
 * A stored value that is not a session — or names something that is not an
 * account id — is treated as absent rather than trusted, because it did not
 * come from here.
 */
export function readAccountSession(storage: SessionStorageLike | null): AccountSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACCOUNT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccountSession>;
    const accountId = parseAccountId(parsed.accountId);
    if (!accountId || typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return { accountId, token: parsed.token };
  } catch {
    return null;
  }
}

export function writeAccountSession(
  storage: SessionStorageLike | null,
  session: AccountSession,
): void {
  try {
    storage?.setItem(ACCOUNT_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A session that cannot be stored still works for this page. Failing the
    // sign-in over it would be worse than forgetting it on reload.
  }
}

export function clearAccountSession(storage: SessionStorageLike | null): void {
  try {
    storage?.removeItem(ACCOUNT_SESSION_STORAGE_KEY);
  } catch {
    // Nothing to do: failing to forget is not worth breaking a call over.
  }
}

export type AccountResult =
  | { readonly ok: true; readonly session: AccountSession }
  | { readonly ok: false; readonly message: string };

export interface AccountClient {
  register(input: { email: string; password: string }): Promise<AccountResult>;
  signIn(input: { email: string; password: string }): Promise<AccountResult>;
  signOut(session: AccountSession): Promise<void>;
}

export function readAccountUrl(): string {
  return import.meta.env['VITE_ACCOUNT_URL'] ?? 'http://localhost:3006';
}

async function submit(url: string, input: { email: string; password: string }): Promise<AccountResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as {
      accountId?: string;
      token?: string;
      error?: string;
    };
    if (!response.ok) {
      // The server's wording is used as-is. It is deliberately identical for a
      // wrong password and an unknown address, and rephrasing it here could
      // reintroduce the distinction it exists to hide.
      return { ok: false, message: body.error ?? 'That did not work. Try again.' };
    }
    const accountId = parseAccountId(body.accountId);
    if (!accountId || !body.token) {
      return { ok: false, message: 'That did not work. Try again.' };
    }
    return { ok: true, session: { accountId, token: body.token } };
  } catch {
    return { ok: false, message: 'Could not reach the account service. Check your connection.' };
  }
}

export function createAccountClient(baseUrl: string = readAccountUrl()): AccountClient {
  return {
    register: (input) => submit(`${baseUrl}/accounts`, input),
    signIn: (input) => submit(`${baseUrl}/sessions`, input),
    async signOut(session) {
      try {
        // Signs out everywhere, not just here. For an account that authorises
        // speaking in your voice, "sign out" meaning "on this laptop only" is
        // the weaker and more surprising reading.
        await fetch(`${baseUrl}/sessions`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${session.token}` },
        });
      } catch {
        // The local session is cleared by the caller regardless: a network
        // failure must not leave somebody unable to sign out of this browser.
      }
    },
  };
}

/** The Authorization header for a request that must prove who is calling. */
export function authorizationHeader(session: AccountSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}
