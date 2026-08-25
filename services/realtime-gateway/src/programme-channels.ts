/**
 * One programme per channel, instead of one programme.
 *
 * WHAT THIS REPLACES. The gateway held a single `latestProgrammeMediaState` and
 * a single set of audio preferences. A second operator connecting did not get a
 * second programme — they overwrote the first, mid-broadcast, and nothing
 * anywhere reported it. Every listener sat on `lang:<language>`, so there was
 * exactly one thing in the world to listen to.
 *
 * A channel is the unit an operator owns and a listener chooses. This module
 * holds the per-channel state and nothing else: no sockets, no rooms, no
 * broadcasting. That keeps the state transitions testable without a server, and
 * it is why the gateway can adopt it a call site at a time.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_CHANNEL_ID,
  type ChannelSummary,
  type AudioMixPreferences,
  type ChannelVisibility,
  type MediaStateEvent,
} from '@videofy-live/shared-types';

export { DEFAULT_CHANNEL_ID };
export type { AudioMixPreferences, ChannelSummary, ChannelVisibility };

/** The room carrying a channel's programme to its listeners. */
export function channelRoom(channelId: string, language: string): string {
  return `ch:${channelId}:lang:${language}`;
}

/**
 * Everyone listening to a channel, whatever language they chose.
 *
 * Programme-level traffic -- media state, audio preferences -- belongs here
 * rather than in a language room, because it is true of the channel and not of
 * a translation. Before channels this was a global broadcast, which with two
 * programmes running would show every listener the wrong one.
 */
export function channelListenerRoom(channelId: string): string {
  return `ch:${channelId}:listeners`;
}

/** The room carrying a channel's control traffic to its operators. */
export function channelOperatorRoom(channelId: string): string {
  return `ch:${channelId}:operators`;
}



interface ChannelState {
  readonly channelId: string;
  ownerAccountId: string | null;
  displayName: string;
  visibility: ChannelVisibility;
  mediaState: MediaStateEvent | null;
  audio: AudioMixPreferences;
  /** Sessions currently feeding this channel. */
  readonly sessionIds: Set<string>;
}

/**
 * The channel an account owns.
 *
 * DERIVED, NOT STORED, and deliberately opaque. Using the accountId directly
 * would put it in listener-facing URLs and room names, and an account id is an
 * owner id — DP-171 asks for opaque identifiers in anything operational for
 * exactly this reason. A short digest under a per-deployment salt is stable for
 * the same account, reveals nothing, and needs no table.
 *
 * When operators can choose a handle, that handle becomes an ALIAS resolving to
 * this same id. Nothing built on top of it has to change.
 */
export function channelIdForAccount(accountId: string, salt: string): string {
  return createHash('sha256')
    // NUL as the domain separator, written as an escape: a raw control
    // character in source fails the hygiene gate, and neither a salt nor an
    // account id can contain one, so the two fields cannot be confused.
    .update(`${salt}\u0000channel\u0000${accountId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

const DEFAULT_AUDIO: AudioMixPreferences = {
  mode: 'interpretation',
  originalVolume: 0.2,
  translatedVolume: 1,
  subtitlesEnabled: true,
};

export class ProgrammeChannels {
  private readonly channels = new Map<string, ChannelState>();
  /** Which channel a session is feeding, so a teardown finds it without a scan. */
  private readonly channelBySession = new Map<string, string>();

  constructor(private readonly defaultAudio: AudioMixPreferences = DEFAULT_AUDIO) {}

  /**
   * Get or create a channel.
   *
   * Created lazily on first use rather than provisioned: a channel with no
   * programme and no listeners is indistinguishable from one that does not
   * exist, so there is nothing to be gained by writing it down early.
   */
  private ensure(channelId: string): ChannelState {
    const existing = this.channels.get(channelId);
    if (existing) return existing;
    const created: ChannelState = {
      channelId,
      ownerAccountId: null,
      displayName: channelId === DEFAULT_CHANNEL_ID ? 'Main' : `Channel ${channelId.slice(0, 6)}`,
      visibility: 'public',
      mediaState: null,
      audio: { ...this.defaultAudio },
      sessionIds: new Set(),
    };
    this.channels.set(channelId, created);
    return created;
  }

  /** Claim a channel for an operator account. Idempotent. */
  claim(channelId: string, accountId: string, displayName?: string): void {
    const channel = this.ensure(channelId);
    channel.ownerAccountId = accountId;
    if (displayName && displayName.trim().length > 0) {
      channel.displayName = displayName.trim().slice(0, 80);
    }
  }

  /**
   * Whether this account may operate this channel.
   *
   * An UNCLAIMED channel is operable by anybody authenticated, which is what
   * makes the default channel keep working for existing clients. A CLAIMED one
   * belongs to its owner — and that is the whole point, because before this
   * existed any operator could take over any programme.
   */
  mayOperate(channelId: string, accountId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || channel.ownerAccountId === null) return true;
    return channel.ownerAccountId === accountId;
  }

  setVisibility(channelId: string, visibility: ChannelVisibility): void {
    this.ensure(channelId).visibility = visibility;
  }

  bindSession(sessionId: string, channelId: string): void {
    this.ensure(channelId).sessionIds.add(sessionId);
    this.channelBySession.set(sessionId, channelId);
  }

  releaseSession(sessionId: string): void {
    const channelId = this.channelBySession.get(sessionId);
    if (channelId === undefined) return;
    this.channels.get(channelId)?.sessionIds.delete(sessionId);
    this.channelBySession.delete(sessionId);
  }

  /** Which channel a session feeds, or the default if it was never bound. */
  channelForSession(sessionId: string): string {
    return this.channelBySession.get(sessionId) ?? DEFAULT_CHANNEL_ID;
  }

  mediaState(channelId: string): MediaStateEvent | null {
    return this.channels.get(channelId)?.mediaState ?? null;
  }

  setMediaState(channelId: string, state: MediaStateEvent | null): void {
    this.ensure(channelId).mediaState = state;
  }

  audio(channelId: string): AudioMixPreferences {
    return this.channels.get(channelId)?.audio ?? { ...this.defaultAudio };
  }

  setAudio(channelId: string, audio: AudioMixPreferences): void {
    this.ensure(channelId).audio = audio;
  }

  /**
   * The channels a listener may choose from.
   *
   * Unlisted channels are omitted. They remain joinable by id — see the note on
   * ChannelVisibility about why this is not called "private".
   */
  directory(): readonly ChannelSummary[] {
    return [...this.channels.values()]
      .filter((channel) => channel.visibility === 'public')
      .map((channel) => ({
        channelId: channel.channelId,
        displayName: channel.displayName,
        live: channel.mediaState !== null,
        visibility: channel.visibility,
      }))
      // Live channels first, then by name, so the list is useful rather than
      // whatever order a Map happened to produce.
      .sort((left, right) =>
        left.live === right.live
          ? left.displayName.localeCompare(right.displayName)
          : Number(right.live) - Number(left.live),
      );
  }

  /** Every known channel id, live or not. For teardown and diagnostics. */
  knownChannelIds(): readonly string[] {
    return [...this.channels.keys()];
  }
}
