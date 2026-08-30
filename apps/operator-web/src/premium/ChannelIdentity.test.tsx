/** @author masterzee001 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { channelStatusWord, type ChannelIdentityState } from './channelIdentity';
import { ChannelIdentityBadge } from './ChannelIdentityBadge';
import { ChannelIdentityMenu, ChannelQr } from './ChannelIdentityMenu';

const READY: ChannelIdentityState = {
  status: 'ready',
  profile: {
    channelId: 'ch_1',
    ownerAccountId: 'acct_1',
    handle: 'faith_hour',
    displayName: 'Faith Hour',
    description: 'Sunday service, translated.',
    category: 'faith',
    visibility: 'locked',
    avatarUrl: '/channels/ch_1/avatar?v=2',
    bannerUrl: null,
    createdAt: 1,
    updatedAt: 2,
  },
};

const noop = (): void => undefined;

describe('ChannelIdentityBadge', () => {
  it('shows the picture when there is one and the initials when there is not', () => {
    const withPicture = renderToStaticMarkup(<ChannelIdentityBadge state={READY} live={true} accountUrl="https://c7.test/auth" />);
    expect(withPicture).toContain('src="https://c7.test/auth/channels/ch_1/avatar?v=2"');
    expect(withPicture).toContain('Faith Hour');
    expect(withPicture).toContain('@faith_hour · Faith · Live');

    const noPicture = renderToStaticMarkup(
      <ChannelIdentityBadge state={{ ...READY, profile: { ...READY.profile, avatarUrl: null } }} live={false} accountUrl="https://c7.test/auth" />,
    );
    expect(noPicture).toContain('>FH<');
    expect(noPicture).toContain('Off air');
  });

  it('is a menu button when given a toggle, and names the state for assistive technology', () => {
    const html = renderToStaticMarkup(<ChannelIdentityBadge state={{ status: 'unset' }} live={null} accountUrl="x" onToggle={noop} expanded={false} menuId="m" />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Channel: Channel not set up. Set it up on Access');
    expect(channelStatusWord(null)).toBe('Status unknown');
  });

  it('opens the sign-in dialog when signed out or expired, and never tells anybody to reload', () => {
    const signedOut = renderToStaticMarkup(<ChannelIdentityBadge state={{ status: 'signed-out' }} live={null} accountUrl="x" onToggle={noop} onSignIn={noop} />);
    expect(signedOut).toContain('aria-haspopup="dialog"');
    expect(signedOut).toContain('>Sign in<');
    expect(signedOut).not.toContain('reload');

    const expired = renderToStaticMarkup(<ChannelIdentityBadge state={{ status: 'signed-out', expired: true }} live={null} accountUrl="x" onToggle={noop} onSignIn={noop} />);
    expect(expired).toContain('>Session expired<');
    expect(expired).toContain('Sign in again to load your channel');
    expect(expired).toContain('data-session-expired="true"');
    expect(expired).not.toContain('reload');
  });
});

describe('ChannelIdentityMenu', () => {
  const props = { live: false, accountUrl: 'https://c7.test/auth', publicOrigin: 'https://c7.test/', onEditChannel: noop, onClose: noop };

  it('offers View, Edit, Copy, Share and QR around the canonical /streams/<handle> link', () => {
    const html = renderToStaticMarkup(<ChannelIdentityMenu state={READY} {...props} browser={{ copyText: async () => undefined }} />);
    expect(html).toContain('href="https://c7.test/streams/faith_hour"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('View channel');
    expect(html).toContain('Edit channel');
    expect(html).toContain('Copy channel link');
    expect(html).toContain('Share (copies the link)');
    expect(html).toContain('QR code');
    expect(html).toContain('Locked with a code');
    expect(html).toContain('Faith');
  });

  it('says Share plainly when the browser has the Web Share API', () => {
    const html = renderToStaticMarkup(<ChannelIdentityMenu state={READY} {...props} browser={{ copyText: async () => undefined, share: async () => undefined }} />);
    expect(html).toContain('>Share<');
  });

  it('tells an account without a profile how to set one up instead of inventing a name', () => {
    const html = renderToStaticMarkup(<ChannelIdentityMenu state={{ status: 'unset' }} {...props} />);
    expect(html).toContain('Channel not set up');
    expect(html).toContain('Set up channel');
    expect(html).not.toContain('View channel');
    expect(html).not.toContain('/streams/');
  });

  it('offers Sign in when signed out, Sign in again when expired, and Sign out when ready', () => {
    const signedOut = renderToStaticMarkup(<ChannelIdentityMenu state={{ status: 'signed-out' }} {...props} onSignIn={noop} />);
    expect(signedOut).toContain('Not signed in');
    expect(signedOut).toContain('>Sign in<');
    expect(signedOut).not.toContain('reload');
    const expired = renderToStaticMarkup(<ChannelIdentityMenu state={{ status: 'signed-out', expired: true }} {...props} onSignIn={noop} />);
    expect(expired).toContain('Session expired');
    expect(expired).toContain('Sign in again');
    const ready = renderToStaticMarkup(<ChannelIdentityMenu state={READY} {...props} onSignOut={noop} browser={{ copyText: async () => undefined }} />);
    expect(ready).toContain('Sign out');
  });

  it('renders the QR code inline as SVG', () => {
    const html = renderToStaticMarkup(<ChannelQr link="https://c7.test/streams/faith_hour" label="QR" />);
    expect(html).toContain('<svg');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('Scan to open the channel');
  });
});
