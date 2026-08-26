/**
 * The verification screen a registered person actually uses.
 *
 * Three channels, each with its own state, because "verify your account" as one
 * button hides which step is outstanding and which one failed.
 *
 * WHAT THIS DELIBERATELY NEVER SHOWS. Whether an address exists, whether a
 * token is merely wrong versus expired versus already used, how many attempts
 * remain on the email channel, or any provider error. The server answers those
 * with one message on purpose, and a UI that helpfully elaborated would undo it.
 */
import { useState } from 'react';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/$/, '');

type ChannelState = 'unverified' | 'pending' | 'verified' | 'failed' | 'expired';

interface Props {
  readonly token: string;
  readonly email: string;
  readonly emailState: ChannelState;
  readonly phoneState: ChannelState;
  readonly identityState: ChannelState;
  readonly onChanged: () => void;
}

type Feedback = { kind: 'idle' | 'working' | 'sent' | 'error' | 'done'; message?: string };

async function post(path: string, token: string, body?: unknown) {
  const response = await fetch(`${ACCOUNT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    deliverable?: boolean;
  };
  return {
    ok: response.ok,
    status: response.status,
    error: payload.error,
    /*
     * Absent means deliverable. The server sends this flag only to say NO, so a
     * client that predates it keeps working and a channel that genuinely
     * delivers never carries the extra field.
     */
    deliverable: payload.deliverable !== false,
  };
}

function EmailStep({ token, email, state, onChanged }: {
  readonly token: string;
  readonly email: string;
  readonly state: ChannelState;
  readonly onChanged: () => void;
}) {
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });

  if (state === 'verified') {
    return (
      <div className="verify-step verify-step-done">
        <p className="verify-step-title">Email verified</p>
        <p className="verify-step-detail">{email}</p>
      </div>
    );
  }

  async function send() {
    setFeedback({ kind: 'working' });
    const result = await post('/verification/email', token);
    if (result.ok) {
      /*
       * NOT "temporarily", and not "check your inbox". This deployment has no
       * email provider, so nothing is going to arrive and nothing is going to
       * start working on its own -- the same wording rule the call runtime uses
       * for a missing translation engine. Telling somebody to check an inbox
       * sends them to look for a fault at their end.
       */
      setFeedback(
        result.deliverable
          ? { kind: 'sent', message: 'Check your inbox. The link can be used once.' }
          : {
              kind: 'error',
              message:
                'Email is not configured on this server, so no message was sent. ' +
                'Nothing is wrong with your address.',
            },
      );
      onChanged();
      return;
    }
    if (result.status === 429) {
      // The throttle is real and worth saying plainly; the exact remaining
      // milliseconds are not the person's problem.
      setFeedback({ kind: 'error', message: 'Wait a moment before asking for another email.' });
      return;
    }
    setFeedback({
      kind: 'error',
      // Never the provider's words. "SMTP 550 relay denied" helps nobody and
      // describes our infrastructure to a stranger.
      message: result.error ?? "We couldn't send the email. Try again shortly.",
    });
  }

  return (
    <div className="verify-step">
      <p className="verify-step-title">Email</p>
      <p className="verify-step-detail">{email}</p>
      <p className="verify-step-state">
        {state === 'pending' ? 'Verification sent' : state === 'expired' ? 'Link expired' : 'Not verified'}
      </p>
      <button className="button button-small" type="button" onClick={() => void send()}
        disabled={feedback.kind === 'working'}>
        {feedback.kind === 'working'
          ? 'Sending…'
          : state === 'pending'
            ? 'Send again'
            : 'Send verification email'}
      </button>
      {feedback.message ? (
        <p className={feedback.kind === 'error' ? 'verify-error' : 'verify-note'} role="status">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

function PhoneStep({ token, state, onChanged }: {
  readonly token: string;
  readonly state: ChannelState;
  readonly onChanged: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'enter-number' | 'enter-code'>('enter-number');
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });

  if (state === 'verified') {
    return (
      <div className="verify-step verify-step-done">
        <p className="verify-step-title">Phone verified</p>
      </div>
    );
  }

  async function sendCode() {
    setFeedback({ kind: 'working' });
    const result = await post('/verification/phone', token, { phone });
    if (result.ok) {
      if (!result.deliverable) {
        // Staying on the number step on purpose: moving to "enter the code"
        // asks somebody to type a code that was never sent.
        setFeedback({
          kind: 'error',
          message:
            'SMS is not configured on this server, so no code was sent. ' +
            'Nothing is wrong with your number.',
        });
        return;
      }
      setStage('enter-code');
      setFeedback({ kind: 'sent', message: 'Code sent. It expires shortly.' });
      onChanged();
      return;
    }
    if (result.status === 429) {
      setFeedback({ kind: 'error', message: 'Wait a moment before asking for another code.' });
      return;
    }
    setFeedback({
      kind: 'error',
      message: result.error ?? "We couldn't send the code. Check the number and try again.",
    });
  }

  async function confirm() {
    setFeedback({ kind: 'working' });
    const result = await post('/verification/phone/confirm', token, { code });
    if (result.ok) {
      setFeedback({ kind: 'done', message: 'Phone verified.' });
      onChanged();
      return;
    }
    setFeedback({ kind: 'error', message: 'That code is not valid or has expired.' });
  }

  return (
    <div className="verify-step">
      <p className="verify-step-title">Phone</p>
      {stage === 'enter-number' ? (
        <>
          <label className="field">
            <span className="field-label">Number, including country code</span>
            <input
              type="tel"
              inputMode="tel"
              placeholder="+234 800 000 0000"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <button className="button button-small" type="button" onClick={() => void sendCode()}
            disabled={feedback.kind === 'working' || phone.trim().length < 6}>
            {feedback.kind === 'working' ? 'Sending…' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Enter the 6-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </label>
          <div className="verify-actions">
            <button className="button button-small" type="button" onClick={() => void confirm()}
              disabled={feedback.kind === 'working' || code.length !== 6}>
              Verify
            </button>
            {/*
              Changing the number starts a NEW challenge rather than reusing the
              open one — a code issued for one number must never confirm another.
            */}
            <button className="button button-small button-ghost" type="button"
              onClick={() => {
                setStage('enter-number');
                setCode('');
                setFeedback({ kind: 'idle' });
              }}>
              Use a different number
            </button>
          </div>
        </>
      )}
      {feedback.message ? (
        <p className={feedback.kind === 'error' ? 'verify-error' : 'verify-note'} role="status">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

function IdentityStep({ token, state, onChanged }: {
  readonly token: string;
  readonly state: ChannelState;
  readonly onChanged: () => void;
}) {
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });

  if (state === 'verified') {
    return (
      <div className="verify-step verify-step-done">
        <p className="verify-step-title">Identity verified</p>
      </div>
    );
  }

  async function start() {
    setFeedback({ kind: 'working' });
    const response = await fetch(`${ACCOUNT_URL}/verification/identity`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = (await response.json().catch(() => ({}))) as {
      redirectUrl?: string;
      error?: string;
    };
    if (response.ok && typeof payload.redirectUrl === 'string') {
      setFeedback({
        kind: 'sent',
        message: 'Continue with our verification partner to finish this step.',
      });
      onChanged();
      window.open(payload.redirectUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    setFeedback({
      kind: 'error',
      message: payload.error ?? 'Identity verification is not available right now.',
    });
  }

  return (
    <div className="verify-step">
      <p className="verify-step-title">Identity</p>
      <p className="verify-step-detail">
        A short check with our verification partner. C7 never stores your document.
      </p>
      <p className="verify-step-state">
        {state === 'pending' ? 'In progress' : state === 'failed' ? 'Needs another try' : 'Required'}
      </p>
      <button className="button button-small" type="button" onClick={() => void start()}
        disabled={feedback.kind === 'working'}>
        {state === 'pending' ? 'Continue verification' : 'Start identity check'}
      </button>
      {feedback.message ? (
        <p className={feedback.kind === 'error' ? 'verify-error' : 'verify-note'} role="status">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

export function VerificationPanel(props: Props) {
  return (
    <div className="verify-grid">
      <EmailStep
        token={props.token}
        email={props.email}
        state={props.emailState}
        onChanged={props.onChanged}
      />
      <PhoneStep token={props.token} state={props.phoneState} onChanged={props.onChanged} />
      <IdentityStep token={props.token} state={props.identityState} onChanged={props.onChanged} />
    </div>
  );
}
