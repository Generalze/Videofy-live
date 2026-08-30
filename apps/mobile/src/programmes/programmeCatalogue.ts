/** @author masterzee001 */
/**
 * The catalogue's arithmetic, with no React in it.
 *
 * Everything C7 Streams decides about a channel list -- which chips to
 * offer, which channel is featured, what a bell press must send, how a
 * follow count moves when the viewer is the one who followed -- lives here
 * so it can be tested in node and read in one place.
 *
 * FILTERS ARE NOT CATEGORIES (founder ruling 29 Aug 2026, LOCKED):
 * "Categories are an explicit, controlled channel-side field -- one
 * primary category in v1, set by the operator -- never inferred from
 * follows, visibility or live state; Live / Following / Public are filters
 * and are shown as filters." So there are two independent rows. The
 * FILTER row is operational -- All / Live / Following / Public -- derived
 * from what the wire carries, and a filter is offered only when at least
 * one listed channel answers to it. The CATEGORY row is the channel's own
 * `category` field, shown only when at least one listed channel carries
 * one, in the controlled order of CHANNEL_CATEGORIES. Nothing here invents
 * a category, a viewer count or a schedule.
 *
 * INTERESTED IS A FOLLOW WITH A REMINDER. The account service's follow
 * route takes `following` and `remind`; the phone's bell always sends both
 * on, so "Interested" means exactly "tell me when it goes live", and the
 * count beside a channel is the number of people who follow it.
 */
import type { ChannelFollow } from '../api/client';
import { streamsUrlFor, type ChannelSummary } from '../api/channelDirectory';
import { CHANNEL_CATEGORIES, type ChannelCategory, type ChannelCategoryEntry } from './channelCategories';

/** The operational filters. `all` is always first and always offered. */
export type Filter = 'all' | 'live' | 'following' | 'public';

/** channelId -> the follow, for every channel the viewer follows. */
export type FollowState = Readonly<Record<string, ChannelFollow>>;

/** channelId -> how many people follow it. Absent means not known yet. */
export type InterestCounts = Readonly<Record<string, number>>;

const FILTER_ORDER: readonly Filter[] = ['all', 'live', 'following', 'public'];

export const FILTER_LABELS: Readonly<Record<Filter, string>> = {
  all: 'All',
  live: 'Live',
  following: 'Following',
  public: 'Public',
};

/** Up to two initials from a display name, for the art tile. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export function describeVisibility(visibility: ChannelSummary['visibility']): string {
  return visibility === 'public' ? 'Public' : visibility === 'private' ? 'Private · Link-only' : 'Locked';
}

export function isFollowing(follows: FollowState, channelId: string): boolean {
  return follows[channelId] !== undefined;
}

export function inFilter(channel: ChannelSummary, filter: Filter, follows: FollowState): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'live':
      return channel.live;
    case 'following':
      return isFollowing(follows, channel.channelId);
    case 'public':
      return channel.visibility === 'public';
  }
}

/** The filter chips worth offering: `all`, then every filter some listed channel answers to. */
export function deriveFilters(channels: readonly ChannelSummary[], follows: FollowState): readonly Filter[] {
  return FILTER_ORDER.filter((filter) => filter === 'all' || channels.some((channel) => inFilter(channel, filter, follows)));
}

/** A chosen filter that has since vanished (the last live channel went off) falls back to `all`. */
export function resolveFilter(chosen: Filter, available: readonly Filter[]): Filter {
  return available.includes(chosen) ? chosen : 'all';
}

/**
 * The category chips: the controlled list, in its order, reduced to the
 * categories at least one listed channel carries. Empty when no listed
 * channel has one, and the screen then shows no category row at all --
 * a category is read from the channel, never guessed for it.
 */
export function deriveCategoryChips(channels: readonly ChannelSummary[]): readonly ChannelCategoryEntry[] {
  return CHANNEL_CATEGORIES.filter((entry) => channels.some((channel) => channel.category === entry.id));
}

/** A chosen category no listed channel carries any more clears to none. */
export function resolveCategoryChoice(
  chosen: ChannelCategory | null,
  available: readonly ChannelCategoryEntry[],
): ChannelCategory | null {
  return chosen !== null && available.some((entry) => entry.id === chosen) ? chosen : null;
}

/** The label the controlled list gives a category id; null for none. */
export function categoryLabel(category: ChannelCategory | null): string | null {
  if (category === null) return null;
  return CHANNEL_CATEGORIES.find((entry) => entry.id === category)?.label ?? null;
}

export function filterChannels(
  channels: readonly ChannelSummary[],
  input: {
    readonly filter: Filter;
    /** null means every category, and channels with none. */
    readonly category: ChannelCategory | null;
    readonly query: string;
    readonly follows: FollowState;
  },
): readonly ChannelSummary[] {
  // A typed "@name" is a search for the handle; the @ is not part of it.
  const q = input.query.trim().toLowerCase().replace(/^@/, '');
  return channels
    .filter((channel) => inFilter(channel, input.filter, input.follows))
    .filter((channel) => input.category === null || channel.category === input.category)
    .filter(
      (channel) =>
        q.length === 0 ||
        channel.displayName.toLowerCase().includes(q) ||
        (channel.handle !== null && channel.handle.includes(q)),
    )
    .sort((a, b) => Number(b.live) - Number(a.live) || a.displayName.localeCompare(b.displayName));
}

/**
 * The featured channel: live, with the most followers. Unknown counts read
 * as zero; a tie goes to the name that sorts first, so the choice is stable
 * across renders. Nothing is featured when nothing is live.
 */
export function selectFeatured(channels: readonly ChannelSummary[], interest: InterestCounts): ChannelSummary | null {
  let best: ChannelSummary | null = null;
  for (const channel of channels) {
    if (!channel.live) continue;
    if (best === null) {
      best = channel;
      continue;
    }
    const mine = interest[channel.channelId] ?? 0;
    const theirs = interest[best.channelId] ?? 0;
    if (mine > theirs || (mine === theirs && channel.displayName.localeCompare(best.displayName) < 0)) {
      best = channel;
    }
  }
  return best;
}

/** "1.2K interested"; null when the count has not arrived, so nothing is shown rather than a guess. */
export function formatInterest(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count < 0) return null;
  if (count < 1000) return `${Math.floor(count)} interested`;
  const thousands = Math.floor(count / 100) / 10;
  return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}K interested`;
}

export type FollowAction =
  | { readonly kind: 'loaded'; readonly follows: readonly ChannelFollow[] }
  | { readonly kind: 'set'; readonly channelId: string; readonly follow: ChannelFollow | null };

export function followsReducer(state: FollowState, action: FollowAction): FollowState {
  if (action.kind === 'loaded') {
    const next: Record<string, ChannelFollow> = {};
    for (const follow of action.follows) next[follow.channelId] = follow;
    return next;
  }
  if (action.follow === null) {
    if (state[action.channelId] === undefined) return state;
    const { [action.channelId]: _gone, ...rest } = state;
    return rest;
  }
  return { ...state, [action.channelId]: action.follow };
}

/**
 * What one bell press must send. Not following -> follow with the reminder
 * on (that is what "Interested" means). Following -> unfollow; `remind` is
 * left out because the route ignores it on an unfollow.
 */
export function toggleIntent(
  follows: FollowState,
  channelId: string,
): { readonly following: boolean; readonly remind: true | undefined } {
  return isFollowing(follows, channelId) ? { following: false, remind: undefined } : { following: true, remind: true };
}

/** Move a KNOWN count by the viewer's own follow; an unknown count stays unknown, and none goes below zero. */
export function adjustInterest(interest: InterestCounts, channelId: string, delta: number): InterestCounts {
  const current = interest[channelId];
  if (current === undefined) return interest;
  return { ...interest, [channelId]: Math.max(0, current + delta) };
}

export function findChannel(channels: readonly ChannelSummary[], channelId: string): ChannelSummary | null {
  return channels.find((channel) => channel.channelId === channelId) ?? null;
}

/* ------------------------------------------------ identity (directive A, 30 Aug 2026) */

/** "@handle", ready to print; null when the channel has no handle yet, so nothing is shown. */
export function handleLabel(handle: string | null): string | null {
  return handle !== null && handle.length > 0 ? `@${handle}` : null;
}

/**
 * The programme on air, or null. CHANNEL and PROGRAMME are separate
 * (directive A): a title is only shown while the channel is live, and an
 * off-air channel shows none rather than the last one it had.
 */
export function nowPlaying(channel: Pick<ChannelSummary, 'live' | 'currentProgramme'>): string | null {
  if (!channel.live || channel.currentProgramme === null) return null;
  const title = channel.currentProgramme.trim();
  return title.length > 0 ? title : null;
}

/**
 * The link a person shares from the viewer: the public canonical
 * /streams/<handle> page. Null when the channel has no handle -- there is
 * nothing canonical to share, and the share action is not offered rather
 * than offered dead.
 */
export function channelShareUrl(webUrl: string, channel: Pick<ChannelSummary, 'handle'>): string | null {
  return channel.handle === null ? null : streamsUrlFor(webUrl, channel.handle);
}
