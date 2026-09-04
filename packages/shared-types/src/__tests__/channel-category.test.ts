/** @author masterzee001 */
/**
 * The controlled category list.
 *
 * Founder ruling (29 Aug 2026): a controlled channel-side field, one primary
 * category in v1. These pin that the list is exactly the agreed twelve, that
 * every id has a label, and that the guard refuses anything off the list.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CATEGORIES,
  channelCategoryLabel,
  isChannelCategory,
} from '../channel-category.js';

describe('the controlled channel category list', () => {
  it('is the agreed v1 list, in picker order', () => {
    expect(CHANNEL_CATEGORIES.map((entry) => entry.id)).toEqual([
      'news',
      'faith',
      'business',
      'education',
      'culture',
      'music',
      'sport',
      'community',
      'technology',
      'health',
      'government',
      'entertainment',
    ]);
  });

  it('gives every id a label people can read', () => {
    for (const entry of CHANNEL_CATEGORIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(channelCategoryLabel(entry.id)).toBe(entry.label);
    }
    expect(channelCategoryLabel('faith')).toBe('Faith');
  });

  it('accepts only ids on the list', () => {
    expect(isChannelCategory('news')).toBe(true);
    expect(isChannelCategory('entertainment')).toBe(true);
    expect(isChannelCategory('News')).toBe(false);
    expect(isChannelCategory('gossip')).toBe(false);
    expect(isChannelCategory('')).toBe(false);
    expect(isChannelCategory(null)).toBe(false);
    expect(isChannelCategory(undefined)).toBe(false);
    expect(isChannelCategory(3)).toBe(false);
  });
});
