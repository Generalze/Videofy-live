/** @author masterzee001 */
/**
 * The catalogue's arithmetic: chips only for what is listed, the featured
 * channel by follower count, a bell press that means follow-with-reminder,
 * and counts that move only when they are known.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelSummary } from '../api/channelDirectory';
import {
  adjustInterest,
  deriveCategories,
  describeVisibility,
  filterChannels,
  findChannel,
  followsReducer,
  formatInterest,
  initials,
  resolveCategory,
  selectFeatured,
  toggleIntent,
} from '../programmes/programmeCatalogue';

const channel = (channelId: string, displayName: string, live: boolean, visibility: ChannelSummary['visibility'] = 'public'): ChannelSummary => ({
  channelId,
  displayName,
  live,
  visibility,
});

const townhall = channel('ch_town', 'Global Townhall', true);
const faith = channel('ch_faith', 'Faith Live', true);
const forum = channel('ch_forum', 'Ogun Forum', false);
const linkOnly = channel('ch_link', 'Board Room', false, 'private');

describe('initials', () => {
  it('takes the first letter of the first two words, upper-cased', () => {
    expect(initials('Global Townhall')).toBe('GT');
    expect(initials('  c7   newsroom  daily ')).toBe('CN');
    expect(initials('')).toBe('');
  });
});

describe('deriveCategories', () => {
  it('offers only chips some listed channel answers to, with All always first', () => {
    expect(deriveCategories([], {})).toEqual(['all']);
    expect(deriveCategories([townhall], {})).toEqual(['all', 'live', 'public']);
    expect(deriveCategories([forum], {})).toEqual(['all', 'off', 'public']);
    expect(deriveCategories([townhall, forum, linkOnly], {})).toEqual(['all', 'live', 'off', 'public', 'link-only']);
  });

  it('offers Following only when a listed channel is followed', () => {
    expect(deriveCategories([townhall], { ch_elsewhere: { channelId: 'ch_elsewhere', remind: true } })).not.toContain('following');
    expect(deriveCategories([townhall], { ch_town: { channelId: 'ch_town', remind: true } })).toContain('following');
  });
});

describe('resolveCategory', () => {
  it('keeps a chip that is still offered and falls back to All when it vanished', () => {
    expect(resolveCategory('live', ['all', 'live'])).toBe('live');
    expect(resolveCategory('live', ['all', 'off'])).toBe('all');
  });
});

describe('filterChannels', () => {
  const all = [forum, faith, linkOnly, townhall];

  it('puts live channels first, then sorts by name', () => {
    expect(filterChannels(all, { category: 'all', query: '', follows: {} }).map((c) => c.channelId)).toEqual([
      'ch_faith',
      'ch_town',
      'ch_link',
      'ch_forum',
    ]);
  });

  it('honours each category', () => {
    const ids = (category: Parameters<typeof filterChannels>[1]['category'], follows = {}) =>
      filterChannels(all, { category, query: '', follows }).map((c) => c.channelId);
    expect(ids('live')).toEqual(['ch_faith', 'ch_town']);
    expect(ids('off')).toEqual(['ch_link', 'ch_forum']);
    expect(ids('public')).toEqual(['ch_faith', 'ch_town', 'ch_forum']);
    expect(ids('link-only')).toEqual(['ch_link']);
    expect(ids('following', { ch_forum: { channelId: 'ch_forum', remind: true } })).toEqual(['ch_forum']);
  });

  it('searches the display name, case-insensitively and trimmed', () => {
    expect(filterChannels(all, { category: 'all', query: '  TOWN ', follows: {} })).toEqual([townhall]);
    expect(filterChannels(all, { category: 'off', query: 'town', follows: {} })).toEqual([]);
  });
});

describe('selectFeatured', () => {
  it('is the live channel with the most followers', () => {
    expect(selectFeatured([forum, faith, townhall], { ch_town: 12, ch_faith: 40, ch_forum: 999 })).toBe(faith);
  });

  it('never features an off-air channel, however popular', () => {
    expect(selectFeatured([forum], { ch_forum: 999 })).toBeNull();
    expect(selectFeatured([], {})).toBeNull();
  });

  it('reads unknown counts as zero and breaks ties by name, so the choice is stable', () => {
    expect(selectFeatured([townhall, faith], {})).toBe(faith);
    expect(selectFeatured([townhall, faith], { ch_town: 0 })).toBe(faith);
    expect(selectFeatured([townhall, faith], { ch_town: 1 })).toBe(townhall);
  });
});

describe('formatInterest', () => {
  it('shows nothing for an unknown count rather than a guess', () => {
    expect(formatInterest(undefined)).toBeNull();
    expect(formatInterest(-1)).toBeNull();
    expect(formatInterest(Number.NaN)).toBeNull();
  });

  it('formats plain and compact counts', () => {
    expect(formatInterest(0)).toBe('0 interested');
    expect(formatInterest(7)).toBe('7 interested');
    expect(formatInterest(999)).toBe('999 interested');
    expect(formatInterest(1000)).toBe('1K interested');
    expect(formatInterest(2437)).toBe('2.4K interested');
    expect(formatInterest(12050)).toBe('12K interested');
  });
});

describe('followsReducer', () => {
  it('loads the server list into a map by channel id', () => {
    const state = followsReducer({}, { kind: 'loaded', follows: [{ channelId: 'a', remind: true }, { channelId: 'b', remind: false }] });
    expect(state).toEqual({ a: { channelId: 'a', remind: true }, b: { channelId: 'b', remind: false } });
  });

  it('sets and removes one follow without touching the others', () => {
    const loaded = followsReducer({}, { kind: 'loaded', follows: [{ channelId: 'a', remind: true }] });
    const added = followsReducer(loaded, { kind: 'set', channelId: 'b', follow: { channelId: 'b', remind: true } });
    expect(Object.keys(added)).toEqual(['a', 'b']);
    const removed = followsReducer(added, { kind: 'set', channelId: 'a', follow: null });
    expect(removed).toEqual({ b: { channelId: 'b', remind: true } });
  });

  it('removing a follow that is not there returns the same state', () => {
    const state = followsReducer({}, { kind: 'loaded', follows: [] });
    expect(followsReducer(state, { kind: 'set', channelId: 'zz', follow: null })).toBe(state);
  });
});

describe('toggleIntent', () => {
  it('not following -> follow with the reminder on; that is what Interested means', () => {
    expect(toggleIntent({}, 'a')).toEqual({ following: true, remind: true });
  });

  it('following -> unfollow, with remind left out', () => {
    expect(toggleIntent({ a: { channelId: 'a', remind: true } }, 'a')).toEqual({ following: false, remind: undefined });
  });
});

describe('adjustInterest', () => {
  it('moves a known count and leaves an unknown one unknown', () => {
    expect(adjustInterest({ a: 3 }, 'a', 1)).toEqual({ a: 4 });
    expect(adjustInterest({ a: 3 }, 'a', -1)).toEqual({ a: 2 });
    const unknown = { b: 1 };
    expect(adjustInterest(unknown, 'a', 1)).toBe(unknown);
  });

  it('never goes below zero', () => {
    expect(adjustInterest({ a: 0 }, 'a', -1)).toEqual({ a: 0 });
  });
});

describe('findChannel and describeVisibility', () => {
  it('finds a listed channel by id and nothing otherwise', () => {
    expect(findChannel([townhall, forum], 'ch_forum')).toBe(forum);
    expect(findChannel([townhall], 'ch_nope')).toBeNull();
  });

  it('names each visibility as the web does', () => {
    expect(describeVisibility('public')).toBe('Public');
    expect(describeVisibility('private')).toBe('Private · Link-only');
    expect(describeVisibility('locked')).toBe('Locked');
  });
});
