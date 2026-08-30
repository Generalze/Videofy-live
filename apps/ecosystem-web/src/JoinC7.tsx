/** @author masterzee001 */
/**
 * The way into the ecosystem.
 *
 * ONE C7 account, against the existing account service. There is deliberately
 * no Videofy account, no Sentinel account and no "Chairman account": identity
 * is global to C7, and what somebody may do inside a conference is a separate,
 * session-scoped question answered by the conference authority. Build a second
 * account system per product and the first thing that happens is somebody has
 * two of them.
 *
 * This is an ENTRY POINT, not a dashboard. It signs you in and tells you so.
 * The authenticated shell is intentionally small until there is something real
 * to put behind it.
 */
import { useEffect, useState } from 'react';
import { writeSession, type SessionStorageLike } from './session';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/$/, '');

type Mode = 'create' | 'signin' | 'reset';

export interface SessionResult {
  readonly accountId?: string;
  readonly token?: string;
  /*
   * Returned by the account service so the call form can start somebody on the
   * voice they chose at sign-up instead of defaulting everybody to the same
   * one. Declared here because it is passed straight through to the session the
   * call app reads -- dropping it silently would be a preference quietly lost.
   */
  readonly voiceGender?: 'male' | 'female';
}

/**
 * What each mode sends to the account service.
 *
 * EXTRACTED SO THE SEAM IS TESTABLE. Registration was impossible for everybody
 * because this object was built inline as `{ email, password }` while the form
 * above it collected a C7 username, explained what it was for, and bound it to
 * state. `POST /accounts` requires the username and answers "Choose a C7
 * username." without it -- which reads as a complaint about the field the person
 * has just filled in, so the natural response is to keep editing a value that
 * was never the problem. Both halves were correct; nothing joined them.
 *
 * Sign-in deliberately does NOT carry one. An account is identified by its
 * address, and accepting a username there would be a second way to name the
 * same person for no benefit.
 */
export function joinRequestBody(
  mode: 'create' | 'signin',
  email: string,
  password: string,
  username: string,
): Record<string, string> {
  return mode === 'create' ? { email, password, username } : { email, password };
}

/**
 * Store what the account service answered, in the ONE place sessions live.
 *
 * Through `session.ts` and nowhere else. This form used to write the two keys
 * itself, which is how the site and the operator console came to disagree
 * about whether somebody was signed in: each surface owned its own copy of
 * the key names and shape. A body without a token or an account id is not a
 * session -- nothing is written and the caller hears so -- because a
 * half-written session (bare token, no id) looks signed in here and signed
 * out everywhere else, which is exactly the defect being closed.
 *
 * Extracted, and given an injectable storage, so the seam between the sign-in
 * answer and what the shared readers expect is pinned by a test rather than
 * rediscovered in a screenshot.
 */
export function persistJoinSession(
  body: SessionResult,
  storage?: SessionStorageLike | null,
): boolean {
  if (typeof body.token !== 'string' || body.token.length === 0) return false;
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) return false;
  writeSession(
    {
      accountId: body.accountId,
      token: body.token,
      ...(body.voiceGender === 'male' || body.voiceGender === 'female'
        ? { voiceGender: body.voiceGender }
        : {}),
    },
    storage,
  );
  return true;
}

/**
 * `sessionEnded` is the shell telling this form WHY somebody is looking at
 * it: their stored session was refused by the server. The form opens on
 * sign-in and says so once, because "Create C7 account" offered to a person
 * who was signed in a minute ago reads as the site having forgotten them.
 */
export function JoinC7({ sessionEnded = false }: { readonly sessionEnded?: boolean } = {}) {
  const [mode, setMode] = useState<Mode>(sessionEnded ? 'signin' : 'create');
  useEffect(() => {
    // The verdict arrives asynchronously, after the first render.
    if (sessionEnded) setMode('signin');
  }, [sessionEnded]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /*
   * CHOSEN AT REGISTRATION, not afterwards. Left until later people forget, and
   * an account with no handle exists but cannot be added by anybody. The `c7`
   * prefix is supplied by the field rather than typed, so it can never be
   * forgotten, doubled or mistyped.
   */
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResult | null>(null);
  /** Set once a reset has been asked for. Never says whether the address existed. */
  const [resetAsked, setResetAsked] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      /*
       * A RESET NEVER REPORTS WHETHER THE ADDRESS EXISTS. The server answers
       * 202 to everything for that reason, and this shows the same
       * acknowledgement whatever comes back -- including an error. Anything
       * else turns the form into a "does this person have an account here"
       * oracle that anybody can query as often as they like.
       */
      if (mode === 'reset') {
        await fetch(`${ACCOUNT_URL}/accounts/password-reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }).catch(() => undefined);
        setResetAsked(true);
        return;
      }

      const response = await fetch(`${ACCOUNT_URL}/${mode === 'create' ? 'accounts' : 'sessions'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(joinRequestBody(mode, email, password, username)),
      });
      const body = (await response.json().catch(() => ({}))) as SessionResult & { error?: string };
      if (!response.ok) {
        // The service's own wording. It is deliberately careful about not
        // distinguishing a wrong password from an unknown address, and
        // rewriting it here would undo that.
        setError(body.error ?? 'That did not work. Please try again.');
        return;
      }
      setSession(body);
      setPassword('');
      /*
       * Kept so the registered shell can bootstrap. localStorage is readable
       * by any script on this origin, which is why the token is short-lived
       * and why `sign out everywhere` invalidates it server-side rather than
       * relying on the browser having forgotten it.
       *
       * Written through session.ts, under BOTH keys and in the shape call-web
       * and operator-web read. Signing in here once never reached /call/
       * because this form stored a bare token under one key while call-web
       * read a `{accountId, token}` object under another; the fix for that
       * lived here, and the fix for the next disagreement would have too.
       * Now there is one writer, and this is a call to it.
       */
      persistJoinSession(body);
      /*
       * THE FLOW, FINALLY. Signing in used to leave somebody exactly where
       * they were -- on a marketing page, session stored, nothing changed on
       * screen -- and "did that work?" is not a question a login should leave
       * open. Success lands on the dashboard, which is what the person asked
       * for by signing in. A full navigation rather than a route change so the
       * shell boots from the freshly stored session.
       */
      window.location.assign('/app/');
      return;
    } catch {
      /*
       * NAME THE HOST IT TRIED. "Could not reach C7 right now" is true and
       * useless: it reads as an outage, and the two times it has appeared the
       * service was answering 201 and 401 to the same request from a terminal.
       * Both were the bundle addressing somewhere else -- a build that never
       * received VITE_ACCOUNT_URL and compiled in localhost, and a tab still
       * running the JavaScript it loaded before the fix. Either is obvious the
       * moment the message says where it went, and neither is guessable while
       * it does not. The origin is public; it is in every request this page
       * makes.
       */
      const target = new URL(ACCOUNT_URL, window.location.origin).origin;
      setError(
        target === window.location.origin
          ? 'Could not reach C7 right now.'
          : `Could not reach C7 at ${target}. If that is not where C7 lives, reload the page (Ctrl+Shift+R) to pick up the current version.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="join" className="join">
      <div className="shell join-shell">
        <div className="join-copy">
          <h2 className="section-title">Join the C7 ecosystem</h2>
          <p className="section-lede">
            Create one C7 account to use what is available, follow what is being built, and get
            early access as the ecosystem expands.
          </p>
          <ul className="join-points">
            <li>One account across every C7 product</li>
            <li>Access VIDEOFY-LIVE today</li>
            <li>Early access as new domains open</li>
          </ul>
        </div>

        <div className="join-panel">
          {session === null ? (
            <>
              <div className="join-tabs" role="tablist" aria-label="Create an account or sign in">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'create'}
                  className={mode === 'create' ? 'join-tab join-tab-on' : 'join-tab'}
                  onClick={() => {
                    setMode('create');
                    setError(null);
                  }}
                >
                  Create C7 account
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'signin' || mode === 'reset'}
                  className={
                    mode === 'signin' || mode === 'reset' ? 'join-tab join-tab-on' : 'join-tab'
                  }
                  onClick={() => {
                    setMode('signin');
                    setError(null);
                  }}
                >
                  Sign in
                </button>
              </div>

              {sessionEnded ? (
                <p className="join-note" role="status">
                  Your session has ended — sign in again.
                </p>
              ) : null}

              {resetAsked ? (
                <p className="join-note" role="status">
                  If that address has a C7 account, a link to choose a new password is on its way.
                  It expires shortly and can be used once.
                </p>
              ) : null}

              <form className="join-form" onSubmit={submit}>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                {mode === 'create' ? (
                  <label className="field">
                    <span className="field-label">C7 username</span>
                    <span className="field-prefixed">
                      <span className="field-prefix" aria-hidden="true">c7</span>
                      <input
                        name="username"
                        autoComplete="username"
                        required
                        inputMode="text"
                        spellCheck={false}
                        placeholder="yourname"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                    </span>
                    <span className="field-hint">
                      This is how people add you. Your name in calls is separate and you can change
                      it any time — this one you cannot give up and take back later.
                    </span>
                  </label>
                ) : null}

                {/* No password field when asking for a reset: the whole reason
                    somebody is here is that they do not have one that works. */}
                {mode === 'reset' ? null : (
                  <label className="field">
                    <span className="field-label">Password</span>
                    <input
                      type="password"
                      autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                )}
                {error === null ? null : (
                  <p className="join-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="button button-primary button-wide" type="submit" disabled={busy}>
                  {busy
                    ? 'Working…'
                    : mode === 'create'
                      ? 'Create C7 account'
                      : mode === 'reset'
                        ? 'Email me a reset link'
                        : 'Sign in'}
                </button>

                {/* Offered from sign-in, where somebody discovers they need it,
                    and offering the way back so the link is not a dead end. */}
                {mode === 'signin' ? (
                  <button
                    type="button"
                    className="join-link"
                    onClick={() => {
                      setMode('reset');
                      setError(null);
                      setResetAsked(false);
                    }}
                  >
                    Forgot your password?
                  </button>
                ) : null}
                {mode === 'reset' ? (
                  <button
                    type="button"
                    className="join-link"
                    onClick={() => {
                      setMode('signin');
                      setError(null);
                      setResetAsked(false);
                    }}
                  >
                    Back to sign in
                  </button>
                ) : null}
              </form>
            </>
          ) : (
            <div className="join-done">
              {/*
                Registration creates an IDENTITY. It does not create trust, and
                it does not entitle anybody to a product. Saying "you are in"
                after a password is set teaches people that the verification
                step which follows is optional paperwork.
              */}
              <h3>C7 account created.</h3>
              <p>
                Complete verification to activate C7 products. We will confirm your email, then
                your phone, then your identity.
              </p>
              <ul className="join-shelf">
                <li>
                  <span className="shelf-name">Email</span>
                  <span className="shelf-state">Verification required</span>
                </li>
                <li className="shelf-muted">
                  <span className="shelf-name">Phone</span>
                  <span className="shelf-state">Pending</span>
                </li>
                <li className="shelf-muted">
                  <span className="shelf-name">Identity</span>
                  <span className="shelf-state">Pending</span>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
