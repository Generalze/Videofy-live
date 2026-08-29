/** @author masterzee001 */
/**
 * The directory wire read defensively: a category is kept only when it is
 * a known id, and never invented from anything else on the row.
 */
import { describe, expect, it } from 'vitest';
import { parseChannelDirectory, parseChannelSummary } from '../api/channelDirectory';
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
