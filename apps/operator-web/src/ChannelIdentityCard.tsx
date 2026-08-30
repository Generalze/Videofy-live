/** @author masterzee001 */
/**
 * The channel identity block at the top of the Access page.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY: the
 * Access page shows avatar, displayName, @handle, category and visibility,
 * with Edit channel (handle, name, description, category, saved through PUT
 * /channels/mine), View channel, Copy channel link, Share and a QR code. The
 * same identity client and QR component the shell's menu uses are reused
 * here, so the page and the top bar can never disagree about the channel.
 *
 * Every control is REAL: the profile is the persisted one from the account
 * service; Save sends only the fields that changed and shows the service's
 * own refusal (a taken handle, a reserved word) verbatim; nothing is shown as
 * saved until the service has answered with the saved profile. Without a
 * profile there is no link to view, copy, share or encode, and the block
 * says exactly which state it is in instead of inventing a name.
 */
import React, { useEffect, useState } from 'react';
import { CHANNEL_CATEGORIES, channelCategoryLabel, isChannelCategory } from '@videofy-live/shared-types';
import {
  channelPublicLink,
  channelStatusWord,
  type ChannelIdentity,
  type ChannelIdentityPatch,
  type ChannelIdentityState,
  type ChannelIdentityUpdateResult,
  type ChannelLiveState,
} from './premium/channelIdentity';
import { ChannelAvatar } from './premium/ChannelIdentityBadge';
import { ChannelQr } from './premium/ChannelIdentityMenu';
import { defaultChannelMenuBrowser, type ChannelMenuBrowser } from './premium/channelMenuBrowser';
import { CheckIcon, CopyIcon, EditIcon, ExternalLinkIcon, QrIcon, ShareIcon } from './premium/icons';
import { NO_CATEGORY_LABEL } from './channelSettings';
import { identityDraftProblems, identityPatch, visibilityWord, type EditDraft } from './channelIdentityDraft';
import styles from './App.module.css';

export interface ChannelIdentityCardProps {
  readonly identity: ChannelIdentityState;
  readonly live: ChannelLiveState;
  readonly accountUrl: string;
  /** Where /streams/<handle> is served: the public site's origin. */
  readonly publicOrigin: string;
  /** PUT /channels/mine with exactly the fields that changed. */
  readonly onSaveIdentity: (patch: ChannelIdentityPatch) => Promise<ChannelIdentityUpdateResult>;
  readonly onReloadIdentity?: (() => void) | undefined;
  readonly browser?: ChannelMenuBrowser | undefined;
}

type Feedback = { readonly kind: 'copied' } | { readonly kind: 'shared' } | { readonly kind: 'saved' } | { readonly kind: 'failed'; readonly message: string } | null;

function draftOf(profile: ChannelIdentity): EditDraft {
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    category: profile.category,
  };
}

export function ChannelIdentityCard({
  identity,
  live,
  accountUrl,
  publicOrigin,
  onSaveIdentity,
  onReloadIdentity,
  browser,
}: ChannelIdentityCardProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (feedback === null || feedback.kind === 'failed') return undefined;
    const timer = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(timer);
  }, [feedback]);

  const features = browser ?? defaultChannelMenuBrowser();

  if (identity.status !== 'ready') {
    return (
      <section className={styles.identityCard} aria-labelledby="channel-identity-heading">
        <h3 id="channel-identity-heading" className={styles.identityHeading}>
          Channel identity
        </h3>
        <div className={styles.identityEmpty}>
          <ChannelAvatar state={identity} live={live} accountUrl={accountUrl} size={56} />
          {identity.status === 'loading' && <p className={styles.identityEmptyTitle}>Loading your channel</p>}
          {identity.status === 'signed-out' && (
            <>
              <p className={styles.identityEmptyTitle}>Not signed in</p>
              <p className={styles.identityEmptyText}>Sign in on C7 in this browser, then reload the console to load your channel.</p>
            </>
          )}
          {identity.status === 'unset' && (
            <>
              <p className={styles.identityEmptyTitle}>Channel not set up</p>
              <p className={styles.identityEmptyText}>
                Your account has no channel profile yet. It is created the first time this console connects to the
                gateway with your C7 session; the name, @handle, link, share and QR code appear here once it exists.
              </p>
            </>
          )}
          {identity.status === 'error' && (
            <>
              <p className={styles.identityEmptyTitle}>Channel unavailable</p>
              <p className={styles.identityEmptyText}>{identity.message}</p>
            </>
          )}
          {onReloadIdentity !== undefined && identity.status !== 'loading' && (
            <button type="button" onClick={onReloadIdentity}>
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }

  const { profile } = identity;
  const link = channelPublicLink(publicOrigin, profile.handle);
  const current = draft ?? draftOf(profile);
  const problems = identityDraftProblems(current);
  const patch = identityPatch(profile, current);
  const dirty = Object.keys(patch).length > 0;

  const copy = async (): Promise<void> => {
    try {
      await features.copyText(link);
      setFeedback({ kind: 'copied' });
    } catch {
      setFeedback({ kind: 'failed', message: 'Copying is not available in this browser. Select the link and copy it.' });
    }
  };

  const share = async (): Promise<void> => {
    if (features.share === undefined) {
      await copy();
      return;
    }
    try {
      await features.share({ title: profile.displayName, url: link });
      setFeedback({ kind: 'shared' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      await copy();
    }
  };

  const save = async (): Promise<void> => {
    if (!dirty || problems.length > 0 || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await onSaveIdentity(patch);
      if (result.ok) {
        setEditing(false);
        setDraft(null);
        setFeedback({ kind: 'saved' });
      } else {
        setFeedback({ kind: 'failed', message: result.message });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.identityCard} aria-labelledby="channel-identity-heading">
      <h3 id="channel-identity-heading" className={styles.identityHeading}>
        Channel identity
      </h3>
      <div className={styles.identityRow}>
        <ChannelAvatar state={identity} live={live} accountUrl={accountUrl} size={64} />
        <div className={styles.identityText}>
          <p className={styles.identityName}>{profile.displayName}</p>
          <p className={styles.identityHandle}>@{profile.handle}</p>
          <p className={styles.identityMeta}>
            <span>{channelStatusWord(live)}</span>
            <span>{profile.category === null ? NO_CATEGORY_LABEL : channelCategoryLabel(profile.category)}</span>
            <span>{visibilityWord(profile.visibility)}</span>
          </p>
          {profile.description.length > 0 && <p className={styles.identityDescription}>{profile.description}</p>}
        </div>
      </div>

      <p className={styles.identityLink}>
        <span>Channel link</span>
        <code>{link}</code>
      </p>

      <div className={styles.identityActions} role="group" aria-label="Channel actions">
        <a className={styles.identityAction} href={link} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon size={16} />
          View channel
        </a>
        <button
          type="button"
          className={styles.identityAction}
          aria-expanded={editing}
          onClick={() => {
            setEditing((open) => !open);
            setDraft(draftOf(profile));
            setFeedback(null);
          }}
        >
          <EditIcon size={16} />
          {editing ? 'Cancel edit' : 'Edit channel'}
        </button>
        <button type="button" className={styles.identityAction} onClick={() => void copy()}>
          {feedback?.kind === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          {feedback?.kind === 'copied' ? 'Copied' : 'Copy channel link'}
        </button>
        <button type="button" className={styles.identityAction} onClick={() => void share()}>
          <ShareIcon size={16} />
          {feedback?.kind === 'shared' ? 'Shared' : features.share === undefined ? 'Share (copies the link)' : 'Share'}
        </button>
        <button type="button" className={styles.identityAction} aria-expanded={showQr} onClick={() => setShowQr((open) => !open)}>
          <QrIcon size={16} />
          {showQr ? 'Hide QR code' : 'QR code'}
        </button>
      </div>

      {feedback?.kind === 'saved' && <p role="status">Channel saved.</p>}
      {feedback?.kind === 'failed' && <p role="alert">{feedback.message}</p>}
      {showQr && <ChannelQr link={link} label={`QR code for ${link}`} />}

      {editing && (
        <form
          className={styles.identityForm}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor="identity-handle">@handle</label>
            <input
              id="identity-handle"
              value={current.handle}
              onChange={(event) => setDraft({ ...current, handle: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <p>Lowercase letters, digits and underscores, 3 to 24 characters. Your public page is /streams/{current.handle.trim().replace(/^@/, '').toLowerCase() || '...'}.</p>
          </div>
          <div>
            <label htmlFor="identity-name">Display name</label>
            <input id="identity-name" value={current.displayName} onChange={(event) => setDraft({ ...current, displayName: event.target.value })} />
          </div>
          <div>
            <label htmlFor="identity-description">Description</label>
            <textarea id="identity-description" rows={3} value={current.description} onChange={(event) => setDraft({ ...current, description: event.target.value })} />
          </div>
          <div>
            <label htmlFor="identity-category">Category</label>
            <select
              id="identity-category"
              value={current.category ?? ''}
              onChange={(event) => setDraft({ ...current, category: isChannelCategory(event.target.value) ? event.target.value : null })}
            >
              <option value="">{NO_CATEGORY_LABEL}</option>
              {CHANNEL_CATEGORIES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          {problems.length > 0 && (
            <ul role="alert" className={styles.identityProblems}>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <button type="submit" disabled={!dirty || problems.length > 0 || saving}>
            {saving ? 'Saving' : 'Save channel'}
          </button>
        </form>
      )}
    </section>
  );
}
