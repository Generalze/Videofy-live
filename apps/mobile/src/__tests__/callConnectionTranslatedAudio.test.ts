/** @author masterzee001 */
/**
 * The join point, driven: a real CallConnection, a fake socket, samples out.
 *
 * WHY THIS FILE EXISTS WHEN translatedAudioLink.test.ts ALREADY DOES THE
 * SOCKET-TO-OUTPUT WALK. That suite proves the link module. Nothing proved that
 * CallConnection CALLS it -- the reviewer replaced the one production line
 * `this.startTranslatedAudio(socket)` with a comment, which reintroduces the
 * 19 Sep 2026 defect exactly (a phone that never subscribes), and 329 of 329
 * tests stayed green. CallConnection had never been instantiated by a test;
 * the two suites naming it read the file as text. That is this repository's
 * signature defect -- both halves built and tested, the join belongs to nobody
 * -- caught inside the fix for it.
 *
 * So these construct the class, run the real `join()` against a socket that
 * acks like the gateway, and assert on the SAMPLES the platform backend was
 * handed. The platform is faked at exactly the seams CallConnection already
 * exposes for the purpose: `translatedAudioBackend` (declared for this, never
 * used until now), `iceServers`, and the two modules it imports for hardware.
 */
import { describe, expect, it, vi } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-wire';
import type { CallParticipantSummary, CallStateSnapshot } from '@videofy-live/call-client-core';
import type { TranslatedPcmBackend } from '../native/translatedPcm';

const CALL_ID = 'call-abc';
const ME = 'participant_me';
const SPEAKER = 'participant_them';

/*
 * MOCKED AT THE MODULE BOUNDARY, because all three fail at import in node.
 * `vi.hoisted` gives the factories a place to find the socket a test built,
 * since the factories run before any top-level binding exists.
 */
const shared = vi.hoisted(() => ({ socket: null as unknown }));

vi.mock('socket.io-client', () => ({
  io: () => {
    if (shared.socket === null) throw new Error('test built no socket');
    return shared.socket;
  },
}));

vi.mock('expo', () => ({
  // The native backend is injected in every test here; reaching this would
  // mean the injection seam was bypassed.
  requireOptionalNativeModule: () => null,
}));

vi.mock('react-native-webrtc', () => {
  /** Enough RTCPeerConnection for CallPeer and the mesh to negotiate against. */
  class FakePeerConnection {
    localDescription: { type: string; sdp: string } | null = null;
    signalingState = 'stable';
    connectionState = 'new';
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    onnegotiationneeded: unknown = null;
    addTrack(): { replaceTrack(): Promise<void> } {
      return { replaceTrack: async () => undefined };
    }
    addTransceiver(): { sender: { replaceTrack(): Promise<void> } } {
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
    async getStats(): Promise<Map<string, unknown>> {
      return new Map();
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

// Imported AFTER the mocks are declared; vitest hoists the mocks regardless,
// but reading it this way round says what the file depends on.
import { CallConnection, type CallTranslatedAudioDiagnostic } from '../call/callConnection';

/** The wire payload, built WITHOUT the code under test. */
function wireBase64(samples: readonly number[]): string {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString('base64');
}

function participant(
  participantId: string,
  overrides: Partial<CallParticipantSummary> = {},
): CallParticipantSummary {
  return {
    participantId,
    displayName: participantId,
    speakLanguage: 'en',
    hearLanguage: 'fr',
    joined: true,
    ...overrides,
  };
}

/** Two seats, both joined: I hear French, they speak English. */
function roster(): CallParticipantSummary[] {
  return [
    participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
    participant(SPEAKER, { speakLanguage: 'en', hearLanguage: 'en' }),
  ];
}

interface Frame {
  readonly samples: readonly number[];
  readonly sequence?: number;
  readonly segmentId?: string;
}

function framePayload(frame: Frame): Record<string, unknown> {
  return {
    callId: CALL_ID,
    speakerParticipantId: SPEAKER,
    targetLanguage: 'fr',
    mediaRevision: 1,
    languageRevision: 1,
    segmentId: frame.segmentId ?? 'segment-1',
    generation: 0,
    sequence: frame.sequence ?? 0,
    segmentStartMs: (frame.sequence ?? 0) * 20,
    final: false,
    sampleRate: 16000,
    channelCount: 1,
    pcmBase64: wireBase64(frame.samples),
  };
}

type Handler = (...args: unknown[]) => void;
type Ack = (error: unknown, reply?: unknown) => void;

/**
 * A socket that answers like the gateway: acks the join with a seat and a
 * roster, acks each voice-leg offer with an answer SDP, and records every
 * emit so a test can ask what the phone sent.
 */
function gatewaySocket(options: {
  readonly snapshot: CallStateSnapshot;
  /** Throw from `on` for these events: the injected failure of the guard test. */
  readonly refuseToBind?: readonly string[];
  /** Throw from `off` for these events: a teardown that fails where leave() cannot stop. */
  readonly refuseToUnbind?: readonly string[];
}) {
  const handlers = new Map<string, Handler[]>();
  const emitted: { event: string; payload: unknown }[] = [];
  let disconnects = 0;
  const socket = {
    on(event: string, handler: Handler): void {
      if (options.refuseToBind?.includes(event)) {
        throw new Error(`injected: cannot bind ${event}`);
      }
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event: string, handler: Handler): void {
      if (options.refuseToUnbind?.includes(event) === true) {
        throw new Error(`injected: cannot unbind ${event}`);
      }
      handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
    },
    emit(event: string, payload: unknown): void {
      emitted.push({ event, payload });
    },
    timeout(): { emit(event: string, payload: unknown, ack: Ack): void } {
      return {
        emit(event, payload, ack) {
          emitted.push({ event, payload });
          if (event === CALL_EVENTS.JOIN) {
            ack(null, {
              ok: true,
              participantId: ME,
              resumeToken: 'resume-token',
              snapshot: options.snapshot,
            });
          } else if (event === CALL_EVENTS.PUBLISH_OFFER || event === CALL_EVENTS.RECEIVE_OFFER) {
            ack(null, { ok: true, sdp: 'v=0 answer' });
          } else {
            ack(null, { ok: true });
          }
        },
      };
    },
    io: { on(): void {} },
    disconnect(): void {
      disconnects += 1;
    },
    /** How many times the call actually got as far as letting go of the socket. */
    disconnects(): number {
      return disconnects;
    },
    /** What the gateway would deliver into this seat's private room. */
    deliver(event: string, payload: unknown): void {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    sent(event: string): unknown[] {
      return emitted.filter((entry) => entry.event === event).map((entry) => entry.payload);
    },
    handlerCount(event: string): number {
      return (handlers.get(event) ?? []).length;
    },
  };
  return socket;
}

/** The never-compiled Kotlin: the function is there and calling it throws. */
type NativeCall = 'write' | 'close';

function recordingBackend(throwsOn: readonly NativeCall[] = []): TranslatedPcmBackend & {
  samples(): number[];
  closes: number;
  flushes: number;
} {
  const writes: string[] = [];
  const explode = (call: NativeCall): void => {
    if (throwsOn.includes(call)) throw new Error(`native ${call} exploded`);
  };
  const backend = {
    closes: 0,
    flushes: 0,
    open: () => true,
    write(pcmBase64: string): number {
      explode('write');
      writes.push(pcmBase64);
      return Buffer.from(pcmBase64, 'base64').length;
    },
    flush(): number {
      backend.flushes += 1;
      return 0;
    },
    queuedMs: () => 0,
    close(): void {
      backend.closes += 1;
      explode('close');
    },
    samples(): number[] {
      const out: number[] = [];
      for (const write of writes) {
        const bytes = Buffer.from(write, 'base64');
        for (let index = 0; index + 1 < bytes.length; index += 2) out.push(bytes.readInt16LE(index));
      }
      return out;
    },
  };
  return backend;
}

async function joinedCall(options: {
  readonly snapshot: CallStateSnapshot;
  readonly refuseToBind?: readonly string[];
  readonly refuseToUnbind?: readonly string[];
  /** Platform calls that throw when the real native module would be reached. */
  readonly nativeThrowsOn?: readonly NativeCall[];
}) {
  const socket = gatewaySocket(options);
  shared.socket = socket;
  const backend = recordingBackend(options.nativeThrowsOn ?? []);
  const diagnostics: CallTranslatedAudioDiagnostic[] = [];
  const errors: string[] = [];
  const connection = new CallConnection({
    gatewayUrl: 'http://gateway.test',
    callId: CALL_ID,
    displayName: 'Me',
    hearLanguage: 'fr',
    speakLanguage: 'fr',
    sessionToken: 'session-token',
    // Given, so nothing fetches. Empty is a legal answer.
    iceServers: [],
    translatedAudioBackend: backend,
    onTranslatedAudio: (event) => diagnostics.push(event),
    onRemoteStream: () => undefined,
    onPeerState: () => undefined,
    onError: (message) => errors.push(message),
  });
  const ack = await connection.join();
  return {
    socket,
    backend,
    diagnostics,
    errors,
    connection,
    ack,
    send(frame: Frame): void {
      socket.deliver(CALL_EVENTS.TRANSLATED_AUDIO_FRAME, framePayload(frame));
    },
    directState(payload: Record<string, unknown>): void {
      socket.deliver(CALL_EVENTS.DIRECT_STATE, { callId: CALL_ID, state: 'connected', ...payload });
    },
  };
}

describe('CallConnection subscribes a joined call to translated speech', () => {
  it('plays the frames the gateway delivers after the join', async () => {
    // The production join point, exercised: delete `startTranslatedAudio(socket)`
    // from enterCall and this is the assertion that fails.
    const call = await joinedCall({ snapshot: { callId: CALL_ID, callMode: 'translated', participants: roster() } });
    expect(call.ack.ok).toBe(true);
    call.send({ samples: [10, 20, 30], sequence: 0 });
    call.send({ samples: [40, 50], sequence: 1 });
    expect(call.backend.samples()).toEqual([10, 20, 30, 40, 50]);
    expect(call.diagnostics).toContainEqual({ kind: 'listening' });
    expect(call.errors).toEqual([]);
  });

  it('is bound once, before the voice legs negotiate', async () => {
    const call = await joinedCall({ snapshot: { callId: CALL_ID, callMode: 'translated', participants: roster() } });
    expect(call.socket.handlerCount(CALL_EVENTS.TRANSLATED_AUDIO_FRAME)).toBe(1);
    // Both legs negotiated on the same join: the subscription did not cost them.
    expect(call.socket.sent(CALL_EVENTS.PUBLISH_OFFER)).toHaveLength(1);
    expect(call.socket.sent(CALL_EVENTS.RECEIVE_OFFER)).toHaveLength(1);
  });

  it('goes quiet and releases the output on leave', async () => {
    const call = await joinedCall({ snapshot: { callId: CALL_ID, callMode: 'translated', participants: roster() } });
    call.send({ samples: [1, 2], sequence: 0 });
    call.connection.leave();
    call.send({ samples: [3, 4], sequence: 1 });
    expect(call.backend.samples()).toEqual([1, 2]);
    expect(call.backend.closes).toBe(1);
    expect(call.socket.handlerCount(CALL_EVENTS.TRANSLATED_AUDIO_FRAME)).toBe(0);
  });
});

describe('a translated-audio path that throws does not stop the call connecting', () => {
  it('reports unavailable and negotiates voice regardless', async () => {
    // The failure is injected at the last stage of the path (the socket bind)
    // because it is the one stage with a seam; the guard sits around the
    // whole of it, and the native lookup and decoder install ahead of it have
    // never run on a phone.
    const call = await joinedCall({
      snapshot: { callId: CALL_ID, callMode: 'translated', participants: roster() },
      refuseToBind: [CALL_EVENTS.TRANSLATED_AUDIO_FRAME],
    });
    // join() resolved, and with the seat -- the whole point.
    expect(call.ack.ok).toBe(true);
    // Voice went ahead: both legs were offered after the throw.
    expect(call.socket.sent(CALL_EVENTS.PUBLISH_OFFER)).toHaveLength(1);
    expect(call.socket.sent(CALL_EVENTS.RECEIVE_OFFER)).toHaveLength(1);
    // Said out loud, as the degraded mode, and NOT as a call error the person sees.
    expect(call.diagnostics).toContainEqual({
      kind: 'unavailable',
      error: `injected: cannot bind ${CALL_EVENTS.TRANSLATED_AUDIO_FRAME}`,
    });
    expect(call.diagnostics.map((event) => event.kind)).not.toContain('listening');
    expect(call.errors).toEqual([]);
    // And the frames that then arrive go nowhere, rather than throwing again.
    call.send({ samples: [1, 2, 3] });
    expect(call.backend.samples()).toEqual([]);
  });
});

/**
 * THE GUARD THE SETUP GUARD CANNOT REACH. `startTranslatedAudio` never touches
 * the native track: the sink opens on the FIRST FRAME, which arrives long after
 * the try/catch around setup has returned, and it arrives inside socket.io's
 * synchronous dispatch. On a handset whose Kotlin never compiled this track,
 * that frame is where it throws -- through the socket handler, which is the
 * call.
 */
describe('a native track that throws mid-call costs the audio, never the call', () => {
  const translatedSnapshot = (): CallStateSnapshot => ({
    callId: CALL_ID,
    callMode: 'translated',
    participants: roster(),
  });

  it('survives the first frame throwing, and names the reason', async () => {
    const call = await joinedCall({ snapshot: translatedSnapshot(), nativeThrowsOn: ['write'] });
    expect(() => call.send({ samples: [10, 20, 30], sequence: 0 })).not.toThrow();
    // `listening` first, then the reason: the subscription DID exist, which is
    // exactly what separates this from a build with no native track. The two
    // read identically without the reason attached.
    expect(call.diagnostics).toContainEqual({ kind: 'listening' });
    expect(call.diagnostics).toContainEqual({
      kind: 'unavailable',
      error: 'translated audio write threw: native write exploded',
    });
    // The call goes on: more frames, no error shown to the person, and the
    // platform is not called again.
    expect(() => call.send({ samples: [40, 50], sequence: 1 })).not.toThrow();
    expect(call.errors).toEqual([]);
    expect(call.diagnostics.filter((event) => event.kind === 'unavailable')).toHaveLength(1);
    expect(() => call.connection.leave()).not.toThrow();
  });

  it('lets the person hang up when the native close throws', async () => {
    const call = await joinedCall({ snapshot: translatedSnapshot(), nativeThrowsOn: ['close'] });
    call.send({ samples: [1, 2], sequence: 0 });
    expect(() => call.connection.leave()).not.toThrow();
    // Leaving finished: the handler is off and the socket was let go.
    expect(call.socket.handlerCount(CALL_EVENTS.TRANSLATED_AUDIO_FRAME)).toBe(0);
    expect(call.socket.disconnects()).toBe(1);
    expect(call.diagnostics).toContainEqual({
      kind: 'unavailable',
      error: 'translated audio close threw: native close exploded',
    });
  });

  it('lets the person hang up when the unbind itself throws', async () => {
    // Not the native track this time but the shared controller's own teardown,
    // which sits on the same line of `leave()` and reaches everything after it.
    const call = await joinedCall({
      snapshot: translatedSnapshot(),
      refuseToUnbind: [CALL_EVENTS.TRANSLATED_AUDIO_FRAME],
    });
    expect(() => call.connection.leave()).not.toThrow();
    // The rest of leave() ran -- the socket, and with it the camera stop and
    // the privacy indicator, are all downstream of the line that threw.
    expect(call.socket.disconnects()).toBe(1);
    expect(call.diagnostics.some((event) => event.kind === 'unavailable')).toBe(true);
  });
});

describe('a direct call keeps its stated mode until another is stated', () => {
  /** A personal call: `call:state` carries no callMode; the mode lives on call:direct:state. */
  const personalCall = (): CallStateSnapshot => ({ callId: CALL_ID, participants: roster() });

  it('does not silence translated audio on a payload that names no mode', async () => {
    // reconcileDirectState delivers `{ callId, state }` and nothing else. Read
    // as "normal", that payload turned translated audio off for the rest of
    // the call, in the one field that shadows every other source of the mode.
    const call = await joinedCall({ snapshot: personalCall() });
    call.directState({ mode: 'translated' });
    call.send({ samples: [1, 1], sequence: 0 });
    call.directState({});
    call.send({ samples: [2, 2], sequence: 1 });
    expect(call.backend.samples()).toEqual([1, 1, 2, 2]);
  });

  it('still fails open before any mode has been stated, mid-sentence included', async () => {
    const call = await joinedCall({ snapshot: personalCall() });
    call.send({ samples: [5, 5], sequence: 0 });
    // A mode-less payload with a sentence in flight: not a mode change, so
    // nothing is discarded and the sentence carries on.
    call.directState({});
    call.send({ samples: [6, 6], sequence: 1 });
    expect(call.backend.samples()).toEqual([5, 5, 6, 6]);
    expect(call.backend.flushes).toBe(0);
  });

  it('is silenced by an explicit normal, and only by that', async () => {
    const call = await joinedCall({ snapshot: personalCall() });
    call.directState({ mode: 'translated' });
    call.send({ samples: [1, 1], sequence: 0 });
    call.directState({ mode: 'normal' });
    call.send({ samples: [2, 2], sequence: 1 });
    expect(call.backend.samples()).toEqual([1, 1]);
    // Back to translated: a fresh sentence plays again.
    call.directState({ mode: 'translated' });
    call.send({ samples: [3, 3], sequence: 0, segmentId: 'segment-2' });
    expect(call.backend.samples()).toEqual([1, 1, 3, 3]);
  });
});
