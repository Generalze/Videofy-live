/** @author masterzee001 */
/**
 * The channel identity menu: View channel, Edit channel, Copy channel link,
 * Share, QR code (founder directive, LOCKED 30 Aug 2026, OPERATOR CHANNEL
 * IDENTITY). Every action is REAL:
 *
 *   View channel      opens /streams/<handle> on the public origin
 *   Edit channel      goes to the Access page, where the channel is edited
 *   Copy channel link writes /streams/<handle> to the clipboard
 *   Share             the Web Share API where the browser has it, else copy
 *   QR code           the same link, encoded here (premium/qr.ts), inline SVG
 *
 * Without a profile there is no link to view, copy, share or encode, so the
 * menu says what is true instead -- "Channel not set up" and the way to set
 * it up -- rather than greying out five buttons around a name it made up.
 */
import React, { useEffect, useState } from 'react';
import { channelCategoryLabel } from '@videofy-live/shared-types';
import { channelPublicLink, channelStatusWord, type ChannelIdentityState, type ChannelLiveState } from './channelIdentity';
import { ChannelAvatar } from './ChannelIdentityBadge';
import { defaultChannelMenuBrowser, type ChannelMenuBrowser } from './channelMenuBrowser';
import { CheckIcon, CopyIcon, EditIcon, ExternalLinkIcon, QrIcon, ShareIcon } from './icons';
import { encodeQr, qrSvgPath, qrViewBox } from './qr';
import styles from './ChannelIdentity.module.css';

export interface ChannelIdentityMenuProps {
  readonly state: ChannelIdentityState;
  readonly live: ChannelLiveState;
  readonly accountUrl: string;
  /** Where /streams/<handle> is served: the public site's origin. */
  readonly publicOrigin: string;
  readonly onEditChannel: () => void;
  readonly onClose: () => void;
  readonly onReload?: (() => void) | undefined;
  readonly browser?: ChannelMenuBrowser | undefined;
  readonly id?: string | undefined;
  readonly labelledBy?: string | undefined;
}

type Feedback = { readonly kind: 'copied' } | { readonly kind: 'shared' } | { readonly kind: 'failed'; readonly message: string } | null;

export function ChannelIdentityMenu({
  state,
  live,
  accountUrl,
  publicOrigin,
  onEditChannel,
  onClose,
  onReload,
  browser,
  id,
  labelledBy,
}: ChannelIdentityMenuProps): React.ReactElement {
  const [showQr, setShowQr] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (feedback === null || feedback.kind === 'failed') return undefined;
    const timer = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const features = browser ?? defaultChannelMenuBrowser();

  if (state.status !== 'ready') {
    return (
      <div id={id} role="dialog" aria-labelledby={labelledBy} className={styles.menu}>
        <div className={styles.menuEmpty}>
          <ChannelAvatar state={state} live={live} accountUrl={accountUrl} size={56} />
          {state.status === 'loading' && <p className={styles.menuEmptyTitle}>Loading your channel</p>}
          {state.status === 'signed-out' && (
            <>
              <p className={styles.menuEmptyTitle}>Not signed in</p>
              <p className={styles.menuEmptyText}>Sign in on C7 in this browser, then reload the console to load your channel.</p>
            </>
          )}
          {state.status === 'unset' && (
            <>
              <p className={styles.menuEmptyTitle}>Channel not set up</p>
              <p className={styles.menuEmptyText}>Your channel has no name or @handle yet. Set them on the Access page; the link, share and QR code appear once it has a handle.</p>
              <button type="button" className={styles.menuPrimary} onClick={onEditChannel}>
                <EditIcon size={16} />
                Set up channel
              </button>
            </>
          )}
          {state.status === 'error' && (
            <>
              <p className={styles.menuEmptyTitle}>Channel unavailable</p>
              <p className={styles.menuEmptyText}>{state.message}</p>
              {onReload !== undefined && (
                <button type="button" className={styles.menuPrimary} onClick={onReload}>
                  Try again
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const { profile } = state;
  const link = channelPublicLink(publicOrigin, profile.handle);

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
      // Cancelling the share sheet is not a failure worth a message.
      if (error instanceof Error && error.name === 'AbortError') return;
      await copy();
    }
  };

  return (
    <div id={id} role="dialog" aria-labelledby={labelledBy} className={styles.menu}>
      <div className={styles.menuIdentity}>
        <ChannelAvatar state={state} live={live} accountUrl={accountUrl} size={56} />
        <div className={styles.menuIdentityText}>
          <p className={styles.menuName}>{profile.displayName}</p>
          <p className={styles.menuHandle}>@{profile.handle}</p>
          <p className={styles.menuMeta}>
            <span className={`${styles.menuStatus} ${live === true ? styles.menuStatusLive : live === false ? styles.menuStatusOff : styles.menuStatusUnknown}`}>{channelStatusWord(live)}</span>
            {profile.category !== null && <span>{channelCategoryLabel(profile.category)}</span>}
            <span className={styles.menuVisibility}>{visibilityWord(profile.visibility)}</span>
          </p>
        </div>
      </div>
      <p className={styles.menuLink}>
        <span className={styles.menuLinkLabel}>Channel link</span>
        <code className={styles.menuLinkValue}>{link}</code>
      </p>
      <div role="menu" aria-label="Channel actions" className={styles.menuActions}>
        <a role="menuitem" className={styles.menuItem} href={link} target="_blank" rel="noopener noreferrer" onClick={onClose}>
          <ExternalLinkIcon size={18} />
          View channel
        </a>
        <button
          role="menuitem"
          type="button"
          className={styles.menuItem}
          onClick={() => {
            onEditChannel();
            onClose();
          }}
        >
          <EditIcon size={18} />
          Edit channel
        </button>
        <button role="menuitem" type="button" className={styles.menuItem} onClick={() => void copy()}>
          {feedback?.kind === 'copied' ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
          {feedback?.kind === 'copied' ? 'Copied' : 'Copy channel link'}
        </button>
        <button role="menuitem" type="button" className={styles.menuItem} onClick={() => void share()}>
          <ShareIcon size={18} />
          {feedback?.kind === 'shared' ? 'Shared' : features.share === undefined ? 'Share (copies the link)' : 'Share'}
        </button>
        <button role="menuitem" type="button" className={styles.menuItem} aria-expanded={showQr} onClick={() => setShowQr((current) => !current)}>
          <QrIcon size={18} />
          {showQr ? 'Hide QR code' : 'QR code'}
        </button>
      </div>
      {feedback?.kind === 'failed' && (
        <p role="alert" className={styles.menuFailure}>
          {feedback.message}
        </p>
      )}
      {showQr && <ChannelQr link={link} label={`QR code for ${link}`} />}
    </div>
  );
}

function visibilityWord(visibility: 'public' | 'private' | 'locked'): string {
  switch (visibility) {
    case 'public':
      return 'Public';
    case 'private':
      return 'Private by link';
    case 'locked':
      return 'Locked with a code';
  }
}

/** The link as a QR code, drawn inline; no image request, no dependency. */
export function ChannelQr({ link, label, size = 168 }: { readonly link: string; readonly label: string; readonly size?: number | undefined }): React.ReactElement {
  let matrix: ReturnType<typeof encodeQr> | null = null;
  try {
    matrix = encodeQr(link);
  } catch {
    matrix = null;
  }
  if (matrix === null) {
    return <p className={styles.menuFailure}>This link is too long for a QR code. Copy it instead.</p>;
  }
  return (
    <figure className={styles.qr}>
      <svg role="img" aria-label={label} viewBox={qrViewBox(matrix)} width={size} height={size} shapeRendering="crispEdges" className={styles.qrSvg}>
        <rect x={-4} y={-4} width={matrix.size + 8} height={matrix.size + 8} fill="#ffffff" />
        <path d={qrSvgPath(matrix)} fill="#0a0e17" />
      </svg>
      <figcaption className={styles.qrCaption}>Scan to open the channel</figcaption>
    </figure>
  );
}
