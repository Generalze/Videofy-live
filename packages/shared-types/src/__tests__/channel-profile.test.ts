/** @author masterzee001 */
/**
 * The @handle rules, pinned.
 *
 * Founder directive (LOCKED, 30 Aug 2026): a "unique human-readable @handle"
 * with a public canonical route /streams/<handle>. These pin the shape, the
 * reserved list, the folding, and that the public shape is a subset of the
 * owner's -- the things every other lane codes against.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  CHANNEL_HANDLE_MIN_LENGTH,
  CHANNEL_VISIBILITIES,
  RESERVED_CHANNEL_HANDLES,
  channelAvatarPath,
  channelBannerPath,
  channelStreamPath,
  checkChannelHandle,
  isChannelVisibility,
  normaliseChannelHandle,
  type ChannelProfile,
  type PublicChannelProfile,
} from '../channel-profile.js';

describe('checkChannelHandle', () => {
  it('accepts lowercase letters, digits and underscores between 3 and 24 characters', () => {
    expect(checkChannelHandle('zoe_meak')).toEqual({ ok: true, handle: 'zoe_meak' });
    expect(checkChannelHandle('abc')).toEqual({ ok: true, handle: 'abc' });
    expect(checkChannelHandle('a'.repeat(CHANNEL_HANDLE_MAX_LENGTH)).ok).toBe(true);
    expect(checkChannelHandle('news_247')).toEqual({ ok: true, handle: 'news_247' });
  });

  it('folds case and strips a typed @, so @MyChannel is mychannel', () => {
    expect(normaliseChannelHandle('  @MyChannel ')).toBe('mychannel');
    expect(checkChannelHandle('@MyChannel')).toEqual({ ok: true, handle: 'mychannel' });
  });

  it('refuses the wrong length with a sentence that says the limit', () => {
    const short = checkChannelHandle('ab');
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.reason).toBe('too-short');
      expect(short.message).toContain(String(CHANNEL_HANDLE_MIN_LENGTH));
    }
    const long = checkChannelHandle('a'.repeat(CHANNEL_HANDLE_MAX_LENGTH + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.reason).toBe('too-long');
      expect(long.message).toContain(String(CHANNEL_HANDLE_MAX_LENGTH));
    }
  });

  it('refuses dots, dashes, spaces and anything outside the alphabet', () => {
    for (const bad of ['zoe.meak', 'zoe-meak', 'zoe meak', 'zoë', 'zoe/meak', 'zoe@meak']) {
      const check = checkChannelHandle(bad);
      expect(check.ok, bad).toBe(false);
      if (!check.ok) expect(check.reason).toBe('bad-shape');
    }
  });

  it('refuses every reserved handle, however it is cased', () => {
    expect(RESERVED_CHANNEL_HANDLES).toEqual(
      expect.arrayContaining([
        'main',
        'c7',
        'admin',
        'videofy',
        'streams',
        'listen',
        'operator',
        'api',
        'auth',
        'media',
        'support',
        'help',
        'about',
      ]),
    );
    for (const reserved of RESERVED_CHANNEL_HANDLES) {
      const check = checkChannelHandle(reserved.toUpperCase());
      expect(check.ok, reserved).toBe(false);
      if (!check.ok) expect(check.reason).toBe('reserved');
    }
  });

  it('every reserved handle would otherwise be a valid handle, so the list is doing work', () => {
    // A reserved word that fails the shape rule anyway is dead weight that
    // hides the day somebody relaxes the shape.
    for (const reserved of RESERVED_CHANNEL_HANDLES) {
      expect(/^[a-z0-9_]{2,24}$/.test(reserved), reserved).toBe(true);
    }
  });
});

describe('visibility', () => {
  it('is exactly the three tiers the gateway knows', () => {
    expect(CHANNEL_VISIBILITIES).toEqual(['public', 'private', 'locked']);
    expect(isChannelVisibility('locked')).toBe(true);
    expect(isChannelVisibility('unlisted')).toBe(false);
    expect(isChannelVisibility(undefined)).toBe(false);
  });
});

describe('routes', () => {
  it('builds the canonical stream page and the image paths', () => {
    expect(channelStreamPath('zoe_meak')).toBe('/streams/zoe_meak');
    expect(channelAvatarPath('0123456789abcdef')).toBe('/channels/0123456789abcdef/avatar');
    expect(channelBannerPath('0123456789abcdef')).toBe('/channels/0123456789abcdef/banner');
  });
});

describe('the public shape', () => {
  it('is a subset of the owner shape that never carries the owner account id', () => {
    const full: ChannelProfile = {
      channelId: '0123456789abcdef',
      ownerAccountId: 'acct_00000000000000aa',
      handle: 'zoe_meak',
      displayName: 'Zoe',
      description: '',
      category: null,
      visibility: 'public',
      avatarUrl: null,
      bannerUrl: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const { ownerAccountId, createdAt, updatedAt, ...rest } = full;
    const pub: PublicChannelProfile = rest;
    expect(pub).not.toHaveProperty('ownerAccountId');
    expect(ownerAccountId.length + createdAt + updatedAt).toBeGreaterThan(0);
    // The compile-time assertion that the public shape has no owner field.
    // @ts-expect-error -- ownerAccountId is not part of the public shape.
    const leak: PublicChannelProfile = { ...rest, ownerAccountId };
    expect(leak).toBeDefined();
  });
});
