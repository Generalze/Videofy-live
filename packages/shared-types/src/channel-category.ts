/** @author masterzee001 */
/**
 * Channel categories: an explicit, controlled, channel-side field.
 *
 * Founder ruling (29 Aug 2026): "Channel categories: explicit server field.
 * Do not infer semantic categories from follows, visibility or live status.
 * Add a controlled channel-side category field, one primary category in v1."
 *
 * So the category is something an operator SAYS about their channel, held on
 * the server and carried to every client in ChannelSummary. Nothing here, and
 * nothing downstream, derives it from who follows a channel, whether it is
 * public, or whether it is on air right now: a live public channel with no
 * category chosen is uncategorised, and a client shows it that way.
 *
 * The list is the whole truth. A value off it is not a category, which is
 * what lets the gateway refuse it by name and what keeps the console and the
 * gateway from ever disagreeing about the options. Adding a category means
 * adding it here, once.
 */

const CHANNEL_CATEGORY_IDS = [
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
] as const;

/** One of the controlled category ids. The wire value; never shown raw. */
export type ChannelCategory = (typeof CHANNEL_CATEGORY_IDS)[number];

/**
 * The controlled list, in the order a picker shows it.
 *
 * `label` is what people read; `id` is what travels. Kept together so a
 * label cannot drift from its id across the console, the viewer and the app.
 */
export const CHANNEL_CATEGORIES: readonly { readonly id: ChannelCategory; readonly label: string }[] = [
  { id: 'news', label: 'News' },
  { id: 'faith', label: 'Faith' },
  { id: 'business', label: 'Business' },
  { id: 'education', label: 'Education' },
  { id: 'culture', label: 'Culture' },
  { id: 'music', label: 'Music' },
  { id: 'sport', label: 'Sport' },
  { id: 'community', label: 'Community' },
  { id: 'technology', label: 'Technology' },
  { id: 'health', label: 'Health' },
  { id: 'government', label: 'Government' },
  { id: 'entertainment', label: 'Entertainment' },
];

/** Whether an untrusted value is one of the controlled category ids. */
export function isChannelCategory(value: unknown): value is ChannelCategory {
  return typeof value === 'string' && (CHANNEL_CATEGORY_IDS as readonly string[]).includes(value);
}

/** The label people read for a category id. */
export function channelCategoryLabel(category: ChannelCategory): string {
  const entry = CHANNEL_CATEGORIES.find((candidate) => candidate.id === category);
  // Every id in the union has a row above; the fallback only guards a
  // future edit that adds an id and forgets its label.
  return entry?.label ?? category;
}
