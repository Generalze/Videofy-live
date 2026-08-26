/**
 * The page a password-reset link lands on.
 *
 * WHY IT EXISTS. The reset backend has been complete for some time — a
 * challenge, a delivery, a single-use completion that revokes every existing
 * session. What it never had was anywhere to land: the email pointed at the
 * VERIFICATION page, because the delivery provider could not tell one kind of
 * message from another, and that page refuses a reset token by design. Both
 * halves worked; the flow did not exist.
 *
 * WHY IT ASKS FOR THE EMAIL. The server completes a reset with the address as
 * well as the token, so the link alone is not enough — somebody who intercepts
 * it still has to know which account it was for. That is a deliberate second
 * factor of a weak kind, and it costs the real recipient nothing: the address
 * is the inbox they just read the message in.
 *
 * WHY IT DOES NOT SIGN ANYBODY IN. The server issues no session here. If this
 * was an attacker completing a reset, handing them a live session would be the
 * last step of the takeover rather than the end of it. So the page finishes by
 * sending people to sign in with the password they just chose.
 */
import { useEffect, useState } from 'react';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/+$/, '');

/** Matches the server's own floor, so the refusal happens before a round trip. */
const MIN_PASSWORD_LENGTH = 12;

function tokenFromLocation(): string | null {
  try {
    const token = new URLSearchParams(window.location.search).get('token');
    return token && token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

interface Props {
  /** Leaves the reset URL so a refresh cannot replay a consumed token. */
  onDone: () => void;
}

type Stage = 'form' | 'working' | 'done' | 'no-token';

export function ResetPassword({ onDone }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const found = tokenFromLocation();
    setToken(found);
    if (found === null) setStage('no-token');
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (token === null) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setStage('working');
    setError(null);
    try {
      const response = await fetch(`${ACCOUNT_URL}/accounts/password-reset/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        /*
         * The server's own wording. It answers expired, wrong, already-used
         * and unknown-account identically on purpose, and rephrasing it here
         * would risk inventing a distinction it deliberately refuses to make.
         */
        setError(body.error ?? 'That reset link is not valid or has expired.');
        setStage('form');
        return;
      }
      setPassword('');
      setStage('done');
    } catch {
      setError('Could not reach C7 right now.');
      setStage('form');
    }
  }

  return (
    <section className="app-gate">
      <div className="shell app-gate-shell">
        <p className="eyebrow">Consummate 7</p>

        {stage === 'no-token' ? (
          <>
            <h1 className="app-title">This link is incomplete</h1>
            <p className="section-lede">
              It is missing the part that identifies the request. Open the link from your email
              again, or ask for a new one from the sign-in form.
            </p>
            <button type="button" className="button button-primary" onClick={onDone}>
              Back to C7
            </button>
          </>
        ) : null}

        {stage === 'done' ? (
          <>
            <h1 className="app-title">Your password is changed</h1>
            <p className="section-lede">
              Every session that was signed in before now has been signed out, including on other
              devices. Sign in with your new password to continue.
            </p>
            <button type="button" className="button button-primary" onClick={onDone}>
              Go to sign in
            </button>
          </>
        ) : null}

        {stage === 'form' || stage === 'working' ? (
          <>
            <h1 className="app-title">Choose a new password</h1>
            <p className="section-lede">
              Confirm the address this link was sent to, then choose the password you want.
            </p>
            <form className="join-form" onSubmit={submit}>
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">New password</span>
                <input
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                className="button button-primary button-wide"
                type="submit"
                disabled={stage === 'working'}
              >
                {stage === 'working' ? 'Changing…' : 'Change password'}
              </button>
            </form>
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Whether this request is the reset landing.
 *
 * Matched with and without the trailing slash: both get linked, typed and
 * pasted, and a mail client that strips the slash must not produce a page that
 * silently does nothing.
 */
export function isResetPasswordPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === '/app/reset-password';
}
