/** @author masterzee001 */
/**
 * The catalogue's arithmetic, with no React in it.
 *
 * Everything C7 Streams decides about a channel list -- which chips to
 * offer, which channel is featured, what a bell press must send, how a
 * follow count moves when the viewer is the one who followed -- lives here
 * so it can be tested in node and read in one place.
 *
 * HONEST CATEGORIES. The directory wire carries id, name, live and
 * visibility, nothing else; a channel does not yet say what it is about.
 * So the chips are derived from those four fields and a chip is offered
 * only when at least one listed channel would answer to it. Nothing here
 * invents a topic, a viewer count or a schedule.
 *
 * INTERESTED IS A FOLLOW WITH A REMINDER. The account service's follow
 * route takes `following` and `remind`; the phone's bell always sends both
 * on, so "Interested" means exactly "tell me when it goes live", and the
 * count beside a channel is the number of people who follow it.
 */
import type { ChannelFollow } from '../api/client';
import type { ChannelSummary } from '../api/channelDirectory';

export type Category = 'all' | 'live' | 'off' | 'following' | 'public' | 'link-only';

/** channelId -> the follow, for every channel the viewer follows. */
export type FollowState = Readonly<Record<string, ChannelFollow>>;

/** channelId -> how many people follow it. Absent means not known yet. */
export type InterestCounts = Readonly<Record<string, number>>;

/** Chip order as shown; `all` is always first and always offered. */
const CATEGORY_ORDER: readonly Category[] = ['all', 'live', 'off', 'following', 'public', 'link-only'];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  all: 'All',
  live: 'Live now',
  off: 'Off air',
  following: 'Following',
  public: 'Public',
  'link-only': 'Link-only',
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

export function inCategory(channel: ChannelSummary, category: Category, follows: FollowState): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'live':
      return channel.live;
    case 'off':
      return !channel.live;
    case 'following':
      return isFollowing(follows, channel.channelId);
    case 'public':
      return channel.visibility === 'public';
    case 'link-only':
      return channel.visibility === 'private';
  }
}

/** The chips worth offering: `all`, then every category some listed channel answers to. */
export function deriveCategories(channels: readonly ChannelSummary[], follows: FollowState): readonly Category[] {
  return CATEGORY_ORDER.filter(
    (category) => category === 'all' || channels.some((channel) => inCategory(channel, category, follows)),
  );
}

/** A chosen chip that has since vanished (the last live channel went off) falls back to `all`. */
export function resolveCategory(chosen: Category, available: readonly Category[]): Category {
  return available.includes(chosen) ? chosen : 'all';
}

export function filterChannels(
  channels: readonly ChannelSummary[],
  input: { readonly category: Category; readonly query: string; readonly follows: FollowState },
): readonly ChannelSummary[] {
  const q = input.query.trim().toLowerCase();
  return channels
    .filter((channel) => inCategory(channel, input.category, input.follows))
    .filter((channel) => q.length === 0 || channel.displayName.toLowerCase().includes(q))
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
