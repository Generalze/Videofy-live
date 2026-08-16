import { useId, useState } from 'react';

/**
 * Signing in, asked for at the only point it is actually needed.
 *
 * A voice belongs to a person, so enrolling one requires an account. Joining a
 * call does not, and this deliberately does not appear anywhere near the join
 * screen: translation is the product, and a login wall in front of a
 * conversation would charge everybody for a feature most of them never use.
 *
 * The panel that used to open straight onto a consent checkbox now opens onto
 * this, because the previous owner — a value in browser storage — meant two
 * people sharing a laptop shared a voice.
 *
 * Nothing here explains WHY sign-in helps in terms of storage, tokens or
 * identity models. It says what it gets you.
 */
export interface VoiceAccountGateProps {
  busy: boolean;
  error: string | null;
  onSubmit: (mode: 'sign-in' | 'sign-up', email: string, password: string) => void;
}

export function VoiceAccountGate(props: VoiceAccountGateProps) {
  const emailId = useId();
  const passwordId = useId();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signingUp = mode === 'sign-up';

  return (
    <form
      className="voice-account-gate"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.busy) return;
        props.onSubmit(mode, email, password);
      }}
    >
      <p className="voice-account-lead">
        {signingUp
          ? 'Create an account so your voice stays yours — on any device, and on no one else’s.'
          : 'Sign in to use the voice you recorded.'}
      </p>

      <label className="voice-account-field" htmlFor={emailId}>
        <span>Email</span>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label className="voice-account-field" htmlFor={passwordId}>
        <span>Password</span>
        <input
          id={passwordId}
          type="password"
          // Tells a password manager which of the two this is, so it offers to
          // generate on sign-up and to fill on sign-in.
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      {signingUp ? (
        <p className="voice-account-hint">
          At least 12 characters. A few ordinary words you will remember beats
          one short word with symbols in it.
        </p>
      ) : null}

      {props.error ? (
        <p className="voice-account-error" role="alert">
          {props.error}
        </p>
      ) : null}

      <div className="voice-account-actions">
        <button type="submit" className="control-button is-primary" disabled={props.busy}>
          {props.busy ? 'Working…' : signingUp ? 'Create account' : 'Sign in'}
        </button>
        <button
          type="button"
          className="control-button is-quiet"
          onClick={() => setMode(signingUp ? 'sign-in' : 'sign-up')}
          disabled={props.busy}
        >
          {signingUp ? 'I already have an account' : 'Create an account instead'}
        </button>
      </div>
    </form>
  );
}
