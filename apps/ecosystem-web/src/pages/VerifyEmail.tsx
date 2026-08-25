/**
 * The page the verification link lands on.
 *
 * WHY IT EXISTS. The email has always built a link to /app/verify-email/, and
 * nothing served it: every /app/* path fell through to the shell, the token in
 * the query string was ignored, and the account stayed unverified forever. The
 * only test covering any of this pinned the link STRING, which is why the gap
 * survived — a URL nobody serves passes a test that only checks how it is spelt.
 *
 * WHY IT ASKS PEOPLE TO SIGN IN. The server scopes confirmation to the caller:
 * `confirmEmail(accountId, token)` reads the challenge stored on the signed-in
 * account. So the token alone cannot complete verification, and this page
 * cannot pretend otherwise. Somebody who signed up on a laptop and opened the
 * mail on their phone must sign in there to finish — real friction, honestly
 * described rather than hidden behind a spinner that never resolves.
 *
 * The token is kept across that sign-in, so they do not have to go back to the
 * inbox and click again. It is held in sessionStorage rather than localStorage
 * deliberately: it is a single-use credential with minutes to live, and it
 * should not outlive the tab that received it.
 */
import { useEffect, useState } from 'react';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/+$/, '');

/** Where the sign-in flow stores the session. Shared with the shell. */
const SESSION_KEY = 'c7.session';
/** Where a token waits while somebody signs in to finish. */
const PENDING_KEY = 'c7.pending-email-token';

function storedToken(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * The token from the link, or the one stashed before a sign-in.
 *
 * Read from the query string FIRST: arriving with a fresh link should always
 * beat a stale one left over from an abandoned attempt in the same tab.
 */
function linkToken(): string | null {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

function rememberToken(token: string): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, token);
  } catch {
    // A browser with storage disabled simply loses the convenience; the person
    // can still click the link again from the inbox.
  }
}

function forgetToken(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clean up */
  }
}

type Outcome =
  | { readonly kind: 'working' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'sign-in-required' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed'; readonly message: string };

export function VerifyEmail({ onDone }: { readonly onDone: () => void }) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });

  useEffect(() => {
    const token = linkToken();
    if (token === null) {
      setOutcome({ kind: 'no-token' });
      return;
    }

    const session = storedToken();
    if (session === null) {
      // Hold it so finishing does not mean returning to the inbox.
      rememberToken(token);
      setOutcome({ kind: 'sign-in-required' });
      return;
    }

    let cancelled = false;
    void fetch(`${ACCOUNT_URL}/verification/email/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) {
          forgetToken();
          setOutcome({ kind: 'verified' });
          return;
        }
        if (response.status === 401) {
          // The stored session expired between opening the mail and this
          // request. Keep the token and ask for a sign-in rather than
          // reporting the link as broken, which it is not.
          rememberToken(token);
          setOutcome({ kind: 'sign-in-required' });
          return;
        }
        /*
         * The server deliberately returns ONE message for expired, wrong and
         * already-used, so that somebody probing links cannot learn which of
         * their guesses was closest. This page must not invent a more specific
         * one to be helpful -- that would undo the defence from the outside.
         */
        forgetToken();
        setOutcome({
          kind: 'failed',
          message: 'That verification link is not valid or has expired.',
        });
      })
      .catch(() => {
        if (cancelled) return;
        // A network failure is NOT a bad link. Saying so would send somebody
        // to request a new email that they do not need.
        setOutcome({
          kind: 'failed',
          message: 'C7 could not be reached. Check your connection and open the link again.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="app-gate">
      <div className="shell app-gate-shell">
        <p className="eyebrow">Consummate 7</p>
        {outcome.kind === 'working' ? (
          <>
            <h1 className="app-title">Verifying your email address…</h1>
            <p className="section-lede">One moment.</p>
          </>
        ) : null}

        {outcome.kind === 'verified' ? (
          <>
            <h1 className="app-title">Your email address is verified</h1>
            <p className="section-lede">
              Your C7 account is ready. You can start and join calls across the ecosystem.
            </p>
            <p>
              <button type="button" className="button button-primary" onClick={onDone}>
                Continue to C7
              </button>
            </p>
          </>
        ) : null}

        {outcome.kind === 'sign-in-required' ? (
          <>
            <h1 className="app-title">Sign in to finish</h1>
            <p className="section-lede">
              You are not signed in on this device. Sign in and your address will be verified
              automatically — you do not need to open the link again.
            </p>
            <p>
              <button type="button" className="button button-primary" onClick={onDone}>
                Sign in
              </button>
            </p>
          </>
        ) : null}

        {outcome.kind === 'no-token' ? (
          <>
            <h1 className="app-title">This link is incomplete</h1>
            <p className="section-lede">
              Open the link in your email exactly as it was sent. Some mail apps shorten long
              links; copying it into your browser instead usually works.
            </p>
          </>
        ) : null}

        {outcome.kind === 'failed' ? (
          <>
            <h1 className="app-title">That link did not work</h1>
            <p className="section-lede">{outcome.message}</p>
            <p className="section-lede">
              Verification links can be used once and expire after about thirty minutes. Sign in
              and request a new one.
            </p>
            <p>
              <button type="button" className="button button-primary" onClick={onDone}>
                Go to C7
              </button>
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Whether this request is the verification landing.
 *
 * Matched with and without the trailing slash, because both get linked, typed
 * and pasted, and a mail client that strips the slash must not produce a page
 * that silently does nothing.
 */
export function isVerifyEmailPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === '/app/verify-email';
}

/** Whether a token is waiting to be completed after a sign-in. */
export function pendingEmailToken(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}
