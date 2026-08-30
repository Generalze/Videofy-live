/** @author masterzee001 */
/**
 * The channel identity in the top bar.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY: "the
 * operator shell always shows avatar, displayName, @handle, category,
 * channel status". The masters' top-right "OP" avatar cluster carries that
 * meaning now: the avatar is the CHANNEL's picture (initials when it has
 * none), the presence dot is the channel's live state, and the text beside
 * it is the display name over @handle and category.
 *
 * No state is invented. Loading says loading; no session says so; an
 * account with no profile says "Channel not set up" -- never a generated
 * name (directive: "never expose fallback names like 'Channel abc123'").
 */
import React from 'react';
import { channelCategoryLabel } from '@videofy-live/shared-types';
import { channelAvatarSrc, channelInitials, channelStatusWord, type ChannelIdentityState, type ChannelLiveState } from './channelIdentity';
import { ChevronDownIcon } from './icons';
import styles from './ChannelIdentity.module.css';

/** The picture or the initials, with the live dot. */
export function ChannelAvatar({
  state,
  live,
  accountUrl,
  size = 44,
}: {
  readonly state: ChannelIdentityState;
  readonly live: ChannelLiveState;
  readonly accountUrl: string;
  readonly size?: number | undefined;
}): React.ReactElement {
  const profile = state.status === 'ready' ? state.profile : null;
  const src = profile === null ? null : channelAvatarSrc(accountUrl, profile.avatarUrl);
  const initials = profile === null ? (state.status === 'loading' ? '' : '?') : channelInitials(profile.displayName);
  const dotClass = live === null ? styles.dotUnknown : live ? styles.dotLive : styles.dotOffAir;
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}>
      {src !== null ? (
        <img className={styles.avatarImage} src={src} alt="" width={size} height={size} />
      ) : (
        <span className={styles.avatarInitials} aria-hidden="true">
          {initials}
        </span>
      )}
      {profile !== null && <span className={`${styles.presence} ${dotClass}`} role="img" aria-label={channelStatusWord(live)} />}
    </span>
  );
}

export interface ChannelIdentityBadgeProps {
  readonly state: ChannelIdentityState;
  readonly live: ChannelLiveState;
  readonly accountUrl: string;
  /** When given, the badge is a button that opens the identity menu. */
  readonly onToggle?: (() => void) | undefined;
  readonly expanded?: boolean | undefined;
  readonly id?: string | undefined;
  readonly menuId?: string | undefined;
}

function lines(state: ChannelIdentityState, live: ChannelLiveState): { readonly primary: string; readonly secondary: string } {
  switch (state.status) {
    case 'loading':
      return { primary: 'Loading channel', secondary: 'Reading your channel profile' };
    case 'signed-out':
      return { primary: 'Not signed in', secondary: 'Sign in on C7 to load your channel' };
    case 'unset':
      return { primary: 'Channel not set up', secondary: 'Set it up on Access' };
    case 'error':
      return { primary: 'Channel unavailable', secondary: state.message };
    case 'ready': {
      const { handle, category } = state.profile;
      const parts = [`@${handle}`];
      if (category !== null) parts.push(channelCategoryLabel(category));
      parts.push(channelStatusWord(live));
      return { primary: state.profile.displayName, secondary: parts.join(' · ') };
    }
  }
}

export function ChannelIdentityBadge({ state, live, accountUrl, onToggle, expanded = false, id, menuId }: ChannelIdentityBadgeProps): React.ReactElement {
  const text = lines(state, live);
  const body = (
    <>
      <span className={styles.badgeText}>
        <span className={styles.badgePrimary}>{text.primary}</span>
        <span className={styles.badgeSecondary}>{text.secondary}</span>
      </span>
      <ChannelAvatar state={state} live={live} accountUrl={accountUrl} />
      {onToggle !== undefined && (
        <span className={styles.badgeChevron}>
          <ChevronDownIcon size={16} />
        </span>
      )}
    </>
  );
  if (onToggle === undefined) {
    return (
      <div id={id} className={styles.badge} data-identity-status={state.status}>
        {body}
      </div>
    );
  }
  return (
    <button
      id={id}
      type="button"
      className={`${styles.badge} ${styles.badgeButton}`}
      data-identity-status={state.status}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-controls={menuId}
      aria-label={`Channel: ${text.primary}. ${text.secondary}`}
      onClick={onToggle}
    >
      {body}
    </button>
  );
}
