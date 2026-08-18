// P6.4-W2 — bind incoming remote tracks to the speakers they carry.
//
// Two facts arrive from two different places and there is NO ordering between
// them:
//
//   1. the browser fires `track` on the receive peer, carrying a transceiver mid
//   2. the gateway sends `call:receive:tracks`, saying which speaker each
//      slot/mid is currently carrying
//
// Either can be first. A design that assumed one would work perfectly on a
// developer's machine and attribute audio to the wrong person on a slow
// connection — the kind of defect that reproduces once a fortnight and is
// blamed on the network.
//
// So this holds both halves and resolves whenever it has enough to. It is a
// transport-binding primitive only: no playback, no volume, no mute. W3 owns
// the audio elements and the controls.

export interface CallReceiveTrackMapping {
  slot: number;
  mid: string | null;
  speakerParticipantId: string | null;
}

export interface CallRemoteTrackLike {
  id?: string;
}

export interface CallRemoteBinding {
  slot: number;
  speakerParticipantId: string;
  track: CallRemoteTrackLike;
}

/** Fires whenever the resolved set of speaker→track bindings changes. */
export type CallRemoteBindingListener = (bindings: readonly CallRemoteBinding[]) => void;

export class CallRemoteSlotBinder {
  /** Tracks by mid, held whether or not a mapping has arrived for them yet. */
  private readonly tracksByMid = new Map<string, CallRemoteTrackLike>();
  /**
   * Tracks that arrived without a mid.
   *
   * Kept for diagnostics ONLY. They are never bound to a speaker, because
   * nothing here can say whose voice they carry.
   */
  private readonly tracksWithoutMid: CallRemoteTrackLike[] = [];
  private mapping: readonly CallReceiveTrackMapping[] = [];
  private listener: CallRemoteBindingListener | null = null;
  private lastSignature = '';

  onChange(listener: CallRemoteBindingListener | null): void {
    this.listener = listener;
  }

  /**
   * A `track` event from the receive peer.
   *
   * Recorded even when no mapping has been seen: case (A), track before
   * mapping. The track waits here until the mapping explains it.
   */
  acceptTrack(mid: string | null, track: CallRemoteTrackLike): void {
    if (mid !== null) this.tracksByMid.set(mid, track);
    else this.tracksWithoutMid.push(track);
    this.publish();
  }

  /**
   * A `call:receive:tracks` payload.
   *
   * Recorded even when no track has arrived: case (B), mapping before track.
   * Replaces the previous mapping wholesale, because the server always sends
   * the complete slot list — a partial merge could leave a stale binding alive
   * for a speaker who has left.
   */
  acceptMapping(tracks: readonly CallReceiveTrackMapping[]): void {
    this.mapping = tracks.map((entry) => ({ ...entry }));
    this.publish();
  }

  /** Everything currently resolvable. Speakers without a track yet are absent. */
  bindings(): readonly CallRemoteBinding[] {
    const resolved: CallRemoteBinding[] = [];
    for (const entry of this.mapping) {
      if (entry.speakerParticipantId === null) continue;
      const track = this.trackFor(entry);
      if (!track) continue;
      resolved.push({
        slot: entry.slot,
        speakerParticipantId: entry.speakerParticipantId,
        track,
      });
    }
    return resolved;
  }

  trackForSpeaker(speakerParticipantId: string): CallRemoteTrackLike | null {
    return (
      this.bindings().find((binding) => binding.speakerParticipantId === speakerParticipantId)
        ?.track ?? null
    );
  }

  /**
   * A rebuilt receive peer invalidates every track AND the mapping that
   * described them. Clearing both is the point: keeping either would leave the
   * client attributing audio through handles that no longer exist.
   */
  reset(): void {
    this.tracksByMid.clear();
    this.tracksWithoutMid.length = 0;
    this.mapping = [];
    this.publish();
  }

  /**
   * What could NOT be resolved, so failing closed is visible rather than silent.
   *
   * A speaker who is mapped but unresolved is somebody the listener cannot
   * hear. That is the correct outcome when identity is unavailable, and it is
   * exactly the sort of correct-but-costly state that must never be invisible.
   */
  diagnostics(): {
    tracksWithoutMid: number;
    unresolvedSpeakers: string[];
    boundSpeakers: string[];
  } {
    const bound = new Set(this.bindings().map((binding) => binding.speakerParticipantId));
    const unresolved = this.mapping
      .filter((entry) => entry.speakerParticipantId !== null)
      .map((entry) => entry.speakerParticipantId as string)
      .filter((speakerId) => !bound.has(speakerId));
    return {
      tracksWithoutMid: this.tracksWithoutMid.length,
      unresolvedSpeakers: unresolved,
      boundSpeakers: [...bound],
    };
  }

  /**
   * The track for a mapping entry, or null. FAILS CLOSED.
   *
   * `mid` is the only identity trusted here. There is deliberately no fallback
   * to track arrival order, transceiver order, slot order or join order: in a
   * multilingual conference, attributing one person's voice to another is far
   * worse than a track that stays briefly silent. Every one of those orderings
   * looks reliable on a fast local connection and misattributes under load,
   * which is the kind of defect that reproduces once a fortnight and gets
   * blamed on the network.
   *
   * A second stable identifier could become a tested fallback later, if one is
   * PROVEN to survive signalling unchanged. Until then, unresolved is correct.
   */
  private trackFor(entry: CallReceiveTrackMapping): CallRemoteTrackLike | null {
    if (entry.mid === null) return null;
    return this.tracksByMid.get(entry.mid) ?? null;
  }

  /** Notify only on a real change, so a repeated mapping cannot churn the UI. */
  private publish(): void {
    const bindings = this.bindings();
    const signature = bindings
      .map((binding) => `${binding.slot}:${binding.speakerParticipantId}`)
      .join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.listener?.(bindings);
  }
}
