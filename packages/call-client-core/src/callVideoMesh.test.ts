import { describe, expect, it } from 'vitest';
import { CALL_VIDEO_MESH_MAX_REMOTES, CallVideoMesh } from './callVideoMesh';
import type { CallVideoIcePayload, CallVideoSdpPayload } from './callTypes';

/** Drains microtasks AND the negotiationneeded macrotask chain. */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sdpFrom = (from: string, target: string, sdp: string): CallVideoSdpPayload => ({
  callId: 'call-1',
  participantId: from,
  targetParticipantId: target,
  sdp,
});

const iceFrom = (
  from: string,
  target: string,
  candidate: RTCIceCandidateInit | null,
): CallVideoIcePayload => ({
  callId: 'call-1',
  participantId: from,
  targetParticipantId: target,
  candidate,
});

interface FakeCameraTrack {
  kind: string;
  enabled: boolean;
}

function localCamera() {
  const track: FakeCameraTrack = { kind: 'video', enabled: true };
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

class FakeSender {
  track: unknown;
  readonly replacedWith: unknown[] = [];

  constructor(track: unknown) {
    this.track = track;
  }

  async replaceTrack(track: unknown): Promise<void> {
    this.track = track;
    this.replacedWith.push(track);
  }
}

type FakeIceEvent = { candidate: { toJSON(): RTCIceCandidateInit } | null };
type FakeTrackEvent = { track: { kind: string }; streams: unknown[] };

/**
 * Scripted negotiation, following callWebRtc.test.ts's injected-fake
 * convention. Signalling-state bookkeeping models the spec closely enough for
 * perfect negotiation: an offer arriving in have-local-offer performs the
 * implicit rollback (counted), an answer outside have-local-offer throws.
 */
class FakePeerConnection {
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((event: FakeIceEvent) => void) | null = null;
  ontrack: ((event: FakeTrackEvent) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly senders: FakeSender[] = [];
  readonly addedTracks: { track: unknown; stream: unknown }[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  rollbackCount = 0;
  closed = false;
  /** When set, setLocalDescription parks on it (stale-continuation tests). */
  setLocalDescriptionGate: Promise<void> | null = null;
  private serial = 0;

  constructor(private readonly label: string) {}

  addTrack(track: unknown, stream: unknown): FakeSender {
    this.addedTracks.push({ track, stream });
    const sender = new FakeSender(track);
    this.senders.push(sender);
    // The browser fires negotiationneeded asynchronously after addTrack.
    queueMicrotask(() => {
      if (!this.closed) this.onnegotiationneeded?.();
    });
    return sender;
  }

  async setLocalDescription(description?: { type: string; sdp: string }): Promise<void> {
    if (this.closed) throw new Error('setLocalDescription on a closed connection');
    if (this.setLocalDescriptionGate) await this.setLocalDescriptionGate;
    this.serial += 1;
    const resolved =
      description ??
      (this.signalingState === 'have-remote-offer'
        ? { type: 'answer', sdp: `answer-from-${this.label}-${this.serial}` }
        : { type: 'offer', sdp: `offer-from-${this.label}-${this.serial}` });
    this.localDescription = resolved;
    this.signalingState = resolved.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    if (this.closed) throw new Error('setRemoteDescription on a closed connection');
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        // Implicit rollback, as the perfect-negotiation pattern relies on.
        this.rollbackCount += 1;
      }
      this.remoteDescription = description;
      this.signalingState = 'have-remote-offer';
      return;
    }
    if (this.signalingState !== 'have-local-offer') {
      throw new Error(`answer while ${this.signalingState}`);
    }
    this.remoteDescription = description;
    this.signalingState = 'stable';
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) throw new Error('addIceCandidate on a closed connection');
    if (!this.remoteDescription) throw new Error('no remote description');
    this.addedCandidates.push(candidate);
  }

  close(): void {
    this.closed = true;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }

  fireIce(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({ candidate: candidate ? { toJSON: () => candidate } : null });
  }

  fireTrack(stream: unknown, kind = 'video'): void {
    this.ontrack?.({ track: { kind }, streams: [stream] });
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function createHarness(selfId: string) {
  const peers = new Map<string, FakePeerConnection>();
  const created: string[] = [];
  const offers: CallVideoSdpPayload[] = [];
  const answers: CallVideoSdpPayload[] = [];
  const ice: CallVideoIcePayload[] = [];
  const remoteStreams: { participantId: string; stream: unknown }[] = [];
  const peerStates: { participantId: string; state: string }[] = [];
  const mesh = new CallVideoMesh({
    callId: 'call-1',
    selfParticipantId: selfId,
    sendOffer: (payload) => offers.push(payload),
    sendAnswer: (payload) => answers.push(payload),
    sendIce: (payload) => ice.push(payload),
    onRemoteStream: (participantId, stream) => remoteStreams.push({ participantId, stream }),
    onPeerState: (participantId, state) => peerStates.push({ participantId, state }),
    createPeerConnection: (remoteParticipantId) => {
      const pc = new FakePeerConnection(remoteParticipantId);
      created.push(remoteParticipantId);
      peers.set(remoteParticipantId, pc);
      return pc as unknown as RTCPeerConnection;
    },
  });
  return { mesh, peers, created, offers, answers, ice, remoteStreams, peerStates };
}

function mustPeer(peers: Map<string, FakePeerConnection>, id: string): FakePeerConnection {
  const pc = peers.get(id);
  if (!pc) throw new Error(`no fake peer for ${id}`);
  return pc;
}

describe('membership sync', () => {
  it('creates one peer per remote, ignoring self and duplicates', () => {
    const h = createHarness('a');

    h.mesh.syncParticipants(['a', 'b', 'c', 'b']);

    expect([...h.peers.keys()].sort()).toEqual(['b', 'c']);
    expect(h.mesh.diagnostics().peerCount).toBe(2);
    expect(h.mesh.diagnostics().ignoredExtraRemoteCount).toBe(0);
  });

  it('enforces the three-remote cap and counts the extras', () => {
    const h = createHarness('a');

    h.mesh.syncParticipants(['b', 'c', 'd', 'e', 'f']);

    expect(CALL_VIDEO_MESH_MAX_REMOTES).toBe(3);
    expect([...h.peers.keys()].sort()).toEqual(['b', 'c', 'd']);
    expect(h.mesh.diagnostics().ignoredExtraRemoteCount).toBe(2);
  });

  it('keeps an existing peer across a sync that repeats it', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);

    h.mesh.syncParticipants(['b', 'c']);

    expect(h.created.filter((id) => id === 'b')).toHaveLength(1);
    expect(mustPeer(h.peers, 'b').closed).toBe(false);
  });

  it('closes departed peers, clears their tile and reports closed', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b', 'c']);

    h.mesh.syncParticipants(['c']);

    expect(mustPeer(h.peers, 'b').closed).toBe(true);
    expect(h.remoteStreams).toEqual([{ participantId: 'b', stream: null }]);
    expect(h.peerStates).toEqual([{ participantId: 'b', state: 'closed' }]);
    expect(h.mesh.diagnostics().peerCount).toBe(1);
  });

  it('drops signalling from a departed peer as unknown', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    h.mesh.syncParticipants([]);

    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'late-offer'));

    expect(h.answers).toHaveLength(0);
    expect(h.mesh.diagnostics().unknownSenderDropCount).toBe(1);
  });
});

describe('offer/answer flow', () => {
  it('offers to a peer once the local camera attaches, then applies the answer', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const { stream } = localCamera();

    h.mesh.setLocalStream(stream);
    await flushAsync();

    expect(h.offers).toEqual([
      {
        callId: 'call-1',
        participantId: 'a',
        targetParticipantId: 'b',
        sdp: 'offer-from-b-1',
      },
    ]);
    const pc = mustPeer(h.peers, 'b');
    expect(pc.signalingState).toBe('have-local-offer');

    await h.mesh.handleAnswer('b', sdpFrom('b', 'a', 'their-answer'));

    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'their-answer' });
    expect(pc.signalingState).toBe('stable');
  });

  it('answers an incoming offer', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);

    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'their-offer'));

    const pc = mustPeer(h.peers, 'b');
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' });
    expect(pc.signalingState).toBe('stable');
    expect(h.answers).toEqual([
      {
        callId: 'call-1',
        participantId: 'a',
        targetParticipantId: 'b',
        sdp: 'answer-from-b-1',
      },
    ]);
  });
});

describe('glare (perfect negotiation)', () => {
  it('the polite peer — lexicographically smaller id — rolls back and answers', async () => {
    const h = createHarness('a'); // 'a' < 'b': this side is polite
    h.mesh.syncParticipants(['b']);
    h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();
    const pc = mustPeer(h.peers, 'b');
    expect(h.offers).toHaveLength(1);
    expect(pc.signalingState).toBe('have-local-offer');

    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'colliding-offer'));

    expect(pc.rollbackCount).toBe(1);
    expect(h.answers).toHaveLength(1);
    expect(pc.signalingState).toBe('stable');
  });

  it('the impolite peer — larger id — ignores the colliding offer and keeps its own', async () => {
    const h = createHarness('c'); // 'b' < 'c': this side is impolite
    h.mesh.syncParticipants(['b']);
    h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();
    const pc = mustPeer(h.peers, 'b');
    expect(h.offers).toHaveLength(1);

    await h.mesh.handleOffer('b', sdpFrom('b', 'c', 'colliding-offer'));

    expect(h.answers).toHaveLength(0);
    expect(pc.rollbackCount).toBe(0);
    expect(pc.signalingState).toBe('have-local-offer');

    // The polite remote rolled back and answered OUR offer instead.
    await h.mesh.handleAnswer('b', sdpFrom('b', 'c', 'their-answer'));

    expect(pc.signalingState).toBe('stable');
  });
});

describe('ICE', () => {
  it('forwards local candidates on the wire, including end-of-candidates', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');

    pc.fireIce({ candidate: 'cand-1', sdpMid: '0' });
    pc.fireIce(null);

    expect(h.ice).toEqual([
      {
        callId: 'call-1',
        participantId: 'a',
        targetParticipantId: 'b',
        candidate: { candidate: 'cand-1', sdpMid: '0' },
      },
      {
        callId: 'call-1',
        participantId: 'a',
        targetParticipantId: 'b',
        candidate: null,
      },
    ]);
  });

  it('queues remote candidates until a description applies, then flushes in order', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');

    await h.mesh.handleIce('b', iceFrom('b', 'a', { candidate: 'c1' }));
    await h.mesh.handleIce('b', iceFrom('b', 'a', { candidate: 'c2' }));
    expect(pc.addedCandidates).toEqual([]);

    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'their-offer'));

    expect(pc.addedCandidates).toEqual([{ candidate: 'c1' }, { candidate: 'c2' }]);
  });

  it('applies candidates directly once the remote description is in place', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'their-offer'));

    await h.mesh.handleIce('b', iceFrom('b', 'a', { candidate: 'c3' }));

    expect(mustPeer(h.peers, 'b').addedCandidates).toEqual([{ candidate: 'c3' }]);
  });

  it('drops duplicate remote candidates', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'their-offer'));

    await h.mesh.handleIce('b', iceFrom('b', 'a', { candidate: 'c1', sdpMid: '0' }));
    await h.mesh.handleIce('b', iceFrom('b', 'a', { candidate: 'c1', sdpMid: '0' }));

    expect(mustPeer(h.peers, 'b').addedCandidates).toHaveLength(1);
  });

  it('takes no action on a remote end-of-candidates marker', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.handleOffer('b', sdpFrom('b', 'a', 'their-offer'));

    await h.mesh.handleIce('b', iceFrom('b', 'a', null));

    expect(mustPeer(h.peers, 'b').addedCandidates).toEqual([]);
  });
});

describe('unknown senders fail closed', () => {
  it('drops offers, answers and candidates from senders that are not current remotes', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);

    await h.mesh.handleOffer('intruder', sdpFrom('intruder', 'a', 'x'));
    await h.mesh.handleAnswer('intruder', sdpFrom('intruder', 'a', 'x'));
    await h.mesh.handleIce('intruder', iceFrom('intruder', 'a', { candidate: 'x' }));

    expect(h.answers).toHaveLength(0);
    expect(h.peers.has('intruder')).toBe(false);
    expect(h.mesh.diagnostics().unknownSenderDropCount).toBe(3);
  });
});

describe('local camera', () => {
  it('attaches the camera track to every existing peer', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b', 'c']);
    const { track, stream } = localCamera();

    h.mesh.setLocalStream(stream);

    expect(mustPeer(h.peers, 'b').addedTracks).toEqual([{ track, stream }]);
    expect(mustPeer(h.peers, 'c').addedTracks).toEqual([{ track, stream }]);
  });

  it('attaches the camera to peers created after the stream is set', async () => {
    const h = createHarness('a');
    h.mesh.setLocalStream(localCamera().stream);

    h.mesh.syncParticipants(['b']);
    await flushAsync();

    expect(mustPeer(h.peers, 'b').addedTracks).toHaveLength(1);
    expect(h.offers).toHaveLength(1);
  });

  it('toggles the camera through the enabled flag alone — no renegotiation', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const { track, stream } = localCamera();
    h.mesh.setLocalStream(stream);
    await flushAsync();
    const pc = mustPeer(h.peers, 'b');
    const offersBefore = h.offers.length;

    h.mesh.setCameraEnabled(false);
    await flushAsync();

    expect(track.enabled).toBe(false);
    expect(h.offers).toHaveLength(offersBefore);
    expect(pc.addedTracks).toHaveLength(1);
    expect(pc.senders[0]?.replacedWith).toEqual([]);

    h.mesh.setCameraEnabled(true);
    expect(track.enabled).toBe(true);
  });

  it('applies a camera-off choice made before the stream attaches', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const { track, stream } = localCamera();

    h.mesh.setCameraEnabled(false);
    h.mesh.setLocalStream(stream);

    expect(track.enabled).toBe(false);
  });

  it('detaches with replaceTrack(null) and re-attaches without a second addTrack', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const first = localCamera();
    h.mesh.setLocalStream(first.stream);
    await flushAsync();
    const pc = mustPeer(h.peers, 'b');
    expect(h.offers).toHaveLength(1);

    h.mesh.setLocalStream(null);
    await flushAsync();

    expect(pc.senders[0]?.replacedWith).toEqual([null]);

    const second = localCamera();
    h.mesh.setLocalStream(second.stream);
    await flushAsync();

    expect(pc.senders[0]?.replacedWith).toEqual([null, second.track]);
    expect(pc.addedTracks).toHaveLength(1);
    expect(h.offers).toHaveLength(1);
  });
});

describe('remote streams', () => {
  it('delivers a remote video stream and ignores non-video tracks', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    const stream = { id: 'remote-stream' };

    pc.fireTrack(stream);
    pc.fireTrack({ id: 'audio-stream' }, 'audio');

    expect(h.remoteStreams).toHaveLength(1);
    expect(h.remoteStreams[0]?.participantId).toBe('b');
    expect(h.remoteStreams[0]?.stream).toBe(stream);
  });

  it('reports peer connection state transitions', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');

    pc.setConnectionState('connecting');
    pc.setConnectionState('connected');

    expect(h.peerStates).toEqual([
      { participantId: 'b', state: 'connecting' },
      { participantId: 'b', state: 'connected' },
    ]);
  });
});

describe('dispose', () => {
  it('closes every peer without firing departure callbacks', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b', 'c']);

    h.mesh.dispose();

    expect(mustPeer(h.peers, 'b').closed).toBe(true);
    expect(mustPeer(h.peers, 'c').closed).toBe(true);
    expect(h.remoteStreams).toEqual([]);
    expect(h.peerStates).toEqual([]);
    expect(h.mesh.diagnostics().peerCount).toBe(0);
  });

  it('is idempotent and inert afterwards', () => {
    const h = createHarness('a');
    h.mesh.dispose();
    h.mesh.dispose();

    h.mesh.syncParticipants(['b']);
    h.mesh.setLocalStream(localCamera().stream);

    expect(h.created).toEqual([]);
    expect(h.mesh.diagnostics().peerCount).toBe(0);
  });

  it('suppresses callbacks captured before dispose', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    const iceHandler = pc.onicecandidate;
    const trackHandler = pc.ontrack;
    const stateHandler = pc.onconnectionstatechange;
    if (!iceHandler || !trackHandler || !stateHandler) throw new Error('handlers not attached');

    h.mesh.dispose();
    iceHandler({ candidate: { toJSON: () => ({ candidate: 'late' }) } });
    trackHandler({ track: { kind: 'video' }, streams: [{ id: 'late' }] });
    pc.connectionState = 'failed';
    stateHandler();

    expect(h.ice).toEqual([]);
    expect(h.remoteStreams).toEqual([]);
    expect(h.peerStates).toEqual([]);
  });

  it('suppresses an in-flight negotiation that completes after dispose', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    let release!: () => void;
    pc.setLocalDescriptionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.mesh.setLocalStream(localCamera().stream);
    await flushAsync(); // negotiation is now parked inside setLocalDescription

    h.mesh.dispose();
    release();
    await flushAsync();

    expect(h.offers).toEqual([]);
  });

  it('suppresses an in-flight negotiation for a peer departed by sync', async () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    let release!: () => void;
    pc.setLocalDescriptionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    h.mesh.syncParticipants([]);
    release();
    await flushAsync();

    expect(h.offers).toEqual([]);
  });
});

describe('construction', () => {
  it('requires an injected factory when the environment has no RTCPeerConnection', () => {
    // vitest runs in node: no globalThis.RTCPeerConnection here.
    expect(
      () =>
        new CallVideoMesh({
          callId: 'call-1',
          selfParticipantId: 'a',
          sendOffer: () => {},
          sendAnswer: () => {},
          sendIce: () => {},
          onRemoteStream: () => {},
          onPeerState: () => {},
        }),
    ).toThrow(/does not support live call video/);
  });
});


/**
 * A camera that is off must look off.
 *
 * Turning a camera off stops frames; it does not remove the track, and a
 * <video> element holds the last frame it was given. The other side went on
 * showing a frozen still of somebody who believed they had gone dark -- the
 * wrong way round: they look present when they have chosen not to be.
 */
describe('remote camera off', () => {
  /** A track that can be muted, as a real MediaStreamTrack can. */
  function mutableTrack() {
    const listeners = new Map<string, (() => void)[]>();
    return {
      kind: 'video',
      muted: false,
      addEventListener(name: string, handler: () => void) {
        listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      },
      fire(name: string) {
        for (const handler of listeners.get(name) ?? []) handler();
      },
    };
  }

  it('PIN: clears the tile when the remote camera goes off, and restores it', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    const track = mutableTrack();
    const stream = { id: 'remote-stream' };

    pc.ontrack?.({ track, streams: [stream] } as never);
    expect(h.remoteStreams.at(-1)?.stream).toBe(stream);

    track.muted = true;
    track.fire('mute');
    // Null, so the tile falls back to the avatar instead of a frozen frame.
    expect(h.remoteStreams.at(-1)?.stream).toBeNull();

    track.muted = false;
    track.fire('unmute');
    expect(h.remoteStreams.at(-1)?.stream).toBe(stream);
  });

  it('PIN: a track negotiated EMPTY arrives with no stream; the injected factory wraps it', () => {
    // Every call starts camera off, so the far side's first video track has
    // no msid and `event.streams` is empty. Hermes has no global MediaStream:
    // without the factory the phone received the track and rendered nothing.
    const peers = new Map<string, FakePeerConnection>();
    const remoteStreams: { participantId: string; stream: unknown }[] = [];
    const wrapped: unknown[] = [];
    const mesh = new CallVideoMesh({
      callId: 'call-1',
      selfParticipantId: 'a',
      sendOffer: () => undefined,
      sendAnswer: () => undefined,
      sendIce: () => undefined,
      onRemoteStream: (participantId, stream) => remoteStreams.push({ participantId, stream }),
      onPeerState: () => undefined,
      createPeerConnection: (remoteParticipantId) => {
        const pc = new FakePeerConnection(remoteParticipantId);
        peers.set(remoteParticipantId, pc);
        return pc as unknown as RTCPeerConnection;
      },
      createMediaStream: (tracks) => {
        const stream = { id: 'wrapped', tracks };
        wrapped.push(stream);
        return stream as unknown as MediaStream;
      },
    });
    mesh.syncParticipants(['b']);
    const track = mutableTrack();
    mustPeer(peers, 'b').ontrack?.({ track, streams: [] } as never);
    expect(wrapped).toHaveLength(1);
    expect(remoteStreams.at(-1)).toEqual({ participantId: 'b', stream: wrapped[0] });
  });

  it('PIN: clears the tile when the remote track ends', () => {
    const h = createHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustPeer(h.peers, 'b');
    const track = mutableTrack();
    pc.ontrack?.({ track, streams: [{ id: 's' }] } as never);
    track.fire('ended');
    expect(h.remoteStreams.at(-1)?.stream).toBeNull();
  });
});

/*
 * THE PATH THE PHONES ACTUALLY TAKE.
 *
 * Every call starts camera off, and a real RTCPeerConnection has
 * `addTransceiver`, so on a phone the video m-line is negotiated EMPTY and
 * "Camera on" becomes a bare replaceTrack. The FakePeerConnection above has
 * no `addTransceiver`, so every other test in this file silently skips that
 * branch and exercises the addTrack path instead -- which is why zero
 * outbound frames on two handsets got past all of them.
 *
 * This double has `addTransceiver`, so the production path runs here.
 */
class TransceiverPeerConnection extends FakePeerConnection {
  readonly transceivers: { kind: string; direction: string; sender: FakeSender }[] = [];
  /**
   * MODELS THE DEFECT, RATHER THAN THE CALL LOG.
   *
   * A sender only encodes once an m-line has been DESCRIBED while a track was
   * on it. That is the whole bug: the phone negotiated an empty video m-line,
   * `replaceTrack` resolved, the sender held the camera, and the encoder was
   * never created. A double that reports frames because replaceTrack resolved
   * would pass the broken code, so this one refuses to.
   */
  private describedWithTrack = false;

  addTransceiver(kind: string, init?: { direction?: string }): { sender: FakeSender } {
    // A transceiver created with no track: exactly what instant camera makes.
    const sender = new FakeSender(null);
    this.senders.push(sender);
    this.transceivers.push({ kind, direction: init?.direction ?? 'sendrecv', sender });
    return { sender };
  }

  override async setLocalDescription(description?: { type: string; sdp: string }): Promise<void> {
    await super.setLocalDescription(description);
    if (this.senders.some((sender) => sender.track !== null)) this.describedWithTrack = true;
  }

  /** Frames flow only for a sender whose m-line was described carrying a track. */
  async getStats(): Promise<
    { type: string; kind: string; framesSent?: number; bytesSent?: number; framesReceived?: number; bytesReceived?: number }[]
  > {
    const sending = this.describedWithTrack && this.senders.some((sender) => sender.track !== null);
    return [
      { type: 'outbound-rtp', kind: 'video', framesSent: sending ? 42 : 0, bytesSent: sending ? 4242 : 0 },
      { type: 'inbound-rtp', kind: 'video', framesReceived: 0, bytesReceived: 0 },
    ];
  }
}

describe('instant camera, on a peer that can addTransceiver', () => {
  function transceiverHarness(selfId: string) {
    const peers = new Map<string, TransceiverPeerConnection>();
    const offers: CallVideoSdpPayload[] = [];
    const mesh = new CallVideoMesh({
      callId: 'call-1',
      selfParticipantId: selfId,
      sendOffer: (payload) => offers.push(payload),
      sendAnswer: () => undefined,
      sendIce: () => undefined,
      onRemoteStream: () => undefined,
      onPeerState: () => undefined,
      createPeerConnection: (remoteParticipantId) => {
        const pc = new TransceiverPeerConnection(remoteParticipantId);
        peers.set(remoteParticipantId, pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    return { mesh, peers, offers };
  }

  it('negotiates an empty sendrecv video m-line before the camera is on', () => {
    const h = transceiverHarness('a');
    h.mesh.syncParticipants(['b']);
    const pc = h.peers.get('b');
    expect(pc?.transceivers).toHaveLength(1);
    expect(pc?.transceivers[0]?.kind).toBe('video');
    expect(pc?.transceivers[0]?.direction).toBe('sendrecv');
    expect(pc?.transceivers[0]?.sender.track).toBeNull();
  });

  it('renegotiates when the first real track lands on that empty m-line', async () => {
    const h = transceiverHarness('a');
    h.mesh.syncParticipants(['b']);
    const { track, stream } = localCamera();

    h.mesh.setLocalStream(stream);
    await flushAsync();

    const pc = h.peers.get('b');
    // The track did reach the sender...
    expect(pc?.transceivers[0]?.sender.track).toBe(track);
    // ...and, because that m-line was described with nothing on it, the
    // camera is not left attached to an m-line that never carried a track.
    // Without the offer the sender holds the camera and sends no frames.
    expect(h.offers).toHaveLength(1);
    expect(h.offers[0]?.targetParticipantId).toBe('b');
  });

  it('does not renegotiate again on a later camera toggle', async () => {
    const h = transceiverHarness('a');
    h.mesh.syncParticipants(['b']);
    const first = localCamera();
    h.mesh.setLocalStream(first.stream);
    await flushAsync();
    const afterFirst = h.offers.length;

    // Off, then on again: the m-line has carried a track since the first
    // attach, so these are bare replaceTracks and cost no round trip.
    h.mesh.setLocalStream(null);
    await flushAsync();
    h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    expect(h.offers).toHaveLength(afterFirst);
  });
});

/*
 * The rest of the production path, one requirement per test.
 *
 * V1 only. Nothing here is evidence for the ringing, notification or timer
 * defects, which have their own tests elsewhere.
 */
describe('instant camera: the negotiation is bounded and correct', () => {
  function h2(selfId: string) {
    const peers = new Map<string, TransceiverPeerConnection>();
    const offers: CallVideoSdpPayload[] = [];
    const answers: CallVideoSdpPayload[] = [];
    const remoteStreams: { participantId: string; stream: unknown }[] = [];
    const mesh = new CallVideoMesh({
      callId: 'call-1',
      selfParticipantId: selfId,
      sendOffer: (payload) => offers.push(payload),
      sendAnswer: (payload) => answers.push(payload),
      sendIce: () => undefined,
      onRemoteStream: (participantId, stream) => remoteStreams.push({ participantId, stream }),
      onPeerState: () => undefined,
      createPeerConnection: (remoteParticipantId) => {
        const pc = new TransceiverPeerConnection(remoteParticipantId);
        peers.set(remoteParticipantId, pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    return { mesh, peers, offers, answers, remoteStreams };
  }

  /** Requirement 4 */
  it('renegotiates exactly once for the first track, not once per attach call', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    const { stream } = localCamera();

    await h.mesh.setLocalStream(stream);
    await flushAsync();
    // Attaching the very same stream again must not buy another round trip.
    await h.mesh.setLocalStream(stream);
    await flushAsync();

    expect(h.offers).toHaveLength(1);
  });

  /** Requirement 6 */
  it('never creates a second video sender, transceiver or m-line', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();
    await h.mesh.setLocalStream(null);
    await flushAsync();
    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    const pc = mustTransceiverPeer(h.peers, 'b');
    expect(pc.transceivers).toHaveLength(1);
    expect(pc.senders).toHaveLength(1);
    // addTrack would have made a second m-line; the transceiver path must not.
    expect(pc.addedTracks).toHaveLength(0);
  });

  /** Requirement 8 */
  it('survives the camera going off while the first negotiation is in flight', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    const pc = mustTransceiverPeer(h.peers, 'b');

    let release = (): void => {};
    pc.setLocalDescriptionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await h.mesh.setLocalStream(localCamera().stream);
    // Camera off before the offer this triggered has been described.
    await h.mesh.setLocalStream(null);
    release();
    await flushAsync();

    expect(pc.closed).toBe(false);
    expect(pc.senders[0]?.track).toBeNull();
    // And the phone is not left believing it is still sending.
    const stats = await h.mesh.videoStats();
    expect(stats[0]?.outboundFrames).toBe(0);
  });

  /** Requirement 9 */
  it('publishes the remote stream once the first track has been negotiated', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    const pc = mustTransceiverPeer(h.peers, 'b');
    const remote = { id: 'remote-stream' };
    pc.fireTrack(remote);

    expect(h.remoteStreams).toContainEqual({ participantId: 'b', stream: remote });
  });

  /** Requirement 11 */
  it('leaves audio alone: it adds none and ignores a remote audio track', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    const pc = mustTransceiverPeer(h.peers, 'b');
    expect(pc.transceivers.every((t) => t.kind === 'video')).toBe(true);

    const before = h.remoteStreams.length;
    pc.fireTrack({ id: 'their-microphone' }, 'audio');
    // Call audio rides the gateway legs; the mesh must not adopt it.
    expect(h.remoteStreams).toHaveLength(before);
  });

  /** The statistics requirement: the camera becomes eligible to send. */
  it('has no outbound video before the first track, and outbound after it', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);

    const cold = await h.mesh.videoStats();
    expect(cold[0]?.outboundFrames).toBe(0);
    expect(cold[0]?.outboundBytes).toBe(0);

    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    const warm = await h.mesh.videoStats();
    expect(warm[0]?.outboundFrames).toBeGreaterThan(0);
    expect(warm[0]?.outboundBytes).toBeGreaterThan(0);
  });

  /** Requirement 10 */
  it('re-establishes video when the peer is rebuilt after the camera is on', async () => {
    const h = h2('a');
    h.mesh.syncParticipants(['b']);
    await h.mesh.setLocalStream(localCamera().stream);
    await flushAsync();

    expect(h.mesh.rebuildPeer('b')).toBe(true);
    await flushAsync();

    // A peer built while the camera is already on takes the negotiated-from-
    // the-start path, so video must be flowing again rather than silently gone.
    const stats = await h.mesh.videoStats();
    expect(stats[0]?.outboundFrames).toBeGreaterThan(0);
  });
});

function mustTransceiverPeer(
  peers: Map<string, TransceiverPeerConnection>,
  id: string,
): TransceiverPeerConnection {
  const pc = peers.get(id);
  if (!pc) throw new Error(`no fake peer for ${id}`);
  return pc;
}

/*
 * Requirement 7: both people press Camera at the same moment.
 *
 * Instant camera makes that collision likely rather than rare -- the first
 * real track now renegotiates, so two simultaneous activations put two offers
 * on the wire at once. Perfect negotiation has to absorb that, or the fix for
 * V1 introduces a worse fault than the one it cures.
 */
describe('instant camera: simultaneous activation on both peers', () => {
  it('resolves glare without a stuck signalling state or a second m-line', async () => {
    const peersA = new Map<string, TransceiverPeerConnection>();
    const peersB = new Map<string, TransceiverPeerConnection>();
    /* eslint-disable prefer-const */
    let meshA: CallVideoMesh;
    let meshB: CallVideoMesh;
    /* eslint-enable prefer-const */

    const make = (
      selfId: string,
      peers: Map<string, TransceiverPeerConnection>,
      to: () => CallVideoMesh,
    ): CallVideoMesh =>
      new CallVideoMesh({
        callId: 'call-1',
        selfParticipantId: selfId,
        // Delivered to the other mesh, as the gateway relay would.
        sendOffer: (payload) => void to().handleOffer(selfId, payload),
        sendAnswer: (payload) => void to().handleAnswer(selfId, payload),
        sendIce: () => undefined,
        onRemoteStream: () => undefined,
        onPeerState: () => undefined,
        createPeerConnection: (remoteParticipantId) => {
          const pc = new TransceiverPeerConnection(remoteParticipantId);
          peers.set(remoteParticipantId, pc);
          return pc as unknown as RTCPeerConnection;
        },
      });

    meshA = make('a', peersA, () => meshB);
    meshB = make('b', peersB, () => meshA);
    meshA.syncParticipants(['b']);
    meshB.syncParticipants(['a']);

    // Both cameras, same tick.
    await Promise.all([
      meshA.setLocalStream(localCamera().stream),
      meshB.setLocalStream(localCamera().stream),
    ]);
    await flushAsync();
    await flushAsync();

    const pcA = mustTransceiverPeer(peersA, 'b');
    const pcB = mustTransceiverPeer(peersB, 'a');

    // Neither side is left mid-negotiation, and neither grew a second m-line.
    expect(pcA.closed).toBe(false);
    expect(pcB.closed).toBe(false);
    expect(pcA.transceivers).toHaveLength(1);
    expect(pcB.transceivers).toHaveLength(1);
    expect(pcA.senders).toHaveLength(1);
    expect(pcB.senders).toHaveLength(1);
    // Both cameras are still attached after the collision.
    expect(pcA.senders[0]?.track).not.toBeNull();
    expect(pcB.senders[0]?.track).not.toBeNull();

    meshA.dispose();
    meshB.dispose();
  });
});
