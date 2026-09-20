/** @author masterzee001 */
/**
 * THE SEAM, DRIVEN: a real CallConnection, a fake gateway, captions out.
 *
 * WHY THIS FILE EXISTS WHEN callCaption.test.ts ALREADY PROVES THE MODEL. That
 * suite proves the parsing, the merge question and the card. Nothing in it
 * would notice if `socket.on(CALL_EVENTS.CAPTION, …)` were deleted from
 * `enterCall` -- and until 20 Sep 2026 that line was not there at all. The
 * gateway had been routing `call:caption` per recipient, with BOTH texts on it,
 * for the whole life of the mobile client; the phone subscribed to fourteen
 * events and captions was not one of them. Both halves built, tested, and the
 * join belonging to nobody: this repository's signature defect, and the reason
 * a decision module alone is not proof of anything.
 *
 * Same shape as callConnectionTranslatedAudio.test.ts, which was written for
 * the identical failure one event along.
 */
import { describe, expect, it, vi } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-wire';
import type {
  CallCaptionEvent,
  CallParticipantSummary,
  CallStateSnapshot,
} from '@videofy-live/call-client-core';
import type { CallLanguagePair } from '../call/callLanguages';

const CALL_ID = 'call-abc';
const ME = 'participant_me';
const SPEAKER = 'participant_them';

const shared = vi.hoisted(() => ({ socket: null as unknown }));

vi.mock('socket.io-client', () => ({
  io: () => {
    if (shared.socket === null) throw new Error('test built no socket');
    return shared.socket;
  },
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => null,
}));

vi.mock('react-native-webrtc', () => {
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

import { CallConnection } from '../call/callConnection';

type Handler = (...args: unknown[]) => void;
type Ack = (error: unknown, reply?: unknown) => void;

function participant(
  participantId: string,
  overrides: Partial<CallParticipantSummary> = {},
): CallParticipantSummary {
  return {
    participantId,
    displayName: participantId,
    speakLanguage: 'en',
    hearLanguage: 'en',
    joined: true,
    ...overrides,
  };
}

/** Two seats: they speak Yoruba, I read English. The board's own example. */
function roster(): CallParticipantSummary[] {
  return [
    participant(ME, { displayName: 'Me', speakLanguage: 'en', hearLanguage: 'en' }),
    participant(SPEAKER, { displayName: 'Tunde', speakLanguage: 'yo', hearLanguage: 'yo' }),
  ];
}

/** Exactly what services/call-session's buildCaptionPayload puts on the wire. */
function captionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: CALL_ID,
    speakerParticipantId: SPEAKER,
    speakerDisplayName: 'Tunde',
    sourceLanguage: 'yo',
    targetLanguage: 'en',
    originalText: 'Bawo ni, se daadaa ni?',
    translatedText: 'Hello, is everything well?',
    sequence: 1,
    mediaRevision: 1,
    languageRevision: 1,
    startMs: 1000,
    endMs: 2400,
    isFinal: true,
    ...overrides,
  };
}

function gatewaySocket(snapshot: CallStateSnapshot) {
  const handlers = new Map<string, Handler[]>();
  let disconnects = 0;
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
            ack(null, { ok: true, participantId: ME, resumeToken: 'resume-token', snapshot });
          } else if (event === CALL_EVENTS.PUBLISH_OFFER || event === CALL_EVENTS.RECEIVE_OFFER) {
            ack(null, { ok: true, sdp: 'v=0 answer' });
          } else {
            ack(null, { ok: true });
          }
        },
      };
    },
    io: { on(): void {} },
    /*
     * A DISCONNECTED SOCKET RECEIVES NOTHING, and the fake has to behave that
     * way or it would let a test pass that the real transport would not. This
     * is how the caption subscription ends: `leave()` disconnects, and the
     * gateway stops addressing this seat's private room.
     */
    disconnect(): void {
      disconnects += 1;
      handlers.clear();
    },
    disconnects(): number {
      return disconnects;
    },
    deliver(event: string, payload: unknown): void {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    handlerCount(event: string): number {
      return (handlers.get(event) ?? []).length;
    },
  };
}

async function joinedCall(snapshot?: CallStateSnapshot) {
  const state: CallStateSnapshot = snapshot ?? {
    callId: CALL_ID,
    callMode: 'translated',
    participants: roster(),
  };
  const socket = gatewaySocket(state);
  shared.socket = socket;
  const captions: CallCaptionEvent[] = [];
  const languages: (CallLanguagePair | null)[] = [];
  const engine: boolean[] = [];
  const errors: string[] = [];
  const connection = new CallConnection({
    gatewayUrl: 'http://gateway.test',
    callId: CALL_ID,
    displayName: 'Me',
    speakLanguage: 'en',
    hearLanguage: 'en',
    sessionToken: 'session-token',
    iceServers: [],
    translatedAudioBackend: null,
    onCaption: (event) => captions.push(event),
    onLanguages: (pair) => languages.push(pair),
    onTranslationEngine: (available) => engine.push(available),
    onRemoteStream: () => undefined,
    onPeerState: () => undefined,
    onError: (message) => errors.push(message),
  });
  const ack = await connection.join();
  return { socket, captions, languages, engine, errors, connection, ack, state };
}

describe('a joined call is subscribed to its captions', () => {
  it('hands the screen the caption the gateway addressed to this seat', async () => {
    // The production join point, exercised: delete the `CALL_EVENTS.CAPTION`
    // subscription from enterCall and this is the assertion that fails.
    const call = await joinedCall();
    expect(call.ack.ok).toBe(true);
    call.socket.deliver(CALL_EVENTS.CAPTION, captionPayload());
    expect(call.captions).toHaveLength(1);
    expect(call.captions[0]?.originalText).toBe('Bawo ni, se daadaa ni?');
    expect(call.captions[0]?.translatedText).toBe('Hello, is everything well?');
    expect(call.errors).toEqual([]);
  });

  it('is bound exactly once, and stops when the call is left', async () => {
    const call = await joinedCall();
    expect(call.socket.handlerCount(CALL_EVENTS.CAPTION)).toBe(1);
    call.connection.leave();
    // leave() lets go of the socket, and a socket that has been let go of
    // delivers nothing -- so nothing can arrive for a call this phone has left.
    expect(call.socket.disconnects()).toBe(1);
    call.socket.deliver(CALL_EVENTS.CAPTION, captionPayload({ sequence: 9 }));
    expect(call.captions).toHaveLength(0);
  });

  it('carries a same-language caption through with both halves null', async () => {
    const call = await joinedCall();
    call.socket.deliver(
      CALL_EVENTS.CAPTION,
      captionPayload({ targetLanguage: null, translatedText: null }),
    );
    expect(call.captions[0]?.targetLanguage).toBeNull();
    expect(call.captions[0]?.translatedText).toBeNull();
  });

  it('drops a caption addressed to another call rather than showing it', async () => {
    const call = await joinedCall();
    call.socket.deliver(CALL_EVENTS.CAPTION, captionPayload({ callId: 'call-somebody-else' }));
    call.socket.deliver(CALL_EVENTS.CAPTION, captionPayload({ mediaRevision: 'one' }));
    expect(call.captions).toEqual([]);
  });
});

describe('the language pair reaches the screen from call:state', () => {
  it('is delivered from the roster on the join ack, before anybody speaks', async () => {
    const call = await joinedCall();
    // The pill exists at the moment the call opens. Waiting for the first
    // caption would leave the board's pill absent for the whole of the ring.
    expect(call.languages).toContainEqual({ from: 'yo', to: 'en' });
  });

  it('is re-answered when a language changes mid-call', async () => {
    const call = await joinedCall();
    call.socket.deliver(CALL_EVENTS.STATE, {
      callId: CALL_ID,
      callMode: 'translated',
      participants: [
        participant(ME, { displayName: 'Me', speakLanguage: 'en', hearLanguage: 'ha' }),
        participant(SPEAKER, { displayName: 'Tunde', speakLanguage: 'yo', hearLanguage: 'yo' }),
      ],
    });
    expect(call.languages[call.languages.length - 1]).toEqual({ from: 'yo', to: 'ha' });
  });

  it('answers null rather than guessing when the roster has only this seat', async () => {
    const call = await joinedCall({
      callId: CALL_ID,
      callMode: 'translated',
      participants: [participant(ME, { displayName: 'Me' })],
    });
    expect(call.languages).toEqual([null]);
  });
});

describe('the server saying it cannot translate reaches the screen as itself', () => {
  it('reports the engine verdict apart from the error text', async () => {
    const call = await joinedCall();
    call.socket.deliver(CALL_EVENTS.ERROR, {
      code: 'translation-engine-unavailable',
      message: 'Translated audio is not available on this server.',
    });
    expect(call.engine).toEqual([false]);
    // Still shown as an error too: the person is owed the sentence.
    expect(call.errors).toHaveLength(1);
  });

  it('does not report an engine verdict for an unrelated call error', async () => {
    const call = await joinedCall();
    call.socket.deliver(CALL_EVENTS.ERROR, {
      code: 'call-captions-unavailable',
      message: 'Live captions and translated audio are temporarily unavailable.',
    });
    expect(call.engine).toEqual([]);
    expect(call.errors).toHaveLength(1);
  });
});
