/** @author masterzee001 */
/**
 * Channel identity, at the service seam: the default handle a username
 * yields, that a claim is idempotent and survives a handle collision, that
 * an edit names the exact rule it broke, and that the public shape never
 * carries the owner.
 *
 * Founder directive (LOCKED, 30 Aug 2026): "every entitled operator lands
 * automatically on their own persistent channel"; "unique human-readable
 * @handle"; "never expose fallback names like 'Channel abc123' when an
 * identity exists".
 */
import { describe, expect, it } from 'vitest';
import { checkUsernameShape } from '@videofy-live/account-trust';
import {
  ChannelProfiles,
  createInMemoryChannelImageStore,
  createInMemoryChannelProfilePort,
  defaultChannelHandleCandidates,
  deriveChannelHandle,
  toChannelProfile,
  toPublicChannelProfile,
  validateChannelProfileUpdate,
  type ChannelProfileRecord,
} from '../channel-profiles.js';

const A = 'acct_00000000000000aa';
const B = 'acct_00000000000000bb';
const CHANNEL_A = '0123456789abcdef';
const CHANNEL_B = 'fedcba9876543210';

function service(now = { ms: 1_700_000_000_000 }): ChannelProfiles {
  return new ChannelProfiles({
    port: createInMemoryChannelProfilePort(),
    images: createInMemoryChannelImageStore(),
    nowMs: () => now.ms,
  });
}

describe('deriveChannelHandle', () => {
  it('strips the prefix the real username rules add, so the two cannot drift', () => {
    const shape = checkUsernameShape('zoe.meak');
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.username.startsWith('c7')).toBe(true);
    expect(deriveChannelHandle(shape.username)).toBe('zoe_meak');
  });

  it('is the chosen part of the C7 username, dots folded to underscores', () => {
    expect(deriveChannelHandle('c7zoemeak')).toBe('zoemeak');
    expect(deriveChannelHandle('c7zoe.meak')).toBe('zoe_meak');
    expect(deriveChannelHandle('c7zoe_meak')).toBe('zoe_meak');
    expect(deriveChannelHandle('zoemeak')).toBe('zoemeak');
  });

  it('keeps a reserved or too-short result off the platform names', () => {
    expect(deriveChannelHandle('c7main')).toBe('main_channel');
    expect(deriveChannelHandle('c7api')).toBe('api_channel');
  });

  it('fits a thirty-character username into the twenty-four-character handle', () => {
    const handle = deriveChannelHandle(`c7${'a'.repeat(30)}`);
    expect(handle).toBe('a'.repeat(24));
  });

  it('falls back on id-suffixed candidates when there is no username', () => {
    const candidates = defaultChannelHandleCandidates(null, CHANNEL_A);
    expect(candidates).toEqual(['ch_0123456789ab', 'ch_0123456789abcdef']);
    for (const candidate of candidates) expect(candidate.length).toBeLessThanOrEqual(24);
  });

  it('suffixes the username handle with a piece of the opaque id as later candidates', () => {
    expect(defaultChannelHandleCandidates('c7zoemeak', CHANNEL_A)).toEqual([
      'zoemeak',
      'zoemeak_0123',
      'zoemeak_01234567',
    ]);
  });
});

describe('claiming a channel', () => {
  it('creates the profile with the username handle and the display name, once', async () => {
    const profiles = service();
    const first = await profiles.claim({
      channelId: CHANNEL_A,
      ownerAccountId: A,
      username: 'c7zoe.meak',
      displayName: 'Zoe Meak',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.profile.handle).toBe('zoe_meak');
    expect(first.profile.displayName).toBe('Zoe Meak');
    expect(first.profile.visibility).toBe('public');
    expect(first.profile.category).toBeNull();

    const again = await profiles.claim({
      channelId: CHANNEL_A,
      ownerAccountId: A,
      username: 'c7zoe.meak',
      displayName: 'Zoe Meak',
    });
    expect(again).toEqual({ ok: true, profile: first.profile, created: false });
  });

  it('shows the username as the name when no display name is chosen, never "Channel abc123"', async () => {
    const claim = await service().claim({
      channelId: CHANNEL_A,
      ownerAccountId: A,
      username: 'c7zoemeak',
      displayName: null,
    });
    expect(claim.ok && claim.profile.displayName).toBe('zoemeak');
  });

  it('answers the second claim with the persisted identity, not the defaults of the moment', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: 'Zoe' });
    await profiles.update(A, { handle: 'zoe_live', displayName: 'Zoe Live' });
    const again = await profiles.claim({
      channelId: CHANNEL_A,
      ownerAccountId: A,
      username: 'c7zoemeak',
      displayName: 'Something Else',
    });
    expect(again.ok && again.profile.handle).toBe('zoe_live');
    expect(again.ok && again.profile.displayName).toBe('Zoe Live');
  });

  it('gives the second of two usernames that fold to one handle an id-suffixed handle', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoe.meak', displayName: null });
    const second = await profiles.claim({
      channelId: CHANNEL_B,
      ownerAccountId: B,
      username: 'c7zoe_meak',
      displayName: null,
    });
    expect(second.ok && second.profile.handle).toBe('zoe_meak_fedc');
  });

  it('refuses a channel that belongs to somebody else, and a second channel for one owner', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    expect(
      await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: B, username: 'c7other', displayName: null }),
    ).toEqual({ ok: false, reason: 'channel-owned-elsewhere' });
    expect(
      await profiles.claim({ channelId: CHANNEL_B, ownerAccountId: A, username: 'c7zoemeak', displayName: null }),
    ).toEqual({ ok: false, reason: 'owner-has-another-channel' });
  });
});

describe('validateChannelProfileUpdate', () => {
  it('names the exact rule broken', () => {
    const cases: [unknown, string][] = [
      [{ handle: 'ab' }, 'Handles are at least 3 characters.'],
      [{ handle: 'a'.repeat(25) }, 'Handles are at most 24 characters.'],
      [{ handle: 'zoe-meak' }, 'Use lowercase letters, numbers and underscores.'],
      [{ handle: 'streams' }, 'That handle is reserved.'],
      [{ handle: 42 }, 'handle must be text.'],
      [{ displayName: '   ' }, 'Give the channel a name.'],
      [{ displayName: 'x'.repeat(81) }, 'Channel names are at most 80 characters.'],
      [{ description: 'x'.repeat(501) }, 'Descriptions are at most 500 characters.'],
      [{ category: 'gossip' }, 'Choose a category from the list.'],
      [{ visibility: 'unlisted' }, 'Visibility is public, private or locked.'],
    ];
    for (const [body, message] of cases) {
      expect(validateChannelProfileUpdate(body), JSON.stringify(body)).toEqual({ ok: false, message });
    }
  });

  it('folds a handle, trims text, and lets null clear the category', () => {
    expect(
      validateChannelProfileUpdate({
        handle: '@Zoe_Meak',
        displayName: '  Zoe  ',
        description: ' hello ',
        category: null,
        visibility: 'locked',
        somethingNewer: true,
      }),
    ).toEqual({
      ok: true,
      patch: { handle: 'zoe_meak', displayName: 'Zoe', description: 'hello', category: null, visibility: 'locked' },
    });
    expect(validateChannelProfileUpdate({ category: 'faith' })).toEqual({ ok: true, patch: { category: 'faith' } });
    expect(validateChannelProfileUpdate(undefined)).toEqual({ ok: true, patch: {} });
  });
});

describe('editing', () => {
  it('refuses a handle another channel holds, whatever the case', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    await profiles.claim({ channelId: CHANNEL_B, ownerAccountId: B, username: 'c7other', displayName: null });
    expect(await profiles.update(B, { handle: 'ZoeMeak' })).toEqual({
      ok: false,
      reason: 'handle-taken',
      message: 'That handle is taken.',
    });
    // Keeping your own handle is not taking it.
    expect((await profiles.update(A, { handle: 'ZOEMEAK' })).ok).toBe(true);
  });

  it('is by owner: an account without a channel edits nothing', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    expect((await profiles.update(B, { displayName: 'Mine now' })).ok).toBe(false);
    expect((await profiles.mine(A))?.displayName).toBe('zoemeak');
  });

  it('stamps updatedAt and leaves absent fields alone', async () => {
    const now = { ms: 1_000 };
    const profiles = service(now);
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: 'Zoe' });
    now.ms = 2_000;
    const result = await profiles.update(A, { description: 'Morning news' });
    expect(result.ok && result.profile).toMatchObject({
      displayName: 'Zoe',
      handle: 'zoemeak',
      description: 'Morning news',
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    });
  });

  it('mirrors visibility by channel id for the gateway', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    expect((await profiles.setVisibility(CHANNEL_A, 'locked')).ok).toBe(true);
    expect((await profiles.byId(CHANNEL_A))?.visibility).toBe('locked');
    expect((await profiles.setVisibility(CHANNEL_B, 'locked')).ok).toBe(false);
  });

  it('finds by handle case-insensitively and by id', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    expect((await profiles.byHandle('@ZoeMeak'))?.channelId).toBe(CHANNEL_A);
    expect(await profiles.byHandle('nobody')).toBeNull();
    expect((await profiles.byIds([CHANNEL_A, CHANNEL_B])).size).toBe(1);
  });
});

describe('pictures', () => {
  it('stores the bytes, stamps a versioned URL, and clears both on removal', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const set = await profiles.setImage(A, 'avatar', 'image/png', png);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(toChannelProfile(set.profile).avatarUrl).toMatch(/^\/channels\/0123456789abcdef\/avatar\?v=[0-9a-f]{12}$/);
    expect(toChannelProfile(set.profile).bannerUrl).toBeNull();
    expect(await profiles.image(CHANNEL_A, 'avatar')).toEqual({ mime: 'image/png', bytes: png });

    const cleared = await profiles.clearImage(A, 'avatar');
    expect(cleared.ok && toChannelProfile(cleared.profile).avatarUrl).toBeNull();
    expect(await profiles.image(CHANNEL_A, 'avatar')).toBeNull();
  });

  it('a new upload gets a new version, so the old URL stops matching', async () => {
    const profiles = service();
    await profiles.claim({ channelId: CHANNEL_A, ownerAccountId: A, username: 'c7zoemeak', displayName: null });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const first = await profiles.setImage(A, 'banner', 'image/jpeg', jpeg);
    const second = await profiles.setImage(A, 'banner', 'image/jpeg', jpeg);
    expect(first.ok && second.ok && first.profile.bannerRef !== second.profile.bannerRef).toBe(true);
  });
});

describe('the wire shapes', () => {
  const record: ChannelProfileRecord = {
    channelId: CHANNEL_A,
    ownerAccountId: A,
    handle: 'zoemeak',
    displayName: 'Zoe',
    description: 'Morning news',
    category: 'news',
    visibility: 'public',
    avatarRef: 'abc123',
    bannerRef: null,
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  it('the owner shape carries everything, with image URLs and epoch times', () => {
    expect(toChannelProfile(record)).toEqual({
      channelId: CHANNEL_A,
      ownerAccountId: A,
      handle: 'zoemeak',
      displayName: 'Zoe',
      description: 'Morning news',
      category: 'news',
      visibility: 'public',
      avatarUrl: '/channels/0123456789abcdef/avatar?v=abc123',
      bannerUrl: null,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it('the public shape never carries the owner account id', () => {
    const pub = toPublicChannelProfile(record);
    expect(pub).toEqual({
      channelId: CHANNEL_A,
      handle: 'zoemeak',
      displayName: 'Zoe',
      description: 'Morning news',
      category: 'news',
      visibility: 'public',
      avatarUrl: '/channels/0123456789abcdef/avatar?v=abc123',
      bannerUrl: null,
    });
    expect(JSON.stringify(pub)).not.toContain(A);
  });
});
