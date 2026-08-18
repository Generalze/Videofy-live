import { describe, expect, it, vi } from 'vitest';
import { CallPeer, stopMediaStreamTracks, type StoppableMediaStream } from './callWebRtc';
import { CALL_REMOTE_SLOT_COUNT } from './callTypes';

function fakeStream(trackCount: number, options: { throwAt?: number } = {}) {
  const stopped: number[] = [];
  const stream: StoppableMediaStream = {
    getTracks: () =>
      Array.from({ length: trackCount }, (_, index) => ({
        stop: () => {
          if (index === options.throwAt) {
            throw new Error('already stopped');
          }
          stopped.push(index);
        },
      })),
  };
  return { stream, stopped };
}

describe('stopMediaStreamTracks', () => {
  it('stops every track on the stream', () => {
    const { stream, stopped } = fakeStream(3);

    stopMediaStreamTracks(stream);

    expect(stopped).toEqual([0, 1, 2]);
  });

  it('tolerates a missing stream', () => {
    expect(() => stopMediaStreamTracks(null)).not.toThrow();
    expect(() => stopMediaStreamTracks(undefined)).not.toThrow();
  });

  it('keeps stopping the remaining tracks when one throws', () => {
    const { stream, stopped } = fakeStream(3, { throwAt: 1 });

    expect(() => stopMediaStreamTracks(stream)).not.toThrow();
    expect(stopped).toEqual([0, 2]);
  });
});

/**
 * The defect W3 human acceptance caught.
 *
 * The receive peer offered ONE recvonly transceiver, so the client's SDP had
 * one audio m-line. The gateway adds a track per conference slot, but SDP
 * negotiates only as many m-lines as the OFFER carries — measured against a
 * real @roamhq/wrtc peer, the answer came back with mids ["0", null, null].
 *
 * Two of the three slots were therefore never transmitted at all, and the
 * remaining audio still played through the legacy single-stream path, so it
 * looked like it worked. Only one remote participant could ever be heard or
 * controlled, in every window.
 */
describe('receive peer offers a transceiver per conference slot', () => {
  function fakePeer() {
    const transceivers: { kind: string; direction: string }[] = [];
    return {
      transceivers,
      connection: {
        addTransceiver: (kind: string, init: { direction: string }) => {
          transceivers.push({ kind, direction: init.direction });
        },
        addTrack: vi.fn(),
        close: vi.fn(),
        onicecandidate: null,
        onconnectionstatechange: null,
        ontrack: null,
        connectionState: 'new',
      } as unknown as RTCPeerConnection,
    };
  }

  it('offers one recvonly audio transceiver per remote slot', () => {
    const peer = fakePeer();

    new CallPeer({
      direction: 'receive',
      remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
      sendOffer: async () => '',
      onLocalIceCandidate: () => {},
      createPeerConnection: () => peer.connection,
    });

    expect(peer.transceivers).toHaveLength(CALL_REMOTE_SLOT_COUNT);
    expect(peer.transceivers.every((t) => t.kind === 'audio')).toBe(true);
    expect(peer.transceivers.every((t) => t.direction === 'recvonly')).toBe(true);
  });

  it('never offers fewer than the gateway has slots', () => {
    // A client offering fewer silently discards the extra speakers while
    // everything still appears to work, which is exactly what happened.
    expect(CALL_REMOTE_SLOT_COUNT).toBeGreaterThanOrEqual(3);
  });

  it('still works for a caller that asks for a single slot', () => {
    const peer = fakePeer();

    new CallPeer({
      direction: 'receive',
      sendOffer: async () => '',
      onLocalIceCandidate: () => {},
      createPeerConnection: () => peer.connection,
    });

    expect(peer.transceivers).toHaveLength(1);
  });

  it('adds no receive transceiver on a publish peer', () => {
    const peer = fakePeer();
    const track = { kind: 'audio' };

    new CallPeer({
      direction: 'publish',
      stream: { getAudioTracks: () => [track] } as unknown as MediaStream,
      remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
      sendOffer: async () => '',
      onLocalIceCandidate: () => {},
      createPeerConnection: () => peer.connection,
    });

    expect(peer.transceivers).toHaveLength(0);
  });
});
