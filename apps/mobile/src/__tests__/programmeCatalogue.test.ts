/** @author masterzee001 */
/**
 * The catalogue's arithmetic: filter chips only for what is listed,
 * category chips only for what channels carry, the featured channel by
 * follower count, a bell press that means follow-with-reminder, and counts
 * that move only when they are known.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelSummary } from '../api/channelDirectory';
import { CHANNEL_CATEGORIES, type ChannelCategory } from '../programmes/channelCategories';
import {
  adjustInterest,
  categoryLabel,
  channelShareUrl,
  deriveCategoryChips,
  deriveFilters,
  describeVisibility,
  filterChannels,
  findChannel,
  followsReducer,
  formatInterest,
  handleLabel,
  initials,
  nowPlaying,
  resolveCategoryChoice,
  resolveFilter,
  selectFeatured,
  toggleIntent,
} from '../programmes/programmeCatalogue';

const first = CHANNEL_CATEGORIES[0] ?? { id: 'news' as ChannelCategory, label: 'News' };
const second = CHANNEL_CATEGORIES[1] ?? first;

const channel = (
  channelId: string,
  displayName: string,
  live: boolean,
  visibility: ChannelSummary['visibility'] = 'public',
  category: ChannelCategory | null = null,
  identity: Partial<Pick<ChannelSummary, 'handle' | 'avatarUrl' | 'currentProgramme'>> = {},
): ChannelSummary => ({
  channelId,
  displayName,
  live,
  visibility,
  category,
  handle: null,
  avatarUrl: null,
  currentProgramme: null,
  ...identity,
});

const townhall = channel('ch_town', 'Global Townhall', true);
const faith = channel('ch_faith', 'Faith Live', true, 'public', second.id);
const forum = channel('ch_forum', 'Ogun Forum', false, 'public', first.id);
const linkOnly = channel('ch_link', 'Board Room', false, 'private');

describe('initials', () => {
  it('takes the first letter of the first two words, upper-cased', () => {
    expect(initials('Global Townhall')).toBe('GT');
    expect(initials('  c7   newsroom  daily ')).toBe('CN');
    expect(initials('')).toBe('');
  });
});

describe('deriveFilters', () => {
  it('offers only filters some listed channel answers to, with All always first', () => {
    expect(deriveFilters([], {})).toEqual(['all']);
    expect(deriveFilters([townhall], {})).toEqual(['all', 'live', 'public']);
    expect(deriveFilters([forum], {})).toEqual(['all', 'public']);
    expect(deriveFilters([linkOnly], {})).toEqual(['all']);
    expect(deriveFilters([townhall, forum, linkOnly], {})).toEqual(['all', 'live', 'public']);
  });

  it('offers Following only when a listed channel is followed', () => {
    expect(deriveFilters([townhall], { ch_elsewhere: { channelId: 'ch_elsewhere', remind: true } })).not.toContain('following');
    expect(deriveFilters([townhall], { ch_town: { channelId: 'ch_town', remind: true } })).toEqual(['all', 'live', 'following', 'public']);
  });

  it('never offers a category as a filter', () => {
    const filters: readonly string[] = deriveFilters([forum, faith], {});
    for (const entry of CHANNEL_CATEGORIES) expect(filters).not.toContain(entry.id);
    expect(filters).not.toContain('link-only');
    expect(filters).not.toContain('off');
  });
});

describe('resolveFilter', () => {
  it('keeps a chip that is still offered and falls back to All when it vanished', () => {
    expect(resolveFilter('live', ['all', 'live'])).toBe('live');
    expect(resolveFilter('live', ['all', 'public'])).toBe('all');
  });
});

describe('deriveCategoryChips', () => {
  it('is empty when no listed channel carries a category, so no row is shown', () => {
    expect(deriveCategoryChips([])).toEqual([]);
    expect(deriveCategoryChips([townhall, linkOnly])).toEqual([]);
  });

  it('lists only the categories present, in the controlled order, never inferred from the name', () => {
    expect(deriveCategoryChips([faith, forum, townhall])).toEqual([first, second]);
    expect(deriveCategoryChips([faith])).toEqual([second]);
    expect(deriveCategoryChips([channel('ch_x', 'Sport News Faith', true)])).toEqual([]);
  });
});

describe('resolveCategoryChoice and categoryLabel', () => {
  it('keeps a chosen category while some channel carries it and clears it otherwise', () => {
    expect(resolveCategoryChoice(first.id, [first, second])).toBe(first.id);
    expect(resolveCategoryChoice(first.id, [second])).toBeNull();
    expect(resolveCategoryChoice(null, [first])).toBeNull();
  });

  it('labels a known id from the controlled list and nothing for none', () => {
    expect(categoryLabel(first.id)).toBe(first.label);
    expect(categoryLabel(null)).toBeNull();
  });
});

describe('filterChannels', () => {
  const all = [forum, faith, linkOnly, townhall];
  const ids = (input: Partial<Parameters<typeof filterChannels>[1]>) =>
    filterChannels(all, { filter: 'all', category: null, query: '', follows: {}, ...input }).map((c) => c.channelId);

  it('puts live channels first, then sorts by name', () => {
    expect(ids({})).toEqual(['ch_faith', 'ch_town', 'ch_link', 'ch_forum']);
  });

  it('honours each filter', () => {
    expect(ids({ filter: 'live' })).toEqual(['ch_faith', 'ch_town']);
    expect(ids({ filter: 'public' })).toEqual(['ch_faith', 'ch_town', 'ch_forum']);
    expect(ids({ filter: 'following', follows: { ch_forum: { channelId: 'ch_forum', remind: true } } })).toEqual(['ch_forum']);
  });

  it('a chosen category keeps only channels that carry it; none keeps everything', () => {
    expect(ids({ category: first.id })).toEqual(['ch_forum']);
    expect(ids({ category: second.id })).toEqual(['ch_faith']);
    expect(ids({ category: second.id, filter: 'live' })).toEqual(['ch_faith']);
    expect(ids({ category: first.id, filter: 'live' })).toEqual([]);
  });

  it('searches the display name, case-insensitively and trimmed', () => {
    expect(filterChannels(all, { filter: 'all', category: null, query: '  TOWN ', follows: {} })).toEqual([townhall]);
    expect(filterChannels(all, { filter: 'live', category: null, query: 'forum', follows: {} })).toEqual([]);
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

/* Founder directive A (30 Aug 2026): identity is read from the row, never invented. */
describe('handleLabel and nowPlaying', () => {
  it('prints a handle with its @ and nothing for none', () => {
    expect(handleLabel('c7_news')).toBe('@c7_news');
    expect(handleLabel(null)).toBeNull();
    expect(handleLabel('')).toBeNull();
  });

  it('names the programme on air only while the channel is live', () => {
    expect(nowPlaying({ live: true, currentProgramme: 'Evening Bulletin' })).toBe('Evening Bulletin');
    expect(nowPlaying({ live: false, currentProgramme: 'Evening Bulletin' })).toBeNull();
    expect(nowPlaying({ live: true, currentProgramme: null })).toBeNull();
    expect(nowPlaying({ live: true, currentProgramme: '   ' })).toBeNull();
  });
});

describe('channelShareUrl', () => {
  it('is the public /streams/<handle> page at the web origin', () => {
    expect(channelShareUrl('https://staging.consummate7.com', { handle: 'c7_news' })).toBe(
      'https://staging.consummate7.com/streams/c7_news',
    );
    expect(channelShareUrl('https://staging.consummate7.com/', { handle: 'c7_news' })).toBe(
      'https://staging.consummate7.com/streams/c7_news',
    );
  });

  /* Nothing canonical exists without a handle, so nothing is offered. */
  it('is nothing for a channel without a handle', () => {
    expect(channelShareUrl('https://staging.consummate7.com', { handle: null })).toBeNull();
  });
});

describe('searching by handle', () => {
  const named = channel('ch_named', 'Global Townhall', true, 'public', null, { handle: 'townhall_live' });

  it('matches the handle, with or without the @', () => {
    const ids = (query: string) =>
      filterChannels([named, forum], { filter: 'all', category: null, query, follows: {} }).map((c) => c.channelId);
    expect(ids('@townhall')).toEqual(['ch_named']);
    expect(ids('hall_live')).toEqual(['ch_named']);
    expect(ids('ogun')).toEqual(['ch_forum']);
    expect(ids('@nobody')).toEqual([]);
  });
});
