/** @author masterzee001 */
/**
 * The directory wire read defensively: a category is kept only when it is
 * a known id, and never invented from anything else on the row.
 */
import { describe, expect, it } from 'vitest';
import {
  channelAvatarUri,
  parseChannelDirectory,
  parseChannelSummary,
  streamsUrlFor,
} from '../api/channelDirectory';
import { CHANNEL_CATEGORIES } from '../programmes/channelCategories';

const known = CHANNEL_CATEGORIES[0]?.id ?? 'news';

describe('parseChannelSummary', () => {
  it('reads a known category and nulls an absent or unknown one', () => {
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: true, visibility: 'public', category: known })?.category).toBe(known);
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: true, visibility: 'public' })?.category).toBeNull();
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: true, visibility: 'public', category: 'not-a-category' })?.category).toBeNull();
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: true, visibility: 'public', category: 42 })?.category).toBeNull();
  });

  it('never infers a category from the name, visibility or live flag', () => {
    const row = parseChannelSummary({ channelId: 'ch_news', displayName: 'News Live', live: true, visibility: 'public' });
    expect(row?.category).toBeNull();
  });

  it('drops rows that are not channels', () => {
    expect(parseChannelSummary(null)).toBeNull();
    expect(parseChannelSummary('ch_a')).toBeNull();
    expect(parseChannelSummary({ channelId: 'a' })).toBeNull();
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', visibility: 'secret' })).toBeNull();
  });

  it('reads live strictly as true', () => {
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: 'yes', visibility: 'public' })?.live).toBe(false);
    expect(parseChannelSummary({ channelId: 'a', displayName: 'A', live: true, visibility: 'locked' })?.live).toBe(true);
  });
});

describe('parseChannelDirectory', () => {
  it('keeps the rows that parse, in order, and reads anything else as empty', () => {
    const rows = parseChannelDirectory([
      { channelId: 'b', displayName: 'B', live: false, visibility: 'private' },
      'garbage',
      { channelId: 'a', displayName: 'A', live: true, visibility: 'public', category: known },
    ]);
    expect(rows.map((row) => row.channelId)).toEqual(['b', 'a']);
    expect(parseChannelDirectory({ channels: [] })).toEqual([]);
    expect(parseChannelDirectory(null)).toEqual([]);
  });
});

/* Founder directive A (30 Aug 2026): identity is read from the row, never invented. */
describe('the persisted identity on a row', () => {
  const row = { channelId: 'a', displayName: 'C7 Newsroom', live: true, visibility: 'public' };

  it('keeps a handle, a picture path and the programme on air', () => {
    const parsed = parseChannelSummary({
      ...row,
      handle: 'c7_news',
      avatarUrl: '/channels/a/avatar?v=3',
      currentProgramme: 'Evening Bulletin',
    });
    expect(parsed?.handle).toBe('c7_news');
    expect(parsed?.avatarUrl).toBe('/channels/a/avatar?v=3');
    expect(parsed?.currentProgramme).toBe('Evening Bulletin');
  });

  it('reads absent identity as null, never undefined', () => {
    const parsed = parseChannelSummary(row);
    expect(parsed).toEqual({
      channelId: 'a',
      displayName: 'C7 Newsroom',
      live: true,
      visibility: 'public',
      category: null,
      handle: null,
      avatarUrl: null,
      currentProgramme: null,
    });
  });

  it('nulls a handle off the shape and blank text', () => {
    expect(parseChannelSummary({ ...row, handle: 'Not A Handle' })?.handle).toBeNull();
    expect(parseChannelSummary({ ...row, handle: 'ab' })?.handle).toBeNull();
    expect(parseChannelSummary({ ...row, handle: 42 })?.handle).toBeNull();
    expect(parseChannelSummary({ ...row, avatarUrl: '' })?.avatarUrl).toBeNull();
    expect(parseChannelSummary({ ...row, currentProgramme: '  ' })?.currentProgramme).toBeNull();
  });
});

describe('the links built from identity', () => {
  it('shares the public /streams/<handle> page', () => {
    expect(streamsUrlFor('https://staging.consummate7.com', 'c7_news')).toBe(
      'https://staging.consummate7.com/streams/c7_news',
    );
    expect(streamsUrlFor('https://staging.consummate7.com/', 'c7_news')).toBe(
      'https://staging.consummate7.com/streams/c7_news',
    );
  });

  it('fetches the picture from the account service', () => {
    expect(channelAvatarUri('https://staging.consummate7.com/auth', '/channels/a/avatar')).toBe(
      'https://staging.consummate7.com/auth/channels/a/avatar',
    );
    expect(channelAvatarUri('https://staging.consummate7.com/auth/', 'channels/a/avatar')).toBe(
      'https://staging.consummate7.com/auth/channels/a/avatar',
    );
    expect(channelAvatarUri('https://staging.consummate7.com/auth', 'https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(channelAvatarUri('https://staging.consummate7.com/auth', null)).toBeNull();
  });
});
