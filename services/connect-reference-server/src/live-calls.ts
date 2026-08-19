/** @author masterzee001 */
/**
 * The room -> Connect-call directory, home of ENSURE-LIVE-CALL.
 *
 * The in-memory mapping dies with this process; an optional persistence hook
 * remembers the call id on the ROOM record, so a Connect Reference restart
 * re-adopts the live call the members are still in instead of splitting the
 * room into a second call. Adoption always re-verifies liveness first —
 * whenever a mapping is missing or the call answers CALL_NOT_FOUND /
 * CALL_ENDED, a fresh conference call is created in the room's CURRENT mode
 * and the mapping replaced. A gateway restart costs one extra create.
 *
 * Concurrency: establishment is single-flight per room (an in-process
 * promise map), so two simultaneous joiners share one create and can never
 * mint two calls for the same room.
 */
import { VideofyApiError, type CallState, type VideofyConnectClient } from '@videofy/server-sdk';
import type { RoomRecord } from './room-store.js';

export interface LiveCall {
  /** The Connect "vc_..." id — server-side knowledge only, never sent out. */
  publicCallId: string;
  createdAt: string;
}

/**
 * Durable memory for the mapping (the room registry, in practice). Writes
 * are best-effort: a stale or lost id is healed by the liveness check that
 * guards every adoption.
 */
export interface LiveCallPersistence {
  recall(roomId: string): string | undefined;
  remember(roomId: string, publicCallId: string): Promise<void>;
  forget(roomId: string): Promise<void>;
}

const CALL_GONE_CODES: ReadonlySet<string> = new Set(['CALL_NOT_FOUND', 'CALL_ENDED']);

/** True when upstream said the call no longer exists — the recreate signal. */
export function isCallGoneError(error: unknown): boolean {
  return error instanceof VideofyApiError && CALL_GONE_CODES.has(error.code);
}

export class LiveCallDirectory {
  private readonly mappings = new Map<string, LiveCall>();
  private readonly establishing = new Map<string, Promise<LiveCall>>();
  /** roomId -> subject -> stable member index (first-seen order per room). */
  private readonly memberIndexes = new Map<string, Map<string, number>>();

  constructor(
    private readonly connect: VideofyConnectClient,
    private readonly persistence?: LiveCallPersistence,
  ) {}

  peek(roomId: string): LiveCall | undefined {
    return this.mappings.get(roomId);
  }

  /**
   * Forget a mapping — but only the exact mapping the caller saw, so a stale
   * failure can never clobber a fresh call another request just established.
   */
  invalidate(roomId: string, publicCallId: string): void {
    const current = this.mappings.get(roomId);
    if (current !== undefined && current.publicCallId === publicCallId) {
      this.mappings.delete(roomId);
      void this.persistence?.forget(roomId).catch(() => {});
    }
  }

  /**
   * Unconditional forget — used when the room itself ends. The member-index
   * map goes with it: an ended room can never seat anyone again, and keeping
   * its indexes would grow this process without bound.
   */
  clear(roomId: string): void {
    this.mappings.delete(roomId);
    this.memberIndexes.delete(roomId);
    void this.persistence?.forget(roomId).catch(() => {});
  }

  /**
   * The establishment currently in flight for this room, if any. A mode
   * change must WAIT for it: a switch landing while the first join's create
   * is parked would otherwise never reach the call being created.
   */
  settled(roomId: string): Promise<LiveCall> | undefined {
    return this.establishing.get(roomId);
  }

  /**
   * ENSURE-LIVE-CALL. Returns a mapping whose call answered a liveness check
   * a moment ago (or was just created). Single-flight per room.
   */
  async ensure(room: RoomRecord): Promise<LiveCall> {
    const inFlight = this.establishing.get(room.roomId);
    if (inFlight !== undefined) return inFlight;
    const flight = this.establish(room);
    this.establishing.set(room.roomId, flight);
    try {
      return await flight;
    } finally {
      this.establishing.delete(room.roomId);
    }
  }

  /**
   * Live state for list/detail views. Degrades to null instead of throwing:
   * a room list must render even when Connect is down. A gone-call answer
   * clears the mapping (the next join recreates); a transient failure leaves
   * the mapping alone.
   */
  async stateIfLive(roomId: string): Promise<CallState | null> {
    const mapping = this.mappings.get(roomId);
    if (mapping === undefined) return null;
    try {
      return await this.connect.calls.state(mapping.publicCallId);
    } catch (error) {
      if (isCallGoneError(error)) this.invalidate(roomId, mapping.publicCallId);
      return null;
    }
  }

  /**
   * KC-side stable index for a member, assigned in first-seen order per
   * room. The product surfaces this index plus displayName instead of any
   * Videofy participant identifier. Indexes survive call re-creation (they
   * live with the room, not the call) though not a restart of this process.
   */
  memberIndex(roomId: string, subject: string): number {
    let forRoom = this.memberIndexes.get(roomId);
    if (forRoom === undefined) {
      forRoom = new Map();
      this.memberIndexes.set(roomId, forRoom);
    }
    let index = forRoom.get(subject);
    if (index === undefined) {
      index = forRoom.size;
      forRoom.set(subject, index);
    }
    return index;
  }

  private async establish(room: RoomRecord): Promise<LiveCall> {
    const existing = this.mappings.get(room.roomId);
    if (existing !== undefined) {
      const verified = await this.verify(room, existing);
      if (verified !== null) return verified;
    } else {
      // A restart wiped the memory; the room record may still name the call
      // the members are in. Adopt it only after it answers a liveness check.
      const recalled = this.persistence?.recall(room.roomId);
      if (recalled !== undefined) {
        const candidate: LiveCall = { publicCallId: recalled, createdAt: '' };
        const verified = await this.verify(room, candidate);
        if (verified !== null) {
          this.mappings.set(room.roomId, verified);
          return verified;
        }
        await this.persistence?.forget(room.roomId).catch(() => {});
      }
    }
    const created = await this.connect.calls.create({ type: 'conference', mode: room.mode });
    const mapping: LiveCall = { publicCallId: created.callId, createdAt: created.createdAt };
    this.mappings.set(room.roomId, mapping);
    await this.persistence?.remember(room.roomId, mapping.publicCallId).catch(() => {});
    return mapping;
  }

  /**
   * Liveness check plus MODE RECONCILIATION: a healthy call whose mode has
   * drifted from the room record (a host switch that raced establishment) is
   * patched back before anyone joins it. Null means the call is gone and the
   * caller should create a fresh one; transient failures still throw so a
   * possibly-fine call is never recreated over.
   */
  private async verify(room: RoomRecord, candidate: LiveCall): Promise<LiveCall | null> {
    try {
      const state = await this.connect.calls.state(candidate.publicCallId);
      if (state.mode !== room.mode) {
        try {
          await this.connect.calls.setMode(candidate.publicCallId, room.mode);
        } catch (error) {
          if (isCallGoneError(error)) throw error;
          // A transient PATCH failure must not block a join over a cosmetic
          // drift; the next establishment retries the reconciliation.
        }
      }
      return candidate;
    } catch (error) {
      if (!isCallGoneError(error)) throw error;
      this.invalidate(room.roomId, candidate.publicCallId);
      return null;
    }
  }
}
