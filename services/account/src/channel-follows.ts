/** @author masterzee001 */
/**
 * Following a channel, and wanting to be told when it goes live.
 *
 * WHY THIS LIVES IN THE ACCOUNT SERVICE. A follow is a fact about a PERSON
 * -- what they are interested in -- and the live push it triggers needs the
 * person's devices and their notification switch, both of which live here.
 * The programme service owns the channel and only ever tells this service
 * "channel X just went live"; it never learns who follows it.
 *
 * `remind` IS SEPARATE FROM FOLLOWING. Following is interest; a reminder is
 * permission to interrupt. A follow that implied a push would make the
 * follow button a notification switch, and people would stop pressing it.
 */

export interface ChannelFollow {
  readonly accountId: string;
  readonly channelId: string;
  readonly followedAtMs: number;
  readonly remind: boolean;
}

export interface ChannelFollowPort {
  /** Insert or replace; a second follow of the same channel updates `remind`. */
  upsert(follow: ChannelFollow): Promise<void>;
  remove(accountId: string, channelId: string): Promise<void>;
  /** Everything one account follows, newest follow first. */
  followsOf(accountId: string): Promise<readonly ChannelFollow[]>;
  /** Everyone following one channel. The live-push fan-out. */
  followersOf(channelId: string): Promise<readonly ChannelFollow[]>;
  /** Public interest counts for each of `channelIds`; absent means zero. */
  countFor(channelIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** How many channels one account follows. For /me/counts. */
  countOf(accountId: string): Promise<number>;
}

export function createInMemoryChannelFollowPort(): ChannelFollowPort {
  const key = (accountId: string, channelId: string): string => `${accountId} ${channelId}`;
  const rows = new Map<string, ChannelFollow>();
  return {
    async upsert(follow) {
      rows.set(key(follow.accountId, follow.channelId), follow);
    },
    async remove(accountId, channelId) {
      rows.delete(key(accountId, channelId));
    },
    async followsOf(accountId) {
      return [...rows.values()]
        .filter((row) => row.accountId === accountId)
        .sort((a, b) => b.followedAtMs - a.followedAtMs);
    },
    async followersOf(channelId) {
      return [...rows.values()].filter((row) => row.channelId === channelId);
    },
    async countFor(channelIds) {
      const wanted = new Set(channelIds);
      const counts = new Map<string, number>();
      for (const row of rows.values()) {
        if (!wanted.has(row.channelId)) continue;
        counts.set(row.channelId, (counts.get(row.channelId) ?? 0) + 1);
      }
      return counts;
    },
    async countOf(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId).length;
    },
  };
}

/** A channel id as the programme service mints them; anything else is refused. */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
