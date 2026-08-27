/** @author masterzee001 */
/**
 * The browser session, in ONE place for this app.
 *
 * Two keys hold one session -- `c7.session` (this app's original bare token)
 * and `videofy-account:session` (the shape call-web and operator-web read).
 * Every write and every clear must touch BOTH: clearing one leaves the other
 * signed in, which is worse than clearing neither, because the person believes
 * they have left while a product surface still holds their credential.
 *
 * This module exists so the nav, the shell and the join flow stop each keeping
 * their own copy of that knowledge. The cross-APP unification (call-web and
 * operator-web read the key directly too) remains the recorded follow-up.
 */

const TOKEN_KEY = 'c7.session';
const SHARED_KEY = 'videofy-account:session';

export function readSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearSessionKeys(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(SHARED_KEY);
  } catch {
    /* storage unavailable; nothing was persisted */
  }
}

export function hasSession(): boolean {
  return readSessionToken() !== null;
}

/**
 * Sign out of this browser, then land on the homepage.
 *
 * LOCAL FIRST AND UNCONDITIONALLY, the same contract as everywhere else:
 * somebody tapping sign out on a flaky connection must end up signed out HERE.
 * The server call revokes the session everywhere and is best-effort.
 */
export async function signOutEverywhere(accountUrl: string): Promise<void> {
  const token = readSessionToken();
  clearSessionKeys();
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
