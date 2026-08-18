import { describe, expect, it, vi } from 'vitest';
import { CallRemoteSlotBinder, type CallReceiveTrackMapping } from './callRemoteSlots';

const track = (id: string) => ({ id });

function mapping(entries: [number, string | null, string | null][]): CallReceiveTrackMapping[] {
  return entries.map(([slot, mid, speakerParticipantId]) => ({ slot, mid, speakerParticipantId }));
}

const THREE_SLOTS = mapping([
  [0, 'm0', 'p2'],
  [1, 'm1', null],
  [2, 'm2', null],
]);

/**
 * The ordering hazard. Browser `track` events and gateway mapping signalling
 * have no ordering relationship, and a design that assumed one would work on a
 * developer's machine and attribute audio to the wrong person on a slow
 * connection — reproducing once a fortnight and being blamed on the network.
 */
describe('either arrival order resolves the same way', () => {
  it('A. track first, then mapping', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    expect(binder.bindings()).toEqual([]);

    binder.acceptMapping(THREE_SLOTS);

    expect(binder.bindings()).toEqual([{ slot: 0, speakerParticipantId: 'p2', track: { id: 't0' } }]);
  });

  it('B. mapping first, then track', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptMapping(THREE_SLOTS);
    expect(binder.bindings()).toEqual([]);

    binder.acceptTrack('m0', track('t0'));

    expect(binder.bindings()).toEqual([{ slot: 0, speakerParticipantId: 'p2', track: { id: 't0' } }]);
  });

  it('resolves identically whichever way three tracks and a mapping interleave', () => {
    const forward = new CallRemoteSlotBinder();
    for (const mid of ['m0', 'm1', 'm2']) forward.acceptTrack(mid, track(mid));
    forward.acceptMapping(
      mapping([
        [0, 'm0', 'p2'],
        [1, 'm1', 'p3'],
        [2, 'm2', 'p4'],
      ]),
    );

    const interleaved = new CallRemoteSlotBinder();
    interleaved.acceptTrack('m1', track('m1'));
    interleaved.acceptMapping(
      mapping([
        [0, 'm0', 'p2'],
        [1, 'm1', 'p3'],
        [2, 'm2', 'p4'],
      ]),
    );
    interleaved.acceptTrack('m2', track('m2'));
    interleaved.acceptTrack('m0', track('m0'));

    expect(interleaved.bindings()).toEqual(forward.bindings());
  });

  it('binds by mid, not by arrival order, when mids are available', () => {
    // Tracks arriving out of order must still land on the right speaker.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m2', track('third'));
    binder.acceptTrack('m0', track('first'));
    binder.acceptMapping(
      mapping([
        [0, 'm0', 'p2'],
        [1, 'm1', 'p3'],
        [2, 'm2', 'p4'],
      ]),
    );

    expect(binder.trackForSpeaker('p2')).toEqual({ id: 'first' });
    expect(binder.trackForSpeaker('p4')).toEqual({ id: 'third' });
    // p3's track has not arrived, so p3 is absent rather than mis-bound.
    expect(binder.trackForSpeaker('p3')).toBeNull();
  });
});

describe('binding changes without new tracks', () => {
  it('follows a speaker change on the same slot', () => {
    // The W2 contract: the slot is stable transport, the speaker is metadata.
    // A rebinding must move the speaker WITHOUT needing a new track event.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    binder.acceptMapping(THREE_SLOTS);
    expect(binder.trackForSpeaker('p2')).toEqual({ id: 't0' });

    binder.acceptMapping(mapping([[0, 'm0', 'p9'], [1, 'm1', null], [2, 'm2', null]]));

    expect(binder.trackForSpeaker('p2')).toBeNull();
    expect(binder.trackForSpeaker('p9')).toEqual({ id: 't0' });
  });

  it('drops a speaker whose slot was freed', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    binder.acceptMapping(THREE_SLOTS);

    binder.acceptMapping(mapping([[0, 'm0', null], [1, 'm1', null], [2, 'm2', null]]));

    expect(binder.bindings()).toEqual([]);
  });

  it('replaces the mapping wholesale rather than merging it', () => {
    // A partial merge could keep a binding alive for somebody who has left.
    const binder = new CallRemoteSlotBinder();
    for (const mid of ['m0', 'm1']) binder.acceptTrack(mid, track(mid));
    binder.acceptMapping(mapping([[0, 'm0', 'p2'], [1, 'm1', 'p3']]));
    expect(binder.bindings()).toHaveLength(2);

    binder.acceptMapping(mapping([[0, 'm0', 'p2'], [1, 'm1', null]]));

    expect(binder.bindings().map((b) => b.speakerParticipantId)).toEqual(['p2']);
  });

  it('ignores free slots entirely', () => {
    const binder = new CallRemoteSlotBinder();
    for (const mid of ['m0', 'm1', 'm2']) binder.acceptTrack(mid, track(mid));
    binder.acceptMapping(THREE_SLOTS);

    expect(binder.bindings()).toHaveLength(1);
  });
});

describe('change notification', () => {
  it('fires only when the resolved bindings actually change', () => {
    const listener = vi.fn();
    const binder = new CallRemoteSlotBinder();
    binder.onChange(listener);

    binder.acceptTrack('m0', track('t0'));
    binder.acceptMapping(THREE_SLOTS);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same mapping again: nothing resolved differently, so the UI is not churned.
    binder.acceptMapping(THREE_SLOTS);
    expect(listener).toHaveBeenCalledTimes(1);

    binder.acceptMapping(mapping([[0, 'm0', 'p9'], [1, 'm1', null], [2, 'm2', null]]));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('rebuild', () => {
  it('forgets tracks AND the mapping, because both describe a peer that is gone', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    binder.acceptMapping(THREE_SLOTS);

    binder.reset();

    expect(binder.bindings()).toEqual([]);
    // A mapping alone must not resurrect a track from the previous peer.
    binder.acceptMapping(THREE_SLOTS);
    expect(binder.bindings()).toEqual([]);
  });
});

describe('unreliable identity FAILS CLOSED', () => {
  it('refuses to attribute a mapping entry with no mid', () => {
    // In a multilingual conference, attributing A's voice to B is far worse
    // than a track that stays briefly silent. Every ordering heuristic —
    // arrival, transceiver, slot, join order — looks reliable on a fast local
    // connection and misattributes under load.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack(null, track('mystery'));
    binder.acceptMapping(mapping([[0, null, 'p2']]));

    expect(binder.bindings()).toEqual([]);
    expect(binder.trackForSpeaker('p2')).toBeNull();
  });

  it('does not fall back to track ARRIVAL order', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack(null, track('first'));
    binder.acceptTrack(null, track('second'));
    binder.acceptMapping(mapping([[0, null, 'p2'], [1, null, 'p3']]));

    expect(binder.bindings()).toEqual([]);
  });

  it('does not fall back to SLOT order when a mid is missing', () => {
    // A mapping that names slot 1 must not simply take the second track.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack(null, track('t0'));
    binder.acceptTrack(null, track('t1'));
    binder.acceptMapping(mapping([[1, null, 'p3']]));

    expect(binder.trackForSpeaker('p3')).toBeNull();
  });

  it('resolves only the entries that DO have a mid, leaving the rest unbound', () => {
    // Partial knowledge is used where it is trustworthy and nowhere else.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('known'));
    binder.acceptTrack(null, track('unknown'));
    binder.acceptMapping(mapping([[0, 'm0', 'p2'], [1, null, 'p3']]));

    expect(binder.bindings().map((b) => b.speakerParticipantId)).toEqual(['p2']);
    expect(binder.trackForSpeaker('p3')).toBeNull();
  });

  it('never binds a mid it was never given, however plausible', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    binder.acceptMapping(mapping([[0, 'm7', 'p2']]));

    expect(binder.bindings()).toEqual([]);
  });

  it('reports what it could not resolve, so silence is never mysterious', () => {
    // Failing closed is correct AND costly: a mapped-but-unresolved speaker is
    // somebody the listener cannot hear. That must be visible.
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack('m0', track('t0'));
    binder.acceptTrack(null, track('mystery'));
    binder.acceptMapping(mapping([[0, 'm0', 'p2'], [1, null, 'p3']]));

    expect(binder.diagnostics()).toEqual({
      tracksWithoutMid: 1,
      unresolvedSpeakers: ['p3'],
      boundSpeakers: ['p2'],
    });
  });

  it('clears the unresolved record on reset', () => {
    const binder = new CallRemoteSlotBinder();
    binder.acceptTrack(null, track('mystery'));
    binder.acceptMapping(mapping([[0, null, 'p2']]));

    binder.reset();

    expect(binder.diagnostics()).toEqual({
      tracksWithoutMid: 0,
      unresolvedSpeakers: [],
      boundSpeakers: [],
    });
  });
});
