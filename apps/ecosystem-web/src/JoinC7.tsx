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
import { useState } from 'react';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/$/, '');

type Mode = 'create' | 'signin';

interface SessionResult {
  readonly accountId?: string;
  readonly token?: string;
}

export function JoinC7() {
  const [mode, setMode] = useState<Mode>('create');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResult | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${ACCOUNT_URL}/${mode === 'create' ? 'accounts' : 'sessions'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
    } catch {
      setError('Could not reach C7 right now.');
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
                  aria-selected={mode === 'signin'}
                  className={mode === 'signin' ? 'join-tab join-tab-on' : 'join-tab'}
                  onClick={() => {
                    setMode('signin');
                    setError(null);
                  }}
                >
                  Sign in
                </button>
              </div>

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
                {error === null ? null : (
                  <p className="join-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="button button-primary button-wide" type="submit" disabled={busy}>
                  {busy ? 'Working…' : mode === 'create' ? 'Create C7 account' : 'Sign in'}
                </button>
              </form>
            </>
          ) : (
            <div className="join-done">
              <h3>You are in.</h3>
              <p>
                Your C7 account is active. VIDEOFY-LIVE is available now; other domains will appear
                here as they open.
              </p>
              <ul className="join-shelf">
                <li>
                  <span className="shelf-name">VIDEOFY-LIVE</span>
                  <span className="shelf-state">Available</span>
                </li>
                <li className="shelf-muted">
                  <span className="shelf-name">Early access</span>
                  <span className="shelf-state">Nothing yet</span>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
