/** @author masterzee001 */
/**
 * THE ADAPTER BETWEEN THE MESH AND THE TILE GATE, DRIVEN.
 *
 * WHY THIS FILE EXISTS WHEN remoteVideoGate.test.ts ALREADY PROVES THE GATE.
 * That suite proves the gate's rules against a hand-written `inbound`. Nothing
 * proved that the ten production lines which BUILD that `inbound` from
 * `mesh.videoStats()` -- callConnection.ts, inside `enterCall` -- carry the
 * right three numbers. A reviewer mutated those lines three ways and the whole
 * mobile suite stayed green each time:
 *
 *   - `measured: true` hardcoded: a phone whose getStats rejects would then
 *     read as "measured zero frames" and be held forever -- no remote video,
 *     ever, which is the exact defect the `measured` flag was added to stop.
 *   - `bytes: 0` hardcoded: a platform that counts bytesReceived but neither
 *     framesReceived nor framesDecoded would never earn a tile.
 *   - the unmeasured verdict reported as a measured one: the timeline would
 *     call an unproven tile "live", which is the one thing it must not do.
 *
 * A fix for an unwired seam, itself unwired. That is this repository's
 * signature defect, and it has now happened three times on this branch. So
 * these tests construct the real CallConnection, join it against a socket that
 * acks like the gateway, hand its mesh a remote track, and assert on what
 * reached `onRemoteStream` and `onVideoDiagnostic` for a given getStats.
 *
 * WHAT THEY DO NOT PROVE. Nothing here has run on a handset. The platform is
 * faked at the seams CallConnection already exposes; whether react-native-webrtc
 * populates framesReceived, bytesReceived, both or neither on a real Android
 * build is the open device question this gate was written to survive either way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-wire';
import type { CallParticipantSummary, CallStateSnapshot } from '@videofy-live/call-client-core';

const CALL_ID = 'call-video';
const ME = 'participant_me';
const THEM = 'participant_them';

/** One inbound-rtp report row, as react-native-webrtc would hand it over. */
interface StatRow {
  readonly type: string;
  readonly kind?: string;
  readonly framesReceived?: number;
  readonly bytesReceived?: number;
}

/*
 * MOCKED AT THE MODULE BOUNDARY: all three fail at import under node.
 * `vi.hoisted` gives the factories somewhere to find the per-test socket and
 * the per-test stats behaviour, since they run before any binding exists.
 */
const shared = vi.hoisted(() => ({
  socket: null as unknown,
  /** Every RTCPeerConnection the call built, in creation order. */
  peers: [] as {
    ontrack: ((event: unknown) => void) | null;
    isMeshPeer: boolean;
    connectionState: string;
  }[],
  /** null means getStats REJECTS; otherwise these rows are reported. */
  stats: [] as StatRow[] | null,
}));

vi.mock('socket.io-client', () => ({
  io: () => {
    if (shared.socket === null) throw new Error('test built no socket');
    return shared.socket;
  },
}));

vi.mock('expo', () => ({
  // Translated audio is not what this file measures; the native lookup
  // failing is the honest answer under node and costs nothing here.
  requireOptionalNativeModule: () => null,
}));

vi.mock('react-native-webrtc', () => {
  /**
   * Enough RTCPeerConnection for the mesh and the two voice legs, plus the
   * one thing this file needs: a getStats the test drives. The mesh is the
   * only caller that asks for a VIDEO transceiver (the voice legs ask for
   * audio), so that call is what marks a peer as the mesh's.
   */
  class FakePeerConnection {
    localDescription: { type: string; sdp: string } | null = null;
    signalingState = 'stable';
    connectionState = 'new';
    onicecandidate: unknown = null;
    ontrack: ((event: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    onnegotiationneeded: unknown = null;
    isMeshPeer = false;
    constructor() {
      shared.peers.push(this as unknown as (typeof shared.peers)[number]);
    }
    addTrack(): { replaceTrack(): Promise<void> } {
      return { replaceTrack: async () => undefined };
    }
    addTransceiver(kind: string): { sender: { replaceTrack(): Promise<void> } } {
      if (kind === 'video') this.isMeshPeer = true;
      return { sender: { replaceTrack: async () => undefined } };
    }
    async createOffer(): Promise<{ type: string; sdp: string }> {
      return { type: 'offer', sdp: 'v=0 offer' };
    }
    async setLocalDescription(description?: { type: string; sdp: string }): Promise<void> {
      this.localDescription = description ?? { type: 'offer', sdp: 'v=0 offer' };
    }
    async setRemoteDescription(): Promise<void> {
      return undefined;
    }
    async addIceCandidate(): Promise<void> {
      return undefined;
    }
    async getStats(): Promise<Map<string, StatRow>> {
      // The real rejection is a platform refusal, not a resolved empty report:
      // an empty report is "measured, nothing there" and means the opposite.
      if (shared.stats === null) throw new Error('getStats: platform refused');
      return new Map(shared.stats.map((row, index) => [String(index), row]));
    }
    getTransceivers(): unknown[] {
      return [];
    }
    close(): void {
      this.connectionState = 'closed';
    }
  }
  class FakeMediaStream {
    constructor(private readonly tracks: unknown[] = []) {}
    getTracks(): unknown[] {
      return this.tracks;
    }
    getVideoTracks(): unknown[] {
      return [];
    }
    toURL(): string {
      return 'rtc://wrapped';
    }
  }
  return {
    RTCPeerConnection: FakePeerConnection,
    MediaStream: FakeMediaStream,
    mediaDevices: {
      getUserMedia: async () => ({
        toURL: () => 'stream://local',
        getTracks: () => [],
        getAudioTracks: () => [{ enabled: true }],
      }),
    },
  };
});

// Imported after the mocks are declared; vitest hoists them regardless, but
// reading it this way round says what the file depends on.
import { CallConnection, type CallVideoDiagnostic, type RemoteStream } from '../call/callConnection';

type Handler = (...args: unknown[]) => void;
type Ack = (error: unknown, reply?: unknown) => void;

function participant(participantId: string): CallParticipantSummary {
  return {
    participantId,
    displayName: participantId,
    speakLanguage: 'en',
    hearLanguage: 'en',
    joined: true,
  };
}

/** A normal two-seat call: no translation, both joined. */
function snapshot(): CallStateSnapshot {
  return { callId: CALL_ID, participants: [participant(ME), participant(THEM)] };
}

/** A socket that acks the join with a seat and a roster, and each leg with an answer. */
function gatewaySocket() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event: string, handler: Handler): void {
      handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
    },
    emit(): void {},
    timeout(): { emit(event: string, payload: unknown, ack: Ack): void } {
      return {
        emit(event, _payload, ack) {
          if (event === CALL_EVENTS.JOIN) {
            ack(null, { ok: true, participantId: ME, resumeToken: 'resume', snapshot: snapshot() });
          } else if (event === CALL_EVENTS.PUBLISH_OFFER || event === CALL_EVENTS.RECEIVE_OFFER) {
            ack(null, { ok: true, sdp: 'v=0 answer' });
          } else {
            ack(null, { ok: true });
          }
        },
      };
    },
    io: { on(): void {} },
    disconnect(): void {},
  };
}

/** The remote track the mesh's `ontrack` receives, with its own stream. */
function remoteTrackEvent(url: string): unknown {
  return {
    track: { kind: 'video', muted: false, addEventListener: () => undefined },
    streams: [{ toURL: () => url }],
  };
}

interface Painted {
  readonly participantId: string;
  /** null means the tile was CLEARED; a string means a picture was shown. */
  readonly url: string | null;
}

/**
 * A joined call whose mesh has just been handed a remote video track --
 * exactly what react-native-webrtc does at `setRemoteDescription` time, on
 * every call, before a single RTP packet has arrived.
 */
async function callWithRemoteTrack(stats: StatRow[] | null) {
  shared.peers = [];
  shared.stats = stats;
  const socket = gatewaySocket();
  shared.socket = socket;
  const painted: Painted[] = [];
  const video: CallVideoDiagnostic[] = [];
  const errors: string[] = [];
  const connection = new CallConnection({
    gatewayUrl: 'http://gateway.test',
    callId: CALL_ID,
    displayName: 'Me',
    sessionToken: 'session-token',
    // Given, so nothing fetches. Empty is a legal answer.
    iceServers: [],
    onRemoteStream: (participantId: string, stream: RemoteStream) => {
      painted.push({ participantId, url: stream === null ? null : stream.toURL() });
    },
    onPeerState: () => undefined,
    onVideoDiagnostic: (event) => video.push(event),
    onError: (message) => errors.push(message),
  });
  await connection.join();
  const mesh = shared.peers.filter((peer) => peer.isMeshPeer);
  // One mesh peer, for the one other seat. If this is ever 0 the roster never
  // reached syncParticipants and nothing below would be measuring the adapter.
  expect(mesh).toHaveLength(1);
  mesh[0]?.ontrack?.(remoteTrackEvent('rtc://them'));
  return {
    connection,
    painted,
    video,
    errors,
    /** Let the gate's sampling loop run to its next real 500 ms timer. */
    settle: async (): Promise<void> => {
      for (let pass = 0; pass < 6; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Wait out `count` of the gate's 500 ms fast samples. */
    samples: async (count: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, count * 500 + 120));
    },
  };
}

afterEach(() => {
  shared.peers = [];
  shared.stats = [];
});

describe('the mesh-to-gate adapter carries the numbers getStats actually reported', () => {
  it('shows the tile and reports the exact frame and byte counts', async () => {
    const call = await callWithRemoteTrack([
      { type: 'inbound-rtp', kind: 'video', framesReceived: 24, bytesReceived: 4800 },
    ]);
    await call.settle();

    expect(call.painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    /*
     * The counts, not merely "a live verdict happened". An adapter that
     * hardcoded either number would still paint a tile here; only the
     * numbers say the stats row was read.
     */
    expect(call.video).toContainEqual({
      kind: 'remote-live',
      participantId: THEM,
      frames: 24,
      bytes: 4800,
    });
    expect(call.errors).toEqual([]);
    call.connection.leave();
  });

  it('shows the tile on bytes alone, for a platform that counts no frames', async () => {
    /*
     * MUTANT M5's TARGET. With `bytes: 0` hardcoded in the adapter this is a
     * stream with no proof at all and the tile never appears -- on a platform
     * whose inbound-rtp carries bytesReceived and neither framesReceived nor
     * framesDecoded, which is why the gate accepts bytes in the first place.
     */
    const call = await callWithRemoteTrack([
      { type: 'inbound-rtp', kind: 'video', bytesReceived: 5120 },
    ]);
    await call.settle();

    expect(call.painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    expect(call.video).toContainEqual({
      kind: 'remote-live',
      participantId: THEM,
      frames: 0,
      bytes: 5120,
    });
    call.connection.leave();
  });

  it('holds the tile down for a track that is delivering nothing', async () => {
    const call = await callWithRemoteTrack([
      { type: 'inbound-rtp', kind: 'video', framesReceived: 0, bytesReceived: 0 },
    ]);
    await call.samples(6);

    // The founder's flash: on the old path this is where a tile appeared and
    // went away again three seconds later.
    expect(call.painted.filter((entry) => entry.url !== null)).toEqual([]);
    expect(call.video.map((event) => event.kind)).toContain('remote-offered');
    expect(call.video.some((event) => event.kind === 'remote-live')).toBe(false);
    call.connection.leave();
  });

  it('shows the tile unproven, and says so, when getStats refuses', async () => {
    /*
     * MUTANT M4 and M6's TARGET. With `measured: true` hardcoded the gate
     * reads these zeros as "measured, nothing arrived" and holds the stream
     * for the whole call -- no remote video, ever, on a phone whose getStats
     * rejects, which is strictly worse than the flash. With the unmeasured
     * verdict reported as a live one, the timeline calls an unproven tile
     * proven, which is the one claim it must never make.
     */
    const call = await callWithRemoteTrack(null);
    await call.samples(3);

    expect(call.painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    expect(call.video).toContainEqual({ kind: 'remote-unmeasured', participantId: THEM });
    expect(call.video.some((event) => event.kind === 'remote-live')).toBe(false);
    call.connection.leave();
  });

  it('is not opened by one refusal that the platform then answers', async () => {
    /*
     * The t=0 fail-open, from the production side. A single transient
     * rejection must not be read as a phone that cannot measure, or the
     * flash comes back on every call that stumbles once.
     */
    const call = await callWithRemoteTrack(null);
    await call.settle();
    expect(call.painted).toEqual([]);

    // getStats starts answering, with nothing to report: an audio-only call.
    shared.stats = [{ type: 'inbound-rtp', kind: 'video', framesReceived: 0, bytesReceived: 0 }];
    await call.samples(6);

    expect(call.painted).toEqual([]);
    expect(call.video.some((event) => event.kind === 'remote-unmeasured')).toBe(false);
    call.connection.leave();
  });

  it('ignores audio counters when deciding whether video arrived', async () => {
    // A call with healthy voice and no picture is the normal case, and an
    // adapter that summed every kind would show a tile on every call.
    const call = await callWithRemoteTrack([
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 96000 },
      { type: 'inbound-rtp', kind: 'video', framesReceived: 0, bytesReceived: 0 },
    ]);
    await call.samples(6);

    expect(call.painted.filter((entry) => entry.url !== null)).toEqual([]);
    call.connection.leave();
  });
});
