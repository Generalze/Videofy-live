/** @author masterzee001 */
/**
 * The controlled list of channel categories the phone can show.
 *
 * FOUNDER RULING (29 Aug 2026, LOCKED): "Categories are an explicit,
 * controlled channel-side field -- one primary category in v1, set by the
 * operator -- never inferred from follows, visibility or live state."
 *
 * The list of ids and labels is owned by packages/shared-types
 * (`CHANNEL_CATEGORIES`, `ChannelCategory`, `isChannelCategory`) so the
 * operator console, the web listener and the phone agree on one vocabulary
 * and one picker order. Nothing in the app may import a category id from
 * anywhere but here, so the vocabulary has exactly one source.
 */
export { CHANNEL_CATEGORIES, isChannelCategory, type ChannelCategory } from '@videofy-live/shared-types';
import type { CHANNEL_CATEGORIES as Categories } from '@videofy-live/shared-types';

export type ChannelCategoryEntry = (typeof Categories)[number];
