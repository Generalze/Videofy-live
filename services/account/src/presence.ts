/** @author masterzee001 */
/**
 * Who is around right now.
 *
 * EPHEMERAL ON PURPOSE. Presence is a claim about the last two minutes, and
 * a process that just restarted has no honest basis for it -- so it forgets
 * everyone and lets the next heartbeat speak. Persisting it would mean a
 * deploy showing everybody as active at the moment they were, in fact, not.
 *
 * TWO INPUTS, ONE ANSWER. The heartbeat says what the app is doing (idle or
 * in a call); the account's standing `availability` says what the person
 * wants shown regardless. The override wins, always: somebody who set
 * themselves away is away while their phone is still pinging. Resolution
 * lives here so the three routes that show presence cannot disagree.
 *
 * VISIBLE TO CONTACTS ONLY, but that is decided by the routes, which hold
 * the graph. This class knows nothing about who may ask.
 */
import type { AccountAvailability } from './account-store.js';

export type HeartbeatState = 'active' | 'busy';
export type PresenceState = HeartbeatState | 'away';

/** A heartbeat older than this is silence. */
export const PRESENCE_TTL_MS = 120_000;

interface Heartbeat {
  readonly state: HeartbeatState;
  readonly lastSeenAtMs: number;
}

export class PresenceRegistry {
  private readonly beats = new Map<string, Heartbeat>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = PRESENCE_TTL_MS,
  ) {}

  heartbeat(accountId: string, state: HeartbeatState): void {
    this.beats.set(accountId, { state, lastSeenAtMs: this.now() });
  }

  /** What the heartbeat alone says, before any override. */
  rawStateOf(accountId: string): PresenceState {
    const beat = this.beats.get(accountId);
    if (beat === undefined || this.now() - beat.lastSeenAtMs >= this.ttlMs) return 'away';
    return beat.state;
  }

  /** The heartbeat under the person's standing override. */
  stateOf(accountId: string, availability: AccountAvailability | undefined): PresenceState {
    return resolvePresence(this.rawStateOf(accountId), availability);
  }

  /**
   * Forget stale heartbeats. Called opportunistically so the map is bounded
   * by the active population rather than by everyone who ever signed in.
   */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [accountId, beat] of this.beats) {
      if (beat.lastSeenAtMs < cutoff) this.beats.delete(accountId);
    }
  }
}

/** The override wins; 'auto' (or unset) defers to the heartbeat. */
export function resolvePresence(
  raw: PresenceState,
  availability: AccountAvailability | undefined,
): PresenceState {
  if (availability === 'away') return 'away';
  if (availability === 'busy') return 'busy';
  return raw;
}
