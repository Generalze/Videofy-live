/**
 * Your C7 identity: the handle people add you by, and the name they see.
 *
 * THE TWO ARE PRESENTED APART BECAUSE THEY ARE APART. Zoe's ruling: "c7 username
 * is different from profile name that would appear in calls or else our fraud
 * check in protecting people adding id will be flawed." A layout that put them
 * in one box under one heading would quietly teach the opposite -- that they
 * are two spellings of one thing -- and the belief is the vulnerability.
 *
 * So the handle is shown as a fixed, copyable credential with its consequences
 * stated, and the display name as an ordinary editable field. What each one
 * does is written next to it, because "username" and "display name" are not
 * words that explain themselves to somebody deciding what to type.
 */
import { useRef, useState } from 'react';
import { createAccountApi } from './accountApi';
import { Avatar } from './Avatar';
import { downscaleToDataUrl } from './imageDownscale';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/+$/, '');

export interface Profile {
  readonly username: string | null;
  readonly displayName: string | null;
  readonly discoverable: boolean;
}

interface Props {
  readonly token: string;
  readonly accountId: string;
  readonly profile: Profile;
  readonly onChanged: () => void;
}

type Feedback = { kind: 'idle' | 'working' | 'saved' | 'error'; message?: string };

async function post(path: string, token: string, body: unknown) {
  const response = await fetch(`${ACCOUNT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return { ok: response.ok, error: payload.error };
}

export function ProfilePanel({ token, accountId, profile, onChanged }: Props) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [nameFeedback, setNameFeedback] = useState<Feedback>({ kind: 'idle' });
  const [claim, setClaim] = useState('');
  const [claimFeedback, setClaimFeedback] = useState<Feedback>({ kind: 'idle' });
  const [discoveryFeedback, setDiscoveryFeedback] = useState<Feedback>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const [api] = useState(() => createAccountApi(ACCOUNT_URL, token));
  const [pictureFeedback, setPictureFeedback] = useState<Feedback>({ kind: 'idle' });
  /** Bumps the Avatar remount after an upload, defeating the minute cache. */
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function pickPicture(file: File | undefined) {
    if (file === undefined) return;
    setPictureFeedback({ kind: 'working' });
    try {
      // Downscaled HERE: a 12-megapixel photo is a phone-camera default, and
      // a face at 512px is indistinguishable in a 36px circle.
      const image = await downscaleToDataUrl(file, 512);
      const result = await api.setAvatar(image);
      if (!result.ok) {
        setPictureFeedback({ kind: 'error', message: result.error });
        return;
      }
      api.forgetAvatar(accountId);
      setAvatarEpoch((epoch) => epoch + 1);
      setPictureFeedback({ kind: 'saved', message: 'Saved.' });
    } catch {
      setPictureFeedback({ kind: 'error', message: 'That file could not be read as a picture.' });
    }
  }

  async function removePicture() {
    setPictureFeedback({ kind: 'working' });
    const result = await api.removeAvatar();
    api.forgetAvatar(accountId);
    setAvatarEpoch((epoch) => epoch + 1);
    setPictureFeedback(result.ok ? { kind: 'idle' } : { kind: 'error', message: result.error });
  }

  async function saveDisplayName(event: React.FormEvent) {
    event.preventDefault();
    setNameFeedback({ kind: 'working' });
    const result = await post('/accounts/display-name', token, { displayName });
    if (result.ok) {
      setNameFeedback({ kind: 'saved', message: 'Saved.' });
      onChanged();
      return;
    }
    setNameFeedback({ kind: 'error', message: result.error ?? 'That name could not be saved.' });
  }

  /*
   * Claiming a handle for an account that has none.
   *
   * Registration requires one now, so most accounts arrive with it -- but an
   * account created before that rule, or restored from a backup that predates
   * it, would otherwise be permanently unaddressable with no way to fix it
   * from the interface. A read-only field would have hidden that.
   */
  async function claimUsername(event: React.FormEvent) {
    event.preventDefault();
    setClaimFeedback({ kind: 'working' });
    const result = await post('/accounts/username', token, { username: claim });
    if (result.ok) {
      setClaimFeedback({ kind: 'idle' });
      onChanged();
      return;
    }
    setClaimFeedback({
      kind: 'error',
      message: result.error ?? 'That username could not be saved.',
    });
  }

  async function setDiscoverable(next: boolean) {
    setDiscoveryFeedback({ kind: 'working' });
    const result = await post('/accounts/discovery', token, { discoverable: next });
    if (result.ok) {
      setDiscoveryFeedback({ kind: 'idle' });
      onChanged();
      return;
    }
    setDiscoveryFeedback({
      kind: 'error',
      message: result.error ?? 'That setting could not be saved.',
    });
  }

  async function copyHandle() {
    if (!profile.username) return;
    try {
      await navigator.clipboard.writeText(profile.username);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright. The handle is on screen and
      // selectable either way, so there is nothing to recover from and nothing
      // worth interrupting somebody with.
    }
  }

  return (
    <section className="app-card">
      <h2 className="app-card-title">Your C7 identity</h2>

      <div className="profile-block">
        <h3 className="profile-label">Picture</h3>
        <div className="profile-avatar-row">
          <Avatar key={avatarEpoch} api={api} accountId={accountId} name={profile.displayName ?? profile.username ?? '?'} size={64} />
          <div className="contact-actions">
            <button
              type="button"
              className="button button-small"
              onClick={() => fileInputRef.current?.click()}
              disabled={pictureFeedback.kind === 'working'}
            >
              {pictureFeedback.kind === 'working' ? 'Uploading…' : 'Choose picture'}
            </button>
            <button type="button" className="button button-small" onClick={() => void removePicture()}>
              Remove
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="visually-hidden"
            onChange={(event) => void pickPicture(event.target.files?.[0])}
          />
        </div>
        {pictureFeedback.message !== undefined ? (
          <p className="contact-notice">{pictureFeedback.message}</p>
        ) : null}
        <p className="profile-hint">Shown beside your name in calls, contacts and messages.</p>
      </div>

      <div className="profile-block">
        <h3 className="profile-label">Username</h3>
        {profile.username ? (
          <p className="profile-value">
            <code>{profile.username}</code>
            <button type="button" className="join-link" onClick={copyHandle}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
        ) : (
          <form className="join-form" onSubmit={claimUsername}>
            <p className="join-note" role="status">
              You do not have a username yet, so nobody can add you. Choose one now.
            </p>
            <label className="field">
              <span className="field-label">Choose your username</span>
              <span className="field-prefixed">
                <span className="field-prefix" aria-hidden="true">c7</span>
                <input
                  name="username"
                  autoComplete="username"
                  required
                  spellCheck={false}
                  placeholder="yourname"
                  value={claim}
                  onChange={(event) => setClaim(event.target.value)}
                />
              </span>
            </label>
            {claimFeedback.message ? (
              <p className="join-error" role="alert">
                {claimFeedback.message}
              </p>
            ) : null}
            <button
              className="button button-primary"
              type="submit"
              disabled={claimFeedback.kind === 'working' || claim.trim().length === 0}
            >
              {claimFeedback.kind === 'working' ? 'Claiming…' : 'Claim username'}
            </button>
          </form>
        )}
        {/*
          * Stated where the decision is made, not buried in terms. Somebody
          * about to hand this out should know it is the durable one and that
          * giving it up is one-way.
          */}
        <p className="field-hint">
          This is the only way people can add you. Every C7 username starts with{' '}
          <code>c7</code>, so anything that does not is not a C7 username. If you change it, the old
          one cannot be used again by you or anyone else.
        </p>
      </div>

      <div className="profile-block">
        <h3 className="profile-label">Name shown in calls</h3>
        <form className="join-form" onSubmit={saveDisplayName}>
          <label className="field">
            <span className="field-label">Display name</span>
            <input
              name="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="The name people see"
            />
          </label>
          <p className="field-hint">
            Change this whenever you like. Nobody can find or add you by it — that is what your
            username is for.
          </p>
          {nameFeedback.message ? (
            <p
              className={nameFeedback.kind === 'error' ? 'join-error' : 'join-note'}
              role={nameFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {nameFeedback.message}
            </p>
          ) : null}
          <button
            className="button button-primary"
            type="submit"
            disabled={nameFeedback.kind === 'working' || displayName.trim().length === 0}
          >
            {nameFeedback.kind === 'working' ? 'Saving…' : 'Save name'}
          </button>
        </form>
      </div>

      <div className="profile-block">
        <h3 className="profile-label">Who can find you</h3>
        {/*
          * Private is the default and is described first, so the reading order
          * matches the state somebody is actually in.
          */}
        <div className="checkboxRow">
          <input
            type="checkbox"
            id="discoverable"
            checked={profile.discoverable}
            disabled={discoveryFeedback.kind === 'working' || profile.username === null}
            onChange={(event) => void setDiscoverable(event.target.checked)}
          />
          <label htmlFor="discoverable">Let people find me by my username</label>
        </div>
        <p className="field-hint">
          {profile.discoverable
            ? 'Anyone who knows your username can find and add you.'
            : 'You are private. Nobody can find you by searching — you can still be added through an invite you send.'}
        </p>
        {discoveryFeedback.message ? (
          <p className="join-error" role="alert">
            {discoveryFeedback.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
