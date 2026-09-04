/** @author masterzee001 */
/**
 * Sign in from the console itself.
 *
 * Founder report (30 Aug 2026): the console told a signed-in person "Sign in
 * on C7 in this browser, then reload". A sign-in on another origin, or one
 * older than its lifetime, put her exactly there, with nothing on the page
 * that could fix it. Now the console signs people in: email and password to
 * POST <account>/sessions, the answer written to BOTH session keys the site
 * uses, and the identity and the gateway socket follow the session without
 * a reload (operatorSession.subscribe).
 *
 * A browser-class session, deliberately: `client: "device"` is the phone's
 * long-lived class and is not sent from here.
 *
 * The request itself (signIn) and its counterpart (signOut) live in
 * operatorSession.ts beside the storage they write. The token arrives in the
 * response body and goes straight to storage: not kept in component state,
 * not logged, never part of a message.
 */
import React, { useEffect, useId, useState } from 'react';
import { CloseIcon } from './icons';
import { signIn, writeSession } from './operatorSession';
import styles from './SignInDialog.module.css';

export interface SignInDialogProps {
  readonly accountUrl: string;
  /** Why the dialog opened: the wording differs for a session the service refused. */
  readonly reason: 'signed-out' | 'expired';
  readonly onClose: () => void;
  /** After the session is written; the identity and socket already follow it through subscribe. */
  readonly onSignedIn?: (() => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export function SignInDialog({ accountUrl, reason, onClose, onSignedIn, fetchImpl }: SignInDialogProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const emailId = useId();
  const passwordId = useId();

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await signIn({ accountUrl, email: email.trim(), password, fetchImpl });
    if (!result.ok) {
      setBusy(false);
      setFailure(result.message);
      return;
    }
    setPassword('');
    writeSession(result.session);
    setBusy(false);
    onSignedIn?.();
    onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.dialog}>
        <div className={styles.head}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {reason === 'expired' ? 'Session expired' : 'Sign in to C7'}
            </h2>
            <p className={styles.lede}>
              {reason === 'expired'
                ? 'Your C7 session has expired. Sign in again to load your channel and connect to the gateway.'
                : 'Sign in with your C7 account to load your channel and connect to the gateway.'}
            </p>
          </div>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <div className={styles.field}>
            <label htmlFor={emailId} className={styles.label}>
              Email address
            </label>
            <input
              id={emailId}
              className={styles.input}
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={passwordId} className={styles.label}>
              Password
            </label>
            <input
              id={passwordId}
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </div>
          {failure !== null && (
            <p role="alert" className={styles.failure}>
              {failure}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" className={styles.cancel} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={styles.submit} disabled={busy}>
              {busy ? 'Signing in' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
