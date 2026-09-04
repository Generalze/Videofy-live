/** @author masterzee001 */
/**
 * A channel's persistent identity, and the rules for its @handle.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY: "every
 * entitled operator lands automatically on their own persistent channel";
 * "persistent channel profile {channelId, ownerAccountId, handle, displayName,
 * description, avatar, banner, category, visibility, createdAt, updatedAt}";
 * "unique human-readable @handle"; "public canonical route /streams/<handle>
 * with opaque links still working"; "CHANNEL (persistent identity) vs
 * PROGRAMME (one broadcast) are separate"; "never expose fallback names like
 * 'Channel abc123' when an identity exists".
 *
 * This file is the wire contract every side reads: the account service that
 * stores a profile, the gateway that mirrors visibility onto it, the operator
 * console that edits it, and the C7 Streams discovery surface that shows it.
 * The opaque channelId stays the internal key (see the gateway's
 * channelIdForAccount); the handle is an ALIAS resolving to that id, which is
 * why nothing built on the id has to change when a handle is chosen.
 */
import type { ChannelCategory } from './channel-category.js';
import type { ChannelVisibility } from './socket-events.js';

/**
 * The profile as its owner and the platform's own services see it.
 *
 * `avatarUrl` and `bannerUrl` are the public GET paths on the account service
 * (`/channels/<channelId>/avatar` and `/banner`), relative to that service's
 * origin, or null when no image is set. They carry a `?v=` version so a
 * changed picture is not served stale from a cache. `createdAt`/`updatedAt`
 * are epoch milliseconds.
 */
export interface ChannelProfile {
  readonly channelId: string;
  readonly ownerAccountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ChannelCategory | null;
  readonly visibility: ChannelVisibility;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * What anybody may read about a channel: the identity, never the owner.
 *
 * An account id is an owner id, and a public route that returned it would
 * turn every channel page into a way to enumerate accounts. The public shape
 * is a strict subset of ChannelProfile so a client type-checks against one
 * definition, and the two cannot drift.
 */
export type PublicChannelProfile = Pick<
  ChannelProfile,
  'channelId' | 'handle' | 'displayName' | 'description' | 'category' | 'visibility' | 'avatarUrl' | 'bannerUrl'
>;

/**
 * What the owner sends on PUT /channels/mine. Every field optional; an absent
 * field means "leave it alone". `category: null` clears the category.
 */
export interface ChannelProfileUpdate {
  handle?: string;
  displayName?: string;
  description?: string;
  category?: ChannelCategory | null;
  visibility?: ChannelVisibility;
}

/** The visibility tiers, in the order a picker shows them. See ChannelVisibility. */
export const CHANNEL_VISIBILITIES: readonly ChannelVisibility[] = ['public', 'private', 'locked'];

/** Whether an untrusted value is one of the visibility tiers. */
export function isChannelVisibility(value: unknown): value is ChannelVisibility {
  return typeof value === 'string' && (CHANNEL_VISIBILITIES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ handle */

export const CHANNEL_HANDLE_MIN_LENGTH = 3;
export const CHANNEL_HANDLE_MAX_LENGTH = 24;

/**
 * Lowercase letters, digits and underscores only. Lowercase because a handle
 * differing only in case is the same claim on the same channel, and storing
 * it already folded is simpler than folding at every comparison.
 */
export const CHANNEL_HANDLE_SHAPE = /^[a-z0-9_]{3,24}$/;

/**
 * Handles nobody may hold, because each is either a route segment the
 * platform already uses (/streams, /listen, /api...) or a claim about the
 * platform itself. `main` is the special C7 platform channel by directive.
 */
export const RESERVED_CHANNEL_HANDLES: readonly string[] = [
  'main',
  'c7',
  'admin',
  'videofy',
  'streams',
  'listen',
  'operator',
  'api',
  'auth',
  'media',
  'support',
  'help',
  'about',
];

const RESERVED = new Set<string>(RESERVED_CHANNEL_HANDLES);

export type ChannelHandleRefusal = 'too-short' | 'too-long' | 'bad-shape' | 'reserved';

export type ChannelHandleCheck =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly reason: ChannelHandleRefusal; readonly message: string };

/** What a person is told, in words that say what to do about it. */
export const CHANNEL_HANDLE_REFUSAL_MESSAGES: Record<ChannelHandleRefusal, string> = {
  'too-short': `Handles are at least ${CHANNEL_HANDLE_MIN_LENGTH} characters.`,
  'too-long': `Handles are at most ${CHANNEL_HANDLE_MAX_LENGTH} characters.`,
  'bad-shape': 'Use lowercase letters, numbers and underscores.',
  reserved: 'That handle is reserved.',
};

/**
 * The stored form of a typed handle: trimmed, lowercased, without a leading
 * `@`. Typing `@MyChannel` into a field already showing the `@` must not cost
 * anybody their handle.
 */
export function normaliseChannelHandle(input: string): string {
  const lowered = input.trim().toLowerCase();
  return lowered.startsWith('@') ? lowered.slice(1) : lowered;
}

/**
 * Whether a handle may be claimed, ignoring who already holds one.
 *
 * Shape and reservation only. Availability needs storage and is the account
 * service's question; this is the half every client can answer before a
 * round trip.
 */
export function checkChannelHandle(input: string): ChannelHandleCheck {
  const handle = normaliseChannelHandle(input);
  const refuse = (reason: ChannelHandleRefusal): ChannelHandleCheck => ({
    ok: false,
    reason,
    message: CHANNEL_HANDLE_REFUSAL_MESSAGES[reason],
  });
  // Reserved first: `c7` is shorter than the minimum, and "reserved" is the
  // truer answer than "too short" for a name the platform holds.
  if (RESERVED.has(handle)) return refuse('reserved');
  if (handle.length < CHANNEL_HANDLE_MIN_LENGTH) return refuse('too-short');
  if (handle.length > CHANNEL_HANDLE_MAX_LENGTH) return refuse('too-long');
  if (!CHANNEL_HANDLE_SHAPE.test(handle)) return refuse('bad-shape');
  return { ok: true, handle };
}

/* ------------------------------------------------------------- text limits */

/** Same ceiling the gateway applies to a programme's display name. */
export const CHANNEL_DISPLAY_NAME_MAX_LENGTH = 80;
export const CHANNEL_DESCRIPTION_MAX_LENGTH = 500;

/* ------------------------------------------------------------------ routes */

/** The public canonical page for a channel, by handle. */
export function channelStreamPath(handle: string): string {
  return `/streams/${encodeURIComponent(handle)}`;
}

/** Where the account service serves a channel's avatar bytes. */
export function channelAvatarPath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}/avatar`;
}

/** Where the account service serves a channel's banner bytes. */
export function channelBannerPath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}/banner`;
}
