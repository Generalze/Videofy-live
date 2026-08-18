/** @owner masterzee001 */
/**
 * P6.4-W2 — one slot per remote speaker.
 *
 * The defect this removes: every remote speaker's PCM used to be pushed into a
 * SINGLE RTCAudioSource per listener. With two participants exactly one speaker
 * ever fed it, so it worked and every test passed. With three or more, two
 * people talking at once interleave 10 ms frames into one source — not a mix, a
 * corruption, and it degrades to unintelligible audio rather than failing.
 *
 * The first test below is the one that could not previously be written.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CallReceivePeerManager,
  DEFAULT_REMOTE_SLOT_COUNT,
  type CallReceiveTrackMapping,
} from '../call-receive-peers.js';
import type { WebRtcAudioDataLike } from '../webrtc-audio-ingest-bridge.js';

/** One source per slot, recording exactly which frames it was handed. */
class FakeSource {
  readonly received: WebRtcAudioDataLike[] = [];
  readonly track = { stop: vi.fn() };
  createTrack() {
    return this.track;
  }
  onData(data: WebRtcAudioDataLike) {
    this.received.push(data);
  }
  /** The speaker signature of every frame this source got, in order. */
  signatures(): number[] {
    return this.received.map((frame) => frame.samples?.[0] ?? -1);
  }
}

class FakePeer {
  connectionState = 'connected';
  localDescription: { sdp?: string | null } | null = { sdp: 'answer-sdp' };
  remoteDescription: { sdp?: string | null } | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly tracks: { stop?: () => void }[] = [];
  closed = false;

  addTrack(track: { stop?: () => void }) {
    this.tracks.push(track);
    return {};
  }
  getTransceivers() {
    return this.tracks.map((track, index) => ({ mid: `m${index}`, sender: { track } }));
  }
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'answer-sdp' };
  }
  async setLocalDescription() {}
  async addIceCandidate() {}
  close() {
    this.closed = true;
  }
}

interface Harness {
  manager: CallReceivePeerManager;
  sources: FakeSource[];
  peers: FakePeer[];
  mappings: { participantId: string; tracks: readonly CallReceiveTrackMapping[] }[];
  /** Sources belonging to one listener, in slot order. */
  slotsOf(index: number): FakeSource[];
}

function harness(remoteSlotCount = DEFAULT_REMOTE_SLOT_COUNT): Harness {
  const sources: FakeSource[] = [];
  const peers: FakePeer[] = [];
  const mappings: { participantId: string; tracks: readonly CallReceiveTrackMapping[] }[] = [];
  const manager = new CallReceivePeerManager(
    {
      onLocalIceCandidate: () => {},
      onTrackMapping: (_callId, participantId, tracks) =>
        mappings.push({ participantId, tracks: tracks.map((entry) => ({ ...entry })) }),
    },
    {
      remoteSlotCount,
      createPeerConnection: () => {
        const peer = new FakePeer();
        peers.push(peer);
        return peer as never;
      },
      createAudioSource: () => {
        const source = new FakeSource();
        sources.push(source);
        return source as never;
      },
    },
  );
  return {
    manager,
    sources,
    peers,
    mappings,
    slotsOf: (index) => sources.slice(index * remoteSlotCount, (index + 1) * remoteSlotCount),
  };
}

/** A frame whose first sample identifies the speaker unmistakably. */
function frame(signature: number): WebRtcAudioDataLike {
  const samples = new Int16Array(160);
  samples.fill(signature);
  return { samples, sampleRate: 16000, channelCount: 1, bitsPerSample: 16 };
}

const CALL = 'conf';

async function seat(h: Harness, participantIds: string[]): Promise<void> {
  for (const id of participantIds) await h.manager.acceptOffer(CALL, id, 'offer');
  h.manager.syncSpeakers(CALL, participantIds);
}

function boundSlot(h: Harness, listenerIndex: number, speakerId: string): FakeSource {
  const mapping = h.manager.trackMapping(CALL, `p${listenerIndex + 1}`);
  const entry = mapping.find((slot) => slot.speakerParticipantId === speakerId);
  if (!entry) throw new Error(`no slot bound to ${speakerId}`);
  return h.slotsOf(listenerIndex)[entry.slot]!;
}

describe('simultaneous speakers stay separated', () => {
  it('never interleaves two speakers into one source — THE regression', async () => {
    // Under the previous architecture both A and B fed listener C's single
    // source and this assertion was impossible to express, let alone pass.
    const h = harness();
    await seat(h, ['p1', 'p2', 'p3']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);

    // A and B talk at the same time, frames arriving interleaved.
    for (let index = 0; index < 5; index += 1) {
      h.manager.fanOut(CALL, 'p1', frame(111));
      h.manager.fanOut(CALL, 'p2', frame(222));
    }

    const fromP1 = boundSlot(h, 2, 'p1');
    const fromP2 = boundSlot(h, 2, 'p2');

    expect(fromP1.signatures()).toEqual([111, 111, 111, 111, 111]);
    expect(fromP2.signatures()).toEqual([222, 222, 222, 222, 222]);
    // Neither source saw a single frame of the other speaker.
    expect(fromP1.signatures()).not.toContain(222);
    expect(fromP2.signatures()).not.toContain(111);
    expect(fromP1).not.toBe(fromP2);
  });

  it('keeps four participants separated in both directions', async () => {
    const h = harness();
    await seat(h, ['p1', 'p2', 'p3', 'p4']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3', 'p4']);

    h.manager.fanOut(CALL, 'p1', frame(111));
    h.manager.fanOut(CALL, 'p2', frame(222));

    // Every listener received A and B through DIFFERENT sources.
    for (const listener of [2, 3]) {
      expect(boundSlot(h, listener, 'p1').signatures()).toEqual([111]);
      expect(boundSlot(h, listener, 'p2').signatures()).toEqual([222]);
    }
    // p1 heard p2 but not themselves; p2 heard p1 but not themselves.
    expect(boundSlot(h, 0, 'p2').signatures()).toEqual([222]);
    expect(h.manager.trackMapping(CALL, 'p1').some((s) => s.speakerParticipantId === 'p1')).toBe(false);
    expect(boundSlot(h, 1, 'p1').signatures()).toEqual([111]);
  });

  it('never sends a speaker their own audio', async () => {
    const h = harness();
    await seat(h, ['p1', 'p2', 'p3']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);

    h.manager.fanOut(CALL, 'p1', frame(111));

    for (const source of h.slotsOf(0)) expect(source.received).toHaveLength(0);
  });

  it('does not route across calls', async () => {
    const h = harness();
    await seat(h, ['p1', 'p2']);
    await h.manager.acceptOffer('other-call', 'x1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    h.manager.syncSpeakers('other-call', ['x1', 'x2']);

    h.manager.fanOut(CALL, 'p1', frame(111));

    for (const source of h.slotsOf(2)) expect(source.received).toHaveLength(0);
  });

  it('drops a frame for an unbound speaker rather than guessing a slot', async () => {
    // Writing into an arbitrary free slot would reintroduce nondeterministic
    // attribution, which is the defect being removed. Counted, not silent.
    const h = harness();
    await seat(h, ['p1', 'p2']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    h.manager.fanOut(CALL, 'ghost', frame(999));

    expect(h.manager.unboundFrames()).toBeGreaterThan(0);
    for (const source of h.slotsOf(1)) expect(source.signatures()).not.toContain(999);
  });
});

describe('slot allocation and binding', () => {
  it('preallocates three slots even with nobody else present', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1']);

    const mapping = h.manager.trackMapping(CALL, 'p1');
    expect(mapping).toHaveLength(DEFAULT_REMOTE_SLOT_COUNT);
    expect(mapping.map((slot) => slot.speakerParticipantId)).toEqual([null, null, null]);
    expect(h.peers[0]!.tracks).toHaveLength(3);
  });

  it('binds one slot per joiner, leaving the rest free', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');

    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    expect(bound(h, 'p1')).toEqual(['p2']);

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);
    expect(bound(h, 'p1')).toEqual(['p2', 'p3']);

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3', 'p4']);
    expect(bound(h, 'p1')).toEqual(['p2', 'p3', 'p4']);
  });

  it('never binds a listener to themselves', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p2', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);

    expect(bound(h, 'p2')).toEqual(['p1', 'p3']);
  });

  it('never gives one speaker two slots', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');

    // Repeated reconciliation must be idempotent.
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    expect(bound(h, 'p1')).toEqual(['p2']);
  });

  it('frees ONLY the departed speaker and keeps the others where they were', async () => {
    // Stability is the contract: somebody leaving must not move the person you
    // were already listening to onto a different track.
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3', 'p4']);
    const before = h.manager.trackMapping(CALL, 'p1').map((s) => ({ ...s }));

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p4']);
    const after = h.manager.trackMapping(CALL, 'p1');

    const p3Slot = before.find((s) => s.speakerParticipantId === 'p3')!.slot;
    expect(after[p3Slot]!.speakerParticipantId).toBeNull();
    for (const speaker of ['p2', 'p4']) {
      const wasAt = before.find((s) => s.speakerParticipantId === speaker)!.slot;
      expect(after[wasAt]!.speakerParticipantId).toBe(speaker);
    }
  });

  it('reuses a freed slot for the next joiner', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3', 'p4']);
    const freed = h.manager.trackMapping(CALL, 'p1').find((s) => s.speakerParticipantId === 'p3')!.slot;

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p4']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p4', 'p5']);

    expect(h.manager.trackMapping(CALL, 'p1')[freed]!.speakerParticipantId).toBe('p5');
    // And no track was added or removed to do it.
    expect(h.peers[0]!.tracks).toHaveLength(DEFAULT_REMOTE_SLOT_COUNT);
  });

  it('keeps audio flowing to a slot whose speaker changed, without a new track', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    const slotIndex = h.manager.trackMapping(CALL, 'p1')[0]!.slot;
    const source = h.slotsOf(0)[slotIndex]!;
    h.manager.fanOut(CALL, 'p2', frame(222));

    h.manager.syncSpeakers(CALL, ['p1']);
    h.manager.syncSpeakers(CALL, ['p1', 'p3']);
    h.manager.fanOut(CALL, 'p3', frame(333));

    expect(source.signatures()).toEqual([222, 333]);
    expect(h.slotsOf(0)[slotIndex]!.track).toBe(source.track);
  });
});

describe('track mapping contract', () => {
  it('reports every slot, including the free ones', async () => {
    // A shorter list would make "this track carries nobody" and "I have not
    // been told about this track yet" indistinguishable, and they need
    // different handling on the client.
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    const mapping = h.manager.trackMapping(CALL, 'p1');
    expect(mapping).toHaveLength(3);
    expect(mapping.filter((s) => s.speakerParticipantId === null)).toHaveLength(2);
  });

  it('carries a mid per slot, resolved from the negotiated transceivers', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');

    expect(h.manager.trackMapping(CALL, 'p1').map((s) => s.mid)).toEqual(['m0', 'm1', 'm2']);
  });

  it('reports a null mid rather than inventing one when the peer cannot say', async () => {
    const sources: FakeSource[] = [];
    const manager = new CallReceivePeerManager(
      { onLocalIceCandidate: () => {} },
      {
        createPeerConnection: () => {
          const peer = new FakePeer();
          (peer as { getTransceivers?: unknown }).getTransceivers = undefined;
          return peer as never;
        },
        createAudioSource: () => {
          const source = new FakeSource();
          sources.push(source);
          return source as never;
        },
      },
    );
    await manager.acceptOffer(CALL, 'p1', 'offer');

    expect(manager.trackMapping(CALL, 'p1').map((s) => s.mid)).toEqual([null, null, null]);
  });

  it('emits a mapping on negotiation and again on every binding change', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    expect(h.mappings).toHaveLength(1);

    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    expect(h.mappings).toHaveLength(2);
    expect(h.mappings.at(-1)!.tracks[0]!.speakerParticipantId).toBe('p2');

    // No change, no emission: a client must not be woken for nothing.
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);
    expect(h.mappings).toHaveLength(2);
  });

  it('addresses each mapping to exactly one listener', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    await h.manager.acceptOffer(CALL, 'p2', 'offer');
    h.mappings.length = 0;

    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    expect(h.mappings.map((entry) => entry.participantId).sort()).toEqual(['p1', 'p2']);
    // And each one describes only its own recipient's remote speakers.
    const forP1 = h.mappings.find((entry) => entry.participantId === 'p1')!;
    expect(forP1.tracks.map((s) => s.speakerParticipantId)).not.toContain('p1');
  });

  it('never names a participant from another call', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    await h.manager.acceptOffer('other-call', 'x1', 'offer');
    h.manager.syncSpeakers('other-call', ['x1', 'x2']);

    expect(h.manager.trackMapping(CALL, 'p1').map((s) => s.speakerParticipantId)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('negotiation and rebuild', () => {
  it('negotiates all three tracks on one peer', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');

    expect(h.peers[0]!.tracks).toHaveLength(3);
  });

  it('adds no track on ordinary join or leave', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    const before = h.peers[0]!.tracks.length;

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3', 'p4']);
    h.manager.syncSpeakers(CALL, ['p1', 'p4']);
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p4']);

    expect(h.peers[0]!.tracks).toHaveLength(before);
    expect(h.peers).toHaveLength(1);
  });

  it('rebuilds the whole slot structure and re-issues the mapping on reconnect', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);
    h.mappings.length = 0;

    // A reconnect replaces the peer.
    await h.manager.acceptOffer(CALL, 'p1', 'offer-2');

    expect(h.peers[0]!.closed).toBe(true);
    expect(h.peers[1]!.tracks).toHaveLength(3);
    // Mapping re-issued, so the client is never left holding one for tracks
    // that no longer exist.
    expect(h.mappings.length).toBeGreaterThanOrEqual(1);
    expect(h.manager.trackMapping(CALL, 'p1')).toHaveLength(3);
  });

  it('rebinds speakers after a rebuild once membership is reconciled', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);

    await h.manager.acceptOffer(CALL, 'p1', 'offer-2');
    expect(bound(h, 'p1')).toEqual([]);

    h.manager.syncSpeakers(CALL, ['p1', 'p2', 'p3']);
    expect(bound(h, 'p1')).toEqual(['p2', 'p3']);
  });

  it('stops every slot track when the peer closes', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');

    h.manager.closePeer(CALL, 'p1', 'test');

    for (const source of h.slotsOf(0)) expect(source.track.stop).toHaveBeenCalled();
  });
});

describe('two-party parity', () => {
  it('binds one slot and leaves two idle, with audio unchanged', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    await h.manager.acceptOffer(CALL, 'p2', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    h.manager.fanOut(CALL, 'p2', frame(222));

    const mapping = h.manager.trackMapping(CALL, 'p1');
    expect(mapping.filter((s) => s.speakerParticipantId !== null)).toHaveLength(1);
    expect(mapping.filter((s) => s.speakerParticipantId === null)).toHaveLength(2);

    // Exactly one source carries the audio; the idle ones carry nothing, so a
    // two-party call gains no extra audible stream and no duplicate.
    const carrying = h.slotsOf(0).filter((source) => source.received.length > 0);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.signatures()).toEqual([222]);
  });

  it('delivers each frame exactly once', async () => {
    const h = harness();
    await h.manager.acceptOffer(CALL, 'p1', 'offer');
    h.manager.syncSpeakers(CALL, ['p1', 'p2']);

    for (let index = 0; index < 10; index += 1) h.manager.fanOut(CALL, 'p2', frame(222));

    const total = h.slotsOf(0).reduce((sum, source) => sum + source.received.length, 0);
    expect(total).toBe(10);
  });
});

function bound(h: Harness, listenerId: string): string[] {
  return h.manager
    .trackMapping(CALL, listenerId)
    .map((slot) => slot.speakerParticipantId)
    .filter((id): id is string => id !== null);
}
