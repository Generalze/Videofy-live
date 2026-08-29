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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_CHANNEL_ID,
  type ChannelSummary,
  type AudioMixPreferences,
  type ChannelCategory,
  type ChannelVisibility,
  type MediaStateEvent,
} from '@videofy-live/shared-types';

export { DEFAULT_CHANNEL_ID };
export type { AudioMixPreferences, ChannelCategory, ChannelSummary, ChannelVisibility };

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
  /**
   * The operator's declared category; null until they choose one. Founder
   * ruling (29 Aug 2026): an explicit server field, never inferred from
   * follows, visibility or live status.
   */
  category: ChannelCategory | null;
  mediaState: MediaStateEvent | null;
  audio: AudioMixPreferences;
  /**
   * The join code, as a digest.
   *
   * Held hashed rather than plain so that a heap dump, a crash report or an
   * accidental log of channel state cannot hand somebody entry to a private
   * programme. Null means no code has been set, which for a private channel
   * means nobody can join -- see mayJoin.
   */
  accessCodeHash: string | null;
  accessCodeSalt: string | null;
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
      category: null,
      mediaState: null,
      audio: { ...this.defaultAudio },
      accessCodeHash: null,
      accessCodeSalt: null,
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

  /**
   * The channel's declared category.
   *
   * Founder ruling (29 Aug 2026): "Channel categories: explicit server field.
   * Do not infer semantic categories from follows, visibility or live status.
   * Add a controlled channel-side category field, one primary category in
   * v1." This is that field: chosen by the operator, checked against the
   * controlled list before it reaches here, null until they choose.
   */
  setCategory(channelId: string, category: ChannelCategory | null): void {
    this.ensure(channelId).category = category;
  }

  category(channelId: string): ChannelCategory | null {
    return this.channels.get(channelId)?.category ?? null;
  }

  /** Set or clear the join code for a locked channel. */
  setAccessCode(channelId: string, code: string | null): void {
    const channel = this.ensure(channelId);
    if (code === null || code.length === 0) {
      channel.accessCodeHash = null;
      channel.accessCodeSalt = null;
      return;
    }
    // A fresh salt per set: rotating the code rotates everything.
    channel.accessCodeSalt = randomBytes(16).toString('hex');
    channel.accessCodeHash = this.hashCode(code, channel.accessCodeSalt);
  }

  /** Whether a channel has a code set, without revealing anything about it. */
  hasAccessCode(channelId: string): boolean {
    return this.channels.get(channelId)?.accessCodeHash !== null;
  }

  /**
   * Whether a listener holding this code may join.
   *
   * PUBLIC AND UNLISTED ARE OPEN. The difference between them is discovery, not
   * access: a private channel is missing from the directory, and that is all.
   *
   * PRIVATE WITH NO CODE SET REFUSES EVERYBODY. The alternative -- treating a
   * missing code as "no code required" -- means an operator who selects private
   * and has not yet set a code is broadcasting openly while their screen says
   * private. A channel that refuses its own owner is a visible, fixable
   * problem; one that silently admits the public is not.
   */
  mayJoin(channelId: string, code?: string | undefined, clientKey?: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || channel.visibility !== 'locked') return true;
    if (channel.accessCodeHash === null || channel.accessCodeSalt === null) return false;
    if (typeof code !== 'string' || code.length === 0) return false;
    /*
     * GUESSING IS RATE-LIMITED (external review, adopted 2026-08-28).
     * Constant-time comparison stops timing leakage; it does nothing against
     * somebody simply trying 000000..999999. Five wrong answers from one
     * client against one channel buys a one-minute lockout; a correct answer
     * clears the slate. Keyed per client so one guesser cannot lock a
     * channel's real audience out.
     */
    const attemptKey = `${channelId}\u0000${clientKey ?? 'anonymous'}`;
    const now = Date.now();
    const attempt = this.codeAttempts.get(attemptKey);
    if (attempt !== undefined && attempt.lockedUntilMs > now) return false;

    const admitted = this.codesMatch(
      channel.accessCodeHash,
      this.hashCode(code, channel.accessCodeSalt),
    );
    if (admitted) {
      this.codeAttempts.delete(attemptKey);
      return true;
    }
    const failures = (attempt?.failures ?? 0) + 1;
    this.codeAttempts.set(attemptKey, {
      failures,
      lockedUntilMs: failures >= 5 ? now + 60_000 : 0,
    });
    if (this.codeAttempts.size > 10_000) this.codeAttempts.clear();
    return false;
  }

  /** Guess-cost accounting for locked channels; see mayJoin. */
  private readonly codeAttempts = new Map<string, { failures: number; lockedUntilMs: number }>();

  private hashCode(code: string, salt: string): string {
    /*
     * scrypt with a per-channel salt (external review, adopted 2026-08-28).
     * Join codes are short, human-typable secrets: a fast digest of a
     * six-digit code is enumerable offline in milliseconds if it ever leaks,
     * so the hash must be slow by construction. N=16384 keeps a legitimate
     * check under ~50ms while pricing a million guesses out of casual reach
     * -- and the rate limiter in mayJoin prices ONLINE guessing separately.
     */
    return scryptSync(code, `videofy channel code\u0000${salt}`, 32, { N: 16384 }).toString('hex');
  }

  /**
   * Compare two digests without leaking where they differ.
   *
   * Both sides are fixed-length hex of the same digest, so the lengths always
   * match and timingSafeEqual cannot throw. A plain === would return early on
   * the first differing character and let somebody recover a code one
   * character at a time.
   */
  private codesMatch(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
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
      // Only public. Unlisted and private are both absent from discovery; they
      // differ in whether the link alone is enough to get in.
      .filter((channel) => channel.visibility === 'public')
      .map((channel) => ({
        channelId: channel.channelId,
        displayName: channel.displayName,
        live: channel.mediaState !== null,
        visibility: channel.visibility,
        category: channel.category,
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
