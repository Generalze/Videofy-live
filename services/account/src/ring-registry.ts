/** @author masterzee001 */
/**
 * Pending rings, so a browser can be rung.
 *
 * A ring reaches phones by push, but the web dashboard has no push channel --
 * it polls. This registry is the poll's source: the ring route notes the ring
 * here, GET /rings answers "who is calling you right now", and the dashboard
 * shows a banner. Without this, calling a contact only ever rings their phone
 * and a person sitting at their laptop watches nothing happen.
 *
 * DELIBERATELY IN-MEMORY. A ring is meaningful for under a minute; persisting
 * one would mean a phone that reconnects tomorrow shows yesterday's call. The
 * cost is honest: rings do not survive a service restart, and a second service
 * instance would not see rings noted on the first. Both are acceptable for a
 * signal whose entire lifetime is the caller sitting in an empty call waiting
 * -- and the phone push path is unaffected either way.
 */

export interface PendingRing {
  readonly callId: string;
  readonly fromAccountId: string;
  readonly fromName: string;
  readonly atMs: number;
}

/** How long a ring stays answerable. Nobody joins a 46-second-old ring. */
const RING_TTL_MS = 45_000;

/** More simultaneous callers than this is not a state worth representing. */
const MAX_PENDING_PER_TARGET = 5;

export class RingRegistry {
  private readonly pending = new Map<string, PendingRing[]>();

  constructor(private readonly ttlMs: number = RING_TTL_MS) {}

  note(targetAccountId: string, ring: PendingRing): void {
    const rings = (this.pending.get(targetAccountId) ?? []).filter(
      (entry) => entry.callId !== ring.callId,
    );
    rings.unshift(ring);
    this.pending.set(targetAccountId, rings.slice(0, MAX_PENDING_PER_TARGET));
  }

  /** Unexpired rings, newest first. Reading is what expires the stale ones. */
  pendingFor(targetAccountId: string, nowMs: number): readonly PendingRing[] {
    const rings = (this.pending.get(targetAccountId) ?? []).filter(
      (entry) => nowMs - entry.atMs < this.ttlMs,
    );
    if (rings.length === 0) this.pending.delete(targetAccountId);
    else this.pending.set(targetAccountId, rings);
    return rings;
  }

  /** Answering and declining both land here; either way the banner goes. */
  dismiss(targetAccountId: string, callId: string): void {
    const rings = (this.pending.get(targetAccountId) ?? []).filter(
      (entry) => entry.callId !== callId,
    );
    if (rings.length === 0) this.pending.delete(targetAccountId);
    else this.pending.set(targetAccountId, rings);
  }
}
