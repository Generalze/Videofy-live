/** @owner masterzee001 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSessionStore } from '@videofy-live/call-session';
import type {
  GeneratedAudioReadyEvent,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcIceCandidateEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { WEBRTC_BACKEND_MEDIA_PEER_ID } from '@videofy-live/shared-types';
import {
  CALL_EVENTS,
  CallRuntime,
  callPublishPeerKey,
  type CallJoinAck,
  type CallMediaPeerHandlers,
  type CallSdpAck,
  type CallSocketLike,
} from '../call-runtime.js';
import type { CallReceivePeerHandlers } from '../call-receive-peers.js';
import { CallTranscriptLog, type CallTranscriptRecord } from '../call-transcript-log.js';
import type { WebRtcAudioDataLike } from '../webrtc-audio-ingest-bridge.js';
import {
  HttpWebRtcTranscriptionSubmissionClient,
  type WebRtcTranscriptionBridgeContext,
} from '../webrtc-transcription-bridge.js';

class FakeSocket implements CallSocketLike {
  readonly rooms = new Set<string>();
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(readonly id: string) {}

  join(room: string): void {
    this.rooms.add(room);
  }

  leave(room: string): void {
    this.rooms.delete(room);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  on(event: string, handler: (...args: never[]) => void): void {
    this.handlers.set(event, handler as (...args: unknown[]) => unknown);
  }

  async trigger(event: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    await handler(...args);
  }
}

interface FakeTimer {
  id: number;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
}

const JOIN_A = {
  callId: 'demo',
  displayName: 'Ana',
  speakLanguage: 'en',
  hearLanguage: 'en',
  captionsEnabled: true,
  voiceGender: 'male',
  audioMode: 'translated',
} as const;

const JOIN_B = {
  callId: 'demo',
  displayName: 'Beto',
  speakLanguage: 'es',
  hearLanguage: 'es',
  captionsEnabled: true,
  voiceGender: 'female',
  audioMode: 'translated',
} as const;

const GRACE_MS = 5_000;

/** Captures records in memory instead of writing the development JSONL file. */
class RecordingTranscriptLog extends CallTranscriptLog {
  readonly records: CallTranscriptRecord[] = [];

  constructor() {
    super(null);
  }

  override append(record: CallTranscriptRecord): void {
    this.records.push(record);
  }
}

interface FakeChunkTiming {
  sequence: number;
  startMs: number;
  endMs: number;
  capturedAtMs: number;
  submittedAtMs: number | null;
}

function createHarness() {
  let tokenSerial = 0;
  const store = new CallSessionStore({
    now: () => '2026-08-14T00:00:00.000Z',
    createResumeToken: () => `resume-token-${++tokenSerial}`,
  });
  const emitToRoom = vi.fn<(room: string, event: string, payload: unknown) => void>();
  const ingestControl = {
    createSession: vi.fn(async (_input: WebRtcTranscriptionBridgeContext) => {}),
    stopSession: vi.fn(async (_sessionId: string) => {}),
    deleteSession: vi.fn(async (_sessionId: string) => {}),
  };
  // Stands in for WebRtcTranscriptionBridge: chunk wall-clock anchors and
  // backpressure counters the runtime reads for latency and the call summary.
  const chunkTimings = new Map<string, FakeChunkTiming[]>();
  const sessionCounters = new Map<
    string,
    { evictedChunkCount: number; skippedFrameCount: number; submissionFailureCount: number }
  >();
  const transcriptionBridge = {
    handleFrame: vi.fn(
      (_context: WebRtcTranscriptionBridgeContext, _data: WebRtcAudioDataLike) => {},
    ),
    endSession: vi.fn((_context: WebRtcTranscriptionBridgeContext, _reason: string) => {}),
    cleanupClosedSessions: vi.fn(() => 0),
    lookupChunkTiming: vi.fn((sessionId: string, revision: number, mediaMs: number) => {
      const timings = chunkTimings.get(`${sessionId}:${revision}`) ?? [];
      for (let index = timings.length - 1; index >= 0; index--) {
        const timing = timings[index];
        if (timing && timing.startMs <= mediaMs) return { ...timing };
      }
      return null;
    }),
    getSessionCounters: vi.fn(
      (sessionId: string, revision: number) => sessionCounters.get(`${sessionId}:${revision}`) ?? null,
    ),
  };
  const transcriptLog = new RecordingTranscriptLog();
  let clockMs = 100_000;
  const mediaPeers = {
    acceptOffer: vi.fn(
      async (
        _socketId: string,
        offer: WebRtcSdpOfferEnvelope,
        _session: WebRtcSessionSummary,
      ): Promise<WebRtcSdpAnswerEnvelope> => ({
        type: 'sdp-answer',
        protocolVersion: 1,
        messageId: 'msg_test_answer',
        broadcastId: offer.broadcastId,
        sessionId: offer.sessionId as string,
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision: offer.revision,
        createdAt: '2026-08-14T00:00:00.000Z',
        payload: { targetPeerId: offer.peerId, sdp: 'answer-sdp' },
      }),
    ),
    addRemoteCandidate: vi.fn(async (_envelope: WebRtcIceCandidateEnvelope) => {}),
    closeSession: vi.fn((_sessionId: string | undefined, _reason?: string) => {}),
    getSnapshots: vi.fn(() => [] as unknown[]),
  };
  const receivePeers = {
    acceptOffer: vi.fn(
      async (_callId: string, _participantId: string, _sdp: string) => 'receive-answer-sdp',
    ),
    addRemoteCandidate: vi.fn(
      async (_callId: string, _participantId: string, _candidate: { candidate: string }) => {},
    ),
    fanOut: vi.fn(
      (_callId: string, _speakerParticipantId: string, _data: WebRtcAudioDataLike) => {},
    ),
    closePeer: vi.fn((_callId: string, _participantId: string, _reason: string) => {}),
    closeCall: vi.fn((_callId: string, _reason: string) => {}),
    count: vi.fn(() => 0),
  };
  const timers: FakeTimer[] = [];
  let timerSerial = 0;
  let mediaHandlers: CallMediaPeerHandlers | null = null;
  let receiveHandlers: CallReceivePeerHandlers | null = null;
  const runtime = new CallRuntime({
    store,
    emitToRoom,
    ingestControl,
    transcriptionBridge,
    createMediaPeers: (handlers) => {
      mediaHandlers = handlers;
      return mediaPeers;
    },
    createReceivePeers: (handlers) => {
      receiveHandlers = handlers;
      return receivePeers;
    },
    disconnectGraceMs: GRACE_MS,
    setTimer: (callback, delayMs) => {
      const timer: FakeTimer = { id: ++timerSerial, delayMs, callback, cleared: false };
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const timer = timers.find((candidate) => candidate.id === (handle as unknown as number));
      if (timer) timer.cleared = true;
    },
    transcriptLog,
    now: () => clockMs,
  });
  return {
    store,
    runtime,
    emitToRoom,
    ingestControl,
    transcriptionBridge,
    mediaPeers,
    receivePeers,
    timers,
    transcriptLog,
    setClock: (nextMs: number) => {
      clockMs = nextMs;
    },
    setChunkTimings: (sessionId: string, revision: number, timings: FakeChunkTiming[]) => {
      chunkTimings.set(`${sessionId}:${revision}`, timings);
    },
    setSessionCounters: (
      sessionId: string,
      revision: number,
      counters: { evictedChunkCount: number; skippedFrameCount: number; submissionFailureCount: number },
    ) => {
      sessionCounters.set(`${sessionId}:${revision}`, counters);
    },
    records: (kind: CallTranscriptRecord['kind']) =>
      transcriptLog.records.filter((record) => record.kind === kind),
    mediaHandlers: () => {
      if (!mediaHandlers) throw new Error('media peer handlers were not captured');
      return mediaHandlers;
    },
    receiveHandlers: () => {
      if (!receiveHandlers) throw new Error('receive peer handlers were not captured');
      return receiveHandlers;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

async function join(
  harness: Harness,
  socket: FakeSocket,
  payload: Record<string, unknown>,
): Promise<CallJoinAck> {
  harness.runtime.registerSocket(socket);
  const ack = vi.fn();
  await socket.trigger(CALL_EVENTS.JOIN, payload, ack);
  expect(ack).toHaveBeenCalledTimes(1);
  return ack.mock.calls[0]?.[0] as CallJoinAck;
}

function roomEmissions(harness: Harness, event: string): { room: string; payload: unknown }[] {
  return harness.emitToRoom.mock.calls
    .filter((call) => call[1] === event)
    .map((call) => ({ room: call[0], payload: call[2] }));
}

/** Fire every scheduled, uncleared, unfired reap timer once. */
function firePendingTimers(harness: Harness): void {
  for (const timer of [...harness.timers]) {
    if (timer.cleared) continue;
    timer.cleared = true;
    timer.callback();
  }
}

/** Let stop→delete promise chains settle before asserting on deleteSession. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function transcriptionEvent(overrides: Partial<TranscriptionEvent>): TranscriptionEvent {
  return {
    sessionId: 'call_demo_participant_1_r2',
    streamId: 'callcast_demo_participant_1_r2',
    chunkId: 'chunk-1',
    sequence: 1,
    sourceText: 'hello there',
    detectedLanguage: 'en',
    startMs: 0,
    endMs: 1200,
    confidence: 0.9,
    status: 'transcribed',
    createdAt: '2026-08-14T00:00:01.000Z',
    ...overrides,
  };
}

function translationEvent(
  overrides: Partial<TimestampedTranslationEvent>,
): TimestampedTranslationEvent {
  return {
    sessionId: 'call_demo_participant_1_r2',
    streamId: 'callcast_demo_participant_1_r2',
    segmentId: 'segment-1',
    sequence: 1,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceText: 'hello there',
    translatedText: 'hola',
    startMs: 0,
    endMs: 1200,
    status: 'translated',
    latency: { queuedMs: 1, providerMs: 2, totalMs: 3 },
    createdAt: '2026-08-14T00:00:01.000Z',
    ...overrides,
  };
}

function generatedAudioEvent(
  overrides: Partial<GeneratedAudioReadyEvent>,
): GeneratedAudioReadyEvent {
  return {
    sessionId: 'call_demo_participant_1_r2',
    streamId: 'callcast_demo_participant_1_r2',
    segmentId: 'segment-1',
    sequence: 1,
    targetLanguage: 'es',
    translatedText: 'hola',
    startMs: 0,
    endMs: 900,
    voiceId: 'es_ES-sharvard-female',
    durationMs: 900,
    providerLatencyMs: 40,
    audioUrl: 'http://localhost:3002/sessions/call_demo_participant_1_r2/generated-audio/1.wav',
    createdAt: '2026-08-14T00:00:02.000Z',
    ...overrides,
  };
}

describe('CallRuntime join and ingest plan handling', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('joins a solo participant, returns the resume token privately, and defers ingest creation', async () => {
    const socket = new FakeSocket('socket-a');
    const ack = await join(harness, socket, { ...JOIN_A });

    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.participantId).toBe('participant_1');
    expect(ack.resumeToken).toBe('resume-token-1');
    expect(ack.snapshot).toEqual({
      callId: 'demo',
      state: 'waiting',
      participants: [
        {
          participantId: 'participant_1',
          displayName: 'Ana',
          speakLanguage: 'en',
          hearLanguage: 'en',
          joined: true,
        },
      ],
    });
    expect(socket.rooms.has('call:demo')).toBe(true);
    expect(socket.rooms.has('call:demo:participant:participant_1')).toBe(true);

    const stateEmissions = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(stateEmissions).toHaveLength(1);
    expect(stateEmissions[0]?.room).toBe('call:demo');
    // Sanitization: no ingest ids, broadcast ids, revisions, voices, or tokens.
    const serialized = JSON.stringify(stateEmissions[0]?.payload);
    expect(serialized).not.toContain('call_demo');
    expect(serialized).not.toContain('callcast');
    expect(serialized).not.toContain('Revision');
    expect(serialized).not.toContain('voice');
    expect(serialized).not.toContain('resume-token');

    // No connected recipient yet: transcription/translation would serve
    // nobody, and the next membership change mints a fresh revision-scoped
    // session anyway, so creation is deferred.
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBe(1);
  });

  it('rejects an invalid join with a user-facing error only', async () => {
    const socket = new FakeSocket('socket-a');
    const ack = await join(harness, socket, { ...JOIN_A, callId: 'bad id!' });
    expect(ack.ok).toBe(false);
    if (ack.ok) return;
    expect(ack.code).toBe('invalid-input');
    expect(ack.error).toBe(
      'Call ids may only use letters, numbers, dashes, and underscores (up to 64 characters).',
    );
    expect(harness.runtime.getDiagnostics().activeCallCount).toBe(0);
  });

  it('creates BOTH revision-scoped ingest sessions with exact inputs including voiceIdsByLanguage on the second join', async () => {
    await join(harness, new FakeSocket('socket-a'), { ...JOIN_A });
    await join(harness, new FakeSocket('socket-b'), { ...JOIN_B });

    // Membership change bumped the first joiner to r2; the second joins at r1.
    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(2);
    // Ana speaks en; Beto hears es with a female voice choice.
    expect(harness.ingestControl.createSession).toHaveBeenNthCalledWith(1, {
      sessionId: 'call_demo_participant_1_r2',
      broadcastId: 'callcast_demo_participant_1_r2',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 2,
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguages: ['es'],
      targetLanguage: 'es',
      voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
      generatedAudioPacing: 'natural',
    });
    // Beto speaks es; Ana hears en with a male voice choice.
    expect(harness.ingestControl.createSession).toHaveBeenNthCalledWith(2, {
      sessionId: 'call_demo_participant_2_r1',
      broadcastId: 'callcast_demo_participant_2_r1',
      broadcasterPeerId: 'peer_call_participant_2',
      revision: 1,
      sourceLanguage: 'es',
      sourceLanguageMode: 'manual',
      targetLanguages: ['en'],
      targetLanguage: 'en',
      voiceIdsByLanguage: { en: 'en_US-hfc_male-medium' },
      generatedAudioPacing: 'natural',
    });
    // The first joiner's deferred r1 registry entry was retired (never created,
    // so nothing to stop OR delete), and exactly the two current entries remain.
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalled();
    await flushAsync();
    expect(harness.ingestControl.deleteSession).not.toHaveBeenCalled();
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBe(2);
  });

  it('carries the speaker’s voice owner to media-ingest, and only theirs', async () => {
    // The last live failure had the personal-voice router present in the path
    // and receiving a standard voice, because nothing ever told media-ingest
    // whose voice it was allowed to speak in.
    await join(harness, new FakeSocket('socket-a'), {
      ...JOIN_A,
      voiceOwnerId: 'acct_aaaaaaaaaaaaaaaa',
    });
    await join(harness, new FakeSocket('socket-b'), { ...JOIN_B });

    const [ana] = harness.ingestControl.createSession.mock.calls[0]!;
    const [beto] = harness.ingestControl.createSession.mock.calls[1]!;
    expect(ana.voiceOwnerId).toBe('acct_aaaaaaaaaaaaaaaa');
    // Beto never enrolled, so the field is absent rather than empty — an
    // owner id on his session would be somebody else's voice.
    expect('voiceOwnerId' in beto).toBe(false);
    // And the voice planning stays standard: a personal voice resolved here
    // would be cached for the life of the media revision.
    expect(JSON.stringify(ana.voiceIdsByLanguage)).not.toContain('personal:');
  });

  it('never puts the voice owner in anything the room can see', async () => {
    await join(harness, new FakeSocket('socket-a'), {
      ...JOIN_A,
      voiceOwnerId: 'acct_aaaaaaaaaaaaaaaa',
    });
    await join(harness, new FakeSocket('socket-b'), { ...JOIN_B });

    expect(JSON.stringify(harness.emitToRoom.mock.calls)).not.toContain('acct_0000000000000000');
  });

  it('uses a synthetic other-language target and no voice overrides for a same-language pair', async () => {
    await join(harness, new FakeSocket('socket-a'), { ...JOIN_A });
    await join(harness, new FakeSocket('socket-b'), {
      ...JOIN_B,
      speakLanguage: 'en',
      hearLanguage: 'en',
    });

    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(2);
    for (const [input] of harness.ingestControl.createSession.mock.calls) {
      // Same-language pair: media-ingest rejects target === source, so the
      // OTHER supported call language keeps transcription (captions) flowing.
      expect(input.sourceLanguage).toBe('en');
      expect(input.targetLanguages).toEqual(['es']);
      expect(input.targetLanguage).toBe('es');
      expect('voiceIdsByLanguage' in input).toBe(false);
    }
  });

  it('rejects a resume with a wrong token using the indistinguishable store error', async () => {
    await join(harness, new FakeSocket('socket-a'), { ...JOIN_A });
    const ack = await join(harness, new FakeSocket('socket-a2'), {
      ...JOIN_A,
      resumeParticipantId: 'participant_1',
      resumeToken: 'wrong-token',
    });
    expect(ack.ok).toBe(false);
    if (ack.ok) return;
    expect(ack.code).toBe('unknown-participant');
    expect(ack.error).toBe('That participant is no longer part of this call.');
  });
});

describe('CallRuntime event interception and recipient routing', () => {
  let harness: Harness;
  let socketA: FakeSocket;
  let socketB: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    socketB = new FakeSocket('socket-b');
    await join(harness, socketA, { ...JOIN_A });
    await join(harness, socketB, { ...JOIN_B });
    harness.emitToRoom.mockClear();
  });

  it('routes a translated caption to the hearing recipient room only', () => {
    const intercepted = harness.runtime.interceptTimestampedTranslationEvent(translationEvent({}));
    expect(intercepted).toBe(true);

    const captions = roomEmissions(harness, CALL_EVENTS.CAPTION);
    expect(captions).toHaveLength(1);
    expect(captions[0]?.room).toBe('call:demo:participant:participant_2');
    expect(captions[0]?.payload).toEqual({
      callId: 'demo',
      speakerParticipantId: 'participant_1',
      speakerDisplayName: 'Ana',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      originalText: 'hello there',
      translatedText: 'hola',
      sequence: 1,
      mediaRevision: 2,
      languageRevision: 1,
      startMs: 0,
      endMs: 1200,
      isFinal: true,
    });
  });

  it('routes an original transcription caption to a same-language recipient only', async () => {
    const sameLanguageHarness = createHarness();
    await join(sameLanguageHarness, new FakeSocket('socket-a'), { ...JOIN_A });
    await join(sameLanguageHarness, new FakeSocket('socket-b'), {
      ...JOIN_B,
      speakLanguage: 'en',
      hearLanguage: 'en',
    });
    sameLanguageHarness.emitToRoom.mockClear();

    const intercepted = sameLanguageHarness.runtime.interceptTranscriptionEvent(
      transcriptionEvent({}),
    );
    expect(intercepted).toBe(true);

    // The speaker sees their own transcript, and the same-language recipient
    // gets it as their caption.
    const captions = roomEmissions(sameLanguageHarness, CALL_EVENTS.CAPTION);
    expect(captions.map((caption) => caption.room)).toEqual([
      'call:demo:participant:participant_1',
      'call:demo:participant:participant_2',
    ]);
    expect(captions[1]?.payload).toMatchObject({
      speakerParticipantId: 'participant_1',
      sourceLanguage: 'en',
      targetLanguage: null,
      originalText: 'hello there',
      translatedText: null,
      isFinal: true,
    });
  });

  it('does not deliver a mismatched-language transcription caption to a translated-language recipient', () => {
    // Beto hears es; the original en transcript is not his caption channel.
    // Only the speaker's own transcript is emitted.
    const intercepted = harness.runtime.interceptTranscriptionEvent(transcriptionEvent({}));
    expect(intercepted).toBe(true);
    const captions = roomEmissions(harness, CALL_EVENTS.CAPTION);
    expect(captions.map((caption) => caption.room)).toEqual([
      'call:demo:participant:participant_1',
    ]);
  });

  it('routes generated audio to the recipient room only and never the speaker', () => {
    const intercepted = harness.runtime.interceptGeneratedAudioEvent(generatedAudioEvent({}));
    expect(intercepted).toBe(true);

    const deliveries = roomEmissions(harness, CALL_EVENTS.GENERATED_AUDIO);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.room).toBe('call:demo:participant:participant_2');
    expect(deliveries[0]?.payload).toEqual({
      callId: 'demo',
      speakerParticipantId: 'participant_1',
      targetLanguage: 'es',
      voiceId: 'es_ES-sharvard-female',
      // Exactly the media-ingest URL as published, untouched.
      audioUrl: 'http://localhost:3002/sessions/call_demo_participant_1_r2/generated-audio/1.wav',
      sequence: 1,
      startMs: 0,
      durationMs: 900,
      mediaRevision: 2,
      languageRevision: 1,
    });
    const rooms = deliveries.map((delivery) => delivery.room);
    expect(rooms).not.toContain('call:demo:participant:participant_1');
  });

  it('swallows events for stale revision-scoped ids without stamping or routing them', () => {
    // r1 was the first joiner's pre-pair session; it was retired on rekey.
    const intercepted = harness.runtime.interceptTimestampedTranslationEvent(
      translationEvent({ sessionId: 'call_demo_participant_1_r1' }),
    );
    expect(intercepted).toBe(true);
    expect(roomEmissions(harness, CALL_EVENTS.CAPTION)).toHaveLength(0);
  });

  it('never routes captions to a disconnected recipient', () => {
    harness.runtime.handleSocketDisconnect('socket-b');
    harness.emitToRoom.mockClear();
    const intercepted = harness.runtime.interceptTimestampedTranslationEvent(translationEvent({}));
    expect(intercepted).toBe(true);
    expect(roomEmissions(harness, CALL_EVENTS.CAPTION)).toHaveLength(0);
  });

  it('leaves programme events untouched and swallows unknown call_ events', async () => {
    expect(
      harness.runtime.interceptTranscriptionEvent(transcriptionEvent({ sessionId: 'session_42' })),
    ).toBe(false);
    expect(
      harness.runtime.interceptTimestampedTranslationEvent(
        translationEvent({ sessionId: 'wrs_abc' }),
      ),
    ).toBe(false);
    expect(
      harness.runtime.interceptGeneratedAudioEvent(
        generatedAudioEvent({ sessionId: 'session_42' }),
      ),
    ).toBe(false);
    expect(roomEmissions(harness, CALL_EVENTS.CAPTION)).toHaveLength(0);
    expect(roomEmissions(harness, CALL_EVENTS.GENERATED_AUDIO)).toHaveLength(0);

    // Unknown call sessions are swallowed (never forwarded to programme rooms).
    expect(
      harness.runtime.interceptTranscriptionEvent(
        transcriptionEvent({ sessionId: 'call_unknown_participant_9_r1' }),
      ),
    ).toBe(true);
    expect(roomEmissions(harness, CALL_EVENTS.CAPTION)).toHaveLength(0);

    // Programme paths never trigger call session deletion.
    await flushAsync();
    expect(harness.ingestControl.deleteSession).not.toHaveBeenCalled();
  });

  it('swallows call media-state events so they never reach programme broadcasts', () => {
    expect(
      harness.runtime.interceptMediaStateEvent({
        eventId: 'evt',
        processingSessionId: 'call_demo_participant_1_r2',
        streamStatus: 'processing',
        videoSource: 'webrtc',
        videoTimestampMs: 0,
        sourceAudioActive: true,
        translatedLanguages: ['es'],
        connectedListeners: 0,
        createdAt: '2026-08-14T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      harness.runtime.interceptMediaStateEvent({
        eventId: 'evt',
        processingSessionId: 'session_7',
        streamStatus: 'processing',
        videoSource: 'webrtc',
        videoTimestampMs: 0,
        sourceAudioActive: true,
        translatedLanguages: ['es'],
        connectedListeners: 0,
        createdAt: '2026-08-14T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('CallRuntime WebRTC transport', () => {
  let harness: Harness;
  let socketA: FakeSocket;
  let socketB: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    socketB = new FakeSocket('socket-b');
    await join(harness, socketA, { ...JOIN_A });
    await join(harness, socketB, { ...JOIN_B });
    harness.emitToRoom.mockClear();
  });

  async function publish(socket: FakeSocket, participantId: string): Promise<CallSdpAck> {
    const ack = vi.fn();
    await socket.trigger(
      CALL_EVENTS.PUBLISH_OFFER,
      { callId: 'demo', participantId, sdp: 'offer-sdp' },
      ack,
    );
    return ack.mock.calls[0]?.[0] as CallSdpAck;
  }

  it('answers a publish offer through the backend media peer registry with a participant-stable key', async () => {
    const ack = await publish(socketA, 'participant_1');

    expect(harness.mediaPeers.closeSession).toHaveBeenCalledWith(
      'callpeer_demo_participant_1',
      'superseded by a new call publish offer',
    );
    expect(harness.mediaPeers.acceptOffer).toHaveBeenCalledTimes(1);
    const call = harness.mediaPeers.acceptOffer.mock.calls[0];
    if (!call) throw new Error('acceptOffer was not called');
    const [socketId, offer, summary] = call;
    expect(socketId).toBe('socket-a');
    expect(offer).toMatchObject({
      type: 'sdp-offer',
      sessionId: 'callpeer_demo_participant_1',
      broadcastId: 'callcast_demo_participant_1_r2',
      peerId: 'peer_call_participant_1',
      senderRole: 'broadcaster',
      revision: 1, // publish negotiation serial, NOT the media revision
      payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'offer-sdp' },
    });
    expect(summary).toMatchObject({ sessionId: 'callpeer_demo_participant_1', revision: 1 });
    expect(ack).toEqual({ ok: true, sdp: 'answer-sdp' });
  });

  it('rejects publish signalling for an identity the socket did not join with', async () => {
    const result = await publish(socketA, 'participant_2');
    expect(harness.mediaPeers.acceptOffer).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('You are not part of this call.');
  });

  it('forwards publish ICE candidates at the current publish serial', async () => {
    await publish(socketA, 'participant_1');
    await socketA.trigger(CALL_EVENTS.PUBLISH_ICE, {
      callId: 'demo',
      participantId: 'participant_1',
      candidate: {
        candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    expect(harness.mediaPeers.addRemoteCandidate).toHaveBeenCalledTimes(1);
    expect(harness.mediaPeers.addRemoteCandidate.mock.calls[0]?.[0]).toMatchObject({
      type: 'ice-candidate',
      sessionId: 'callpeer_demo_participant_1',
      revision: 1,
      payload: {
        targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
  });

  it('relays backend publish ICE to the speaking participant room as call:publish:ice', async () => {
    await publish(socketA, 'participant_1');
    harness.mediaHandlers().onLocalSignal({
      type: 'ice-candidate',
      protocolVersion: 1,
      messageId: 'msg_backend_ice',
      broadcastId: 'callcast_demo_participant_1_r2',
      sessionId: 'callpeer_demo_participant_1',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      senderRole: 'server',
      revision: 1,
      createdAt: '2026-08-14T00:00:00.000Z',
      payload: {
        targetPeerId: 'peer_call_participant_1',
        candidate: 'candidate:9 1 udp 1 127.0.0.1 5001 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    });
    const emissions = roomEmissions(harness, CALL_EVENTS.PUBLISH_ICE);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.room).toBe('call:demo:participant:participant_1');
    expect(emissions[0]?.payload).toEqual({
      callId: 'demo',
      participantId: 'participant_1',
      candidate: {
        candidate: 'candidate:9 1 udp 1 127.0.0.1 5001 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    });
  });

  it('answers a receive offer via the per-call receive peer pipe', async () => {
    const ack = vi.fn();
    await socketB.trigger(
      CALL_EVENTS.RECEIVE_OFFER,
      { callId: 'demo', participantId: 'participant_2', sdp: 'receive-offer-sdp' },
      ack,
    );
    expect(harness.receivePeers.acceptOffer).toHaveBeenCalledWith(
      'demo',
      'participant_2',
      'receive-offer-sdp',
    );
    expect(ack).toHaveBeenCalledWith({ ok: true, sdp: 'receive-answer-sdp' });

    harness.receiveHandlers().onLocalIceCandidate('demo', 'participant_2', {
      candidate: 'candidate:5 1 udp 1 127.0.0.1 5002 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    const emissions = roomEmissions(harness, CALL_EVENTS.RECEIVE_ICE);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.room).toBe('call:demo:participant:participant_2');
  });

  it('feeds publisher audio frames into the current-revision bridge context and the raw-audio pipe', async () => {
    await publish(socketA, 'participant_1');
    const data = { samples: new Int16Array(160), sampleRate: 16000, channelCount: 1 };
    harness.mediaHandlers().onAudioFrame(
      {
        sessionId: 'callpeer_demo_participant_1',
        broadcastId: 'callcast_demo_participant_1_r2',
        broadcasterPeerId: 'peer_call_participant_1',
        revision: 1,
      },
      data,
    );
    expect(harness.transcriptionBridge.handleFrame).toHaveBeenCalledTimes(1);
    expect(harness.transcriptionBridge.handleFrame.mock.calls[0]?.[0]).toEqual({
      sessionId: 'call_demo_participant_1_r2',
      broadcastId: 'callcast_demo_participant_1_r2',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 2,
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguages: ['es'],
      targetLanguage: 'es',
      voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
      generatedAudioPacing: 'natural',
    });
    expect(harness.receivePeers.fanOut).toHaveBeenCalledWith('demo', 'participant_1', data);
  });

  it('routes frames from a long-lived publish peer into the NEW-revision bridge context after the other participant resumes', async () => {
    // Beto publishes; his backend peer is keyed participant-stable.
    await publish(socketB, 'participant_2');
    harness.mediaPeers.acceptOffer.mockClear();
    harness.transcriptionBridge.handleFrame.mockClear();

    // Ana resumes: ALL connected revisions bump (Ana r3, Beto r2) and the
    // ingest ids rekey; Beto's old r1 session is stopped by its OLD id.
    const resumeAck = await join(harness, new FakeSocket('socket-a2'), {
      ...JOIN_A,
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    expect(resumeAck.ok).toBe(true);
    expect(harness.transcriptionBridge.endSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_2_r1', revision: 1 }),
      'superseded by membership change',
    );
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_2_r1');

    // A frame from Beto's EXISTING peer, with no new publish signalling,
    // resolves the participant's CURRENT ingest context at frame time.
    const data = { samples: new Int16Array(160), sampleRate: 16000, channelCount: 1 };
    harness.mediaHandlers().onAudioFrame(
      {
        sessionId: 'callpeer_demo_participant_2',
        broadcastId: 'callcast_demo_participant_2_r1',
        broadcasterPeerId: 'peer_call_participant_2',
        revision: 1,
      },
      data,
    );
    expect(harness.mediaPeers.acceptOffer).not.toHaveBeenCalled();
    expect(harness.transcriptionBridge.handleFrame).toHaveBeenCalledTimes(1);
    expect(harness.transcriptionBridge.handleFrame.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'call_demo_participant_2_r2',
      broadcastId: 'callcast_demo_participant_2_r2',
      revision: 2,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
    });
    expect(harness.receivePeers.fanOut).toHaveBeenCalledWith('demo', 'participant_2', data);
  });

  it('ignores audio frames for unknown publish peers', () => {
    harness.mediaHandlers().onAudioFrame(
      {
        sessionId: 'callpeer_other_participant_7',
        broadcastId: 'callcast_other_participant_7_r1',
        broadcasterPeerId: 'peer_call_participant_7',
        revision: 1,
      },
      { samples: new Int16Array(160) },
    );
    expect(harness.transcriptionBridge.handleFrame).not.toHaveBeenCalled();
    expect(harness.receivePeers.fanOut).not.toHaveBeenCalled();
  });

  it('exposes the participant-stable publish peer key helper', () => {
    expect(callPublishPeerKey('demo', 'participant_1')).toBe('callpeer_demo_participant_1');
  });
});

describe('CallRuntime lifecycle: disconnect, reaper, leave, resume', () => {
  let harness: Harness;
  let socketA: FakeSocket;
  let socketB: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    socketB = new FakeSocket('socket-b');
    await join(harness, socketA, { ...JOIN_A });
    await join(harness, socketB, { ...JOIN_B });
    harness.emitToRoom.mockClear();
  });

  it('stops the participant ingest session, marks them disconnected, and arms the reaper on socket disconnect', () => {
    harness.runtime.handleSocketDisconnect('socket-a');

    expect(harness.mediaPeers.closeSession).toHaveBeenCalledWith(
      'callpeer_demo_participant_1',
      'participant socket disconnected',
    );
    expect(harness.transcriptionBridge.endSession).toHaveBeenCalledTimes(1);
    expect(harness.transcriptionBridge.endSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'call_demo_participant_1_r2',
      revision: 2,
    });
    expect(harness.ingestControl.stopSession).toHaveBeenCalledTimes(1);
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.transcriptionBridge.cleanupClosedSessions).toHaveBeenCalled();
    expect(harness.receivePeers.closePeer).toHaveBeenCalledWith(
      'demo',
      'participant_1',
      'participant socket disconnected',
    );

    const stateEmissions = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(stateEmissions).toHaveLength(1);
    expect(stateEmissions[0]?.payload).toMatchObject({
      state: 'reconnecting',
      participants: [
        { participantId: 'participant_1', joined: false },
        { participantId: 'participant_2', joined: true },
      ],
    });
    // The other participant's pipeline keeps running.
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalledWith('call_demo_participant_2_r1');

    // The disconnect grace reaper is armed with the configured window.
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(GRACE_MS);
    expect(harness.timers[0]?.cleared).toBe(false);
  });

  it('auto-leaves a seat when the disconnect grace expires without a resume', () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    harness.emitToRoom.mockClear();

    firePendingTimers(harness);

    // The seat is gone: the store no longer knows participant_1 and the call
    // continues for Beto in the waiting state.
    expect(harness.store.snapshot('demo')?.participants.map((p) => p.participantId)).toEqual([
      'participant_2',
    ]);
    const stateEmissions = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(stateEmissions).toHaveLength(1);
    expect(stateEmissions[0]?.payload).toMatchObject({
      state: 'waiting',
      participants: [{ participantId: 'participant_2', joined: true }],
    });
    const diagnostics = harness.runtime.getDiagnostics();
    expect(diagnostics.participantCount).toBe(1);
    expect(diagnostics.ingestSessionCount).toBe(1);
    expect(diagnostics.activeCallCount).toBe(1);
  });

  it('returns every count to baseline when both seats reap', async () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    harness.runtime.handleSocketDisconnect('socket-b');

    firePendingTimers(harness);

    expect(harness.receivePeers.closeCall).toHaveBeenCalledWith('demo', 'call ended');
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    // N1: the final teardown deletes both retired sessions from media-ingest.
    await flushAsync();
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    expect(harness.runtime.getDiagnostics()).toEqual({
      activeCallCount: 0,
      participantCount: 0,
      ingestSessionCount: 0,
      socketBindingCount: 0,
      publishPeerBindingCount: 0,
      receivePeerCount: 0,
      publishPeerCount: 0,
    });
  });

  it('cancels the reaper on a successful resume and the stale timer is inert', async () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    const reapTimer = harness.timers[0];
    if (!reapTimer) throw new Error('reap timer was not scheduled');

    const ack = await join(harness, new FakeSocket('socket-a2'), {
      ...JOIN_A,
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    expect(ack.ok).toBe(true);
    expect(reapTimer.cleared).toBe(true);

    // Defense in depth: even if the timer fired anyway, a connected seat is
    // never reaped.
    reapTimer.callback();
    expect(harness.runtime.getDiagnostics().participantCount).toBe(2);
    expect(
      harness.store
        .snapshot('demo')
        ?.participants.find((participant) => participant.participantId === 'participant_1')
        ?.connected,
    ).toBe(true);
  });

  it('tears everything down and returns all counts to baseline when the last participant leaves', async () => {
    const ackA = vi.fn();
    await socketA.trigger(
      CALL_EVENTS.LEAVE,
      { callId: 'demo', participantId: 'participant_1' },
      ackA,
    );
    expect(ackA).toHaveBeenCalledWith({ ok: true });
    // Call continues for Beto with an updated state.
    expect(roomEmissions(harness, CALL_EVENTS.STATE)).toHaveLength(1);

    const ackB = vi.fn();
    await socketB.trigger(
      CALL_EVENTS.LEAVE,
      { callId: 'demo', participantId: 'participant_2' },
      ackB,
    );
    expect(ackB).toHaveBeenCalledWith({ ok: true });
    expect(harness.receivePeers.closeCall).toHaveBeenCalledWith('demo', 'call ended');
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    // N1: leaving deletes both retired sessions from media-ingest, and only
    // ever with call_ ids.
    await flushAsync();
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    for (const [deletedId] of harness.ingestControl.deleteSession.mock.calls) {
      expect(deletedId.startsWith('call_')).toBe(true);
    }

    expect(harness.runtime.getDiagnostics()).toEqual({
      activeCallCount: 0,
      participantCount: 0,
      ingestSessionCount: 0,
      socketBindingCount: 0,
      publishPeerBindingCount: 0,
      receivePeerCount: 0,
      publishPeerCount: 0,
    });
  });

  it('retires the old revisions and recreates ingest sessions at the bumped revisions on resume after disconnect', async () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    harness.ingestControl.createSession.mockClear();
    harness.ingestControl.stopSession.mockClear();
    harness.ingestControl.deleteSession.mockClear();

    const resumedSocket = new FakeSocket('socket-a2');
    const ack = await join(harness, resumedSocket, {
      ...JOIN_A,
      voiceGender: 'female',
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.participantId).toBe('participant_1');
    expect(ack.resumeToken).toBe('resume-token-1');

    // Resume bumps ALL connected participants: Ana r3, Beto r2. Ana's r2 was
    // already stopped at disconnect; Beto's still-running r1 is stopped by its
    // OLD id before his r2 session is created.
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(2);
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'call_demo_participant_1_r3',
        revision: 3,
        sourceLanguage: 'en',
        targetLanguages: ['es'],
        voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
      }),
    );
    // Ana's NEW voice choice reaches Beto's recreated session immediately,
    // because his revision bumped too.
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'call_demo_participant_2_r2',
        revision: 2,
        voiceIdsByLanguage: { en: 'en_US-hfc_female-medium' },
      }),
    );

    // Stale registry entries are gone; exactly the two current ones remain,
    // and both retired sessions are deleted from media-ingest by their OLD
    // ids (N1) — Ana's r2 (created pre-disconnect) and Beto's r1.
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBe(2);
    await flushAsync();
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    expect(harness.ingestControl.deleteSession).not.toHaveBeenCalledWith('call_demo_participant_1_r3');
    expect(harness.ingestControl.deleteSession).not.toHaveBeenCalledWith('call_demo_participant_2_r2');
  });

  it('stops the still-active old revision before recreating when resume happens without a disconnect', async () => {
    harness.ingestControl.createSession.mockClear();
    const resumedSocket = new FakeSocket('socket-a2');
    const ack = await join(harness, resumedSocket, {
      ...JOIN_A,
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    expect(ack.ok).toBe(true);

    // The still-active r2 session is flushed, stopped, then deleted by its OLD id.
    expect(harness.transcriptionBridge.endSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_1_r2', revision: 2 }),
      'superseded by membership change',
    );
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    await flushAsync();
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_1_r3', revision: 3 }),
    );

    // The replaced socket's later disconnect must not tear the participant down.
    harness.ingestControl.stopSession.mockClear();
    harness.runtime.handleSocketDisconnect('socket-a');
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalled();
    expect(
      harness.store
        .snapshot('demo')
        ?.participants.find((participant) => participant.participantId === 'participant_1')
        ?.connected,
    ).toBe(true);
  });

  it('never leaks resume tokens through room emissions', async () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    await join(harness, new FakeSocket('socket-a2'), {
      ...JOIN_A,
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    for (const call of harness.emitToRoom.mock.calls) {
      expect(JSON.stringify(call[2])).not.toContain('resume-token');
    }
  });
});

describe('CallRuntime measured delivery latency and call summary', () => {
  const SPEAKER_SESSION = 'call_demo_participant_1_r2';
  let harness: Harness;

  /**
   * Three utterances on the speaker's chunk timeline. `capturedAtMs` is the
   * wall clock at which each segment's last audio sample reached the gateway;
   * media-ingest accepted each chunk 40 ms later.
   */
  const CHUNKS = [
    { sequence: 0, startMs: 0, endMs: 1_200, capturedAtMs: 100_000, submittedAtMs: 100_040 },
    { sequence: 1, startMs: 2_000, endMs: 3_200, capturedAtMs: 102_000, submittedAtMs: 102_040 },
    { sequence: 2, startMs: 4_000, endMs: 5_200, capturedAtMs: 104_000, submittedAtMs: 104_040 },
  ];

  beforeEach(async () => {
    harness = createHarness();
    await join(harness, new FakeSocket('socket-a'), { ...JOIN_A });
    await join(harness, new FakeSocket('socket-b'), { ...JOIN_B });
    harness.setChunkTimings(SPEAKER_SESSION, 2, CHUNKS);
  });

  it('stamps caption deliveries with the measured end-of-segment to delivery latency', () => {
    harness.setClock(102_500);
    harness.runtime.interceptTimestampedTranslationEvent(
      translationEvent({ sequence: 1, startMs: 0, endMs: 1_200 }),
    );

    const [caption] = harness.records('caption');
    expect(caption).toMatchObject({
      deliveredTo: 1,
      segmentEndMs: 1_200,
      // 102_500 delivered − 100_000 segment captured.
      deliveryLatencyMs: 2_500,
      // 102_500 delivered − 100_040 accepted by media-ingest.
      sinceChunkSubmittedMs: 2_460,
    });
  });

  it('stamps generated audio with the SOURCE segment end, not the generated clip length', () => {
    harness.setClock(107_000);
    harness.runtime.interceptGeneratedAudioEvent(
      // Natural pacing: the clip is 900 ms long but covers a 1_200 ms segment.
      generatedAudioEvent({ sequence: 1, startMs: 4_000, endMs: 5_200, durationMs: 900 }),
    );

    const [audio] = harness.records('generated-audio');
    expect(audio).toMatchObject({
      deliveredTo: 1,
      durationMs: 900,
      segmentEndMs: 5_200,
      deliveryLatencyMs: 3_000,
      sinceChunkSubmittedMs: 2_960,
    });
  });

  it('reports latency as unknown rather than guessing when the chunk timing is gone', async () => {
    // A harness with no registered chunk timings: the bridge no longer knows
    // when this audio was captured, so no number is invented.
    const bare = createHarness();
    await join(bare, new FakeSocket('socket-a'), { ...JOIN_A });
    await join(bare, new FakeSocket('socket-b'), { ...JOIN_B });
    bare.runtime.interceptTimestampedTranslationEvent(translationEvent({}));

    const [caption] = bare.records('caption');
    expect(caption).toMatchObject({
      deliveredTo: 1,
      deliveryLatencyMs: null,
      sinceChunkSubmittedMs: null,
    });
  });

  it('advances latency monotonically with the clock across successive deliveries', () => {
    const latencies: unknown[] = [];
    for (const [index, chunk] of CHUNKS.entries()) {
      harness.setClock(chunk.capturedAtMs + 1_000 * (index + 1));
      harness.runtime.interceptTimestampedTranslationEvent(
        translationEvent({ sequence: index + 1, startMs: chunk.startMs, endMs: chunk.endMs }),
      );
      latencies.push(harness.records('caption').at(-1)?.deliveryLatencyMs);
    }
    expect(latencies).toEqual([1_000, 2_000, 3_000]);
  });

  it('writes a call-summary with delivery counts, drops, and latency percentiles on teardown', async () => {
    // Three delivered captions at 1 s / 2 s / 3 s, one delivered clip at 4 s.
    for (const [index, chunk] of CHUNKS.entries()) {
      harness.setClock(chunk.capturedAtMs + 1_000 * (index + 1));
      harness.runtime.interceptTimestampedTranslationEvent(
        translationEvent({ sequence: index + 1, startMs: chunk.startMs, endMs: chunk.endMs }),
      );
    }
    harness.setClock(108_000);
    harness.runtime.interceptGeneratedAudioEvent(
      generatedAudioEvent({ sequence: 3, startMs: 4_000, endMs: 5_200 }),
    );

    // An ingest fault and per-speaker backpressure counters to report.
    harness.runtime.interceptMediaStateEvent({
      eventId: 'evt',
      processingSessionId: SPEAKER_SESSION,
      streamStatus: 'failed',
      videoSource: 'webrtc',
      videoTimestampMs: 0,
      sourceAudioActive: true,
      translatedLanguages: ['es'],
      connectedListeners: 0,
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    harness.setSessionCounters(SPEAKER_SESSION, 2, {
      evictedChunkCount: 2,
      skippedFrameCount: 1,
      submissionFailureCount: 1,
    });
    harness.setSessionCounters('call_demo_participant_2_r1', 1, {
      evictedChunkCount: 0,
      skippedFrameCount: 3,
      submissionFailureCount: 0,
    });

    harness.setClock(120_000);
    harness.runtime.handleSocketDisconnect('socket-a');
    harness.runtime.handleSocketDisconnect('socket-b');
    firePendingTimers(harness);
    await flushAsync();

    const summaries = harness.records('call-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      callId: 'demo',
      durationMs: 20_000,
      participantCount: 2,
      captionsDelivered: 3,
      captionsDeliveredByRecipient: { participant_2: 3 },
      captionEvents: 3,
      generatedAudioDelivered: 1,
      generatedAudioDeliveredByRecipient: { participant_2: 1 },
      generatedAudioEvents: 1,
      droppedChunksEvicted: 2,
      droppedFramesSkipped: 4,
      chunkSubmissionFailures: 1,
      ingestFaults: 1,
      latencyField: 'deliveryLatencyMs',
      latencySampleCount: 4,
      latencySamplesKept: 4,
      // Nearest rank over [1000, 2000, 3000, 4000].
      latencyMedianMs: 2_000,
      latencyP90Ms: 4_000,
    });
    expect(String(summaries[0]?.latencyDefinition)).toContain('end of the captured speech segment');
  });

  it('counts an undelivered event but never times it', async () => {
    harness.runtime.handleSocketDisconnect('socket-b');
    harness.setClock(103_000);
    harness.runtime.interceptTimestampedTranslationEvent(
      translationEvent({ sequence: 1, startMs: 0, endMs: 1_200 }),
    );
    const [caption] = harness.records('caption');
    expect(caption).toMatchObject({ deliveredTo: 0 });

    harness.runtime.handleSocketDisconnect('socket-a');
    firePendingTimers(harness);
    await flushAsync();

    expect(harness.records('call-summary')[0]).toMatchObject({
      captionEvents: 1,
      captionsDelivered: 0,
      captionsDeliveredByRecipient: {},
      latencySampleCount: 0,
      latencyMedianMs: null,
      latencyP90Ms: null,
    });
  });
});

describe('CallRuntime async handler guard', () => {
  let harness: Harness;
  let socketA: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    await join(harness, socketA, { ...JOIN_A });
    await join(harness, new FakeSocket('socket-b'), { ...JOIN_B });
  });

  it('acks the internal-error shape when an ack-carrying handler throws unexpectedly', async () => {
    harness.mediaPeers.closeSession.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const ack = vi.fn();
    await socketA.trigger(
      CALL_EVENTS.PUBLISH_OFFER,
      { callId: 'demo', participantId: 'participant_1', sdp: 'offer-sdp' },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'internal', message: 'Something went wrong; please rejoin.' },
    });
  });

  it('emits call:error when an ack-less handler rejects unexpectedly', async () => {
    harness.receivePeers.addRemoteCandidate.mockRejectedValueOnce(new Error('boom'));
    await socketA.trigger(CALL_EVENTS.RECEIVE_ICE, {
      callId: 'demo',
      participantId: 'participant_1',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host' },
    });
    expect(socketA.emitted).toContainEqual({
      event: CALL_EVENTS.ERROR,
      payload: { code: 'internal', message: 'Something went wrong; please rejoin.' },
    });
  });
});

describe('HttpWebRtcTranscriptionSubmissionClient call session creation', () => {
  it('posts voiceIdsByLanguage to the media-ingest internal sessions endpoint', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> });
        response.statusCode = 200;
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new HttpWebRtcTranscriptionSubmissionClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    try {
      await client.createSession({
        sessionId: 'call_demo_participant_1_r1',
        broadcastId: 'callcast_demo_participant_1_r1',
        broadcasterPeerId: 'peer_call_participant_1',
        revision: 1,
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        targetLanguages: ['es'],
        targetLanguage: 'es',
        voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/internal/webrtc/sessions');
    expect(requests[0]?.body).toMatchObject({
      sessionId: 'call_demo_participant_1_r1',
      broadcastId: 'callcast_demo_participant_1_r1',
      revision: 1,
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguages: ['es'],
      voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
    });
  });

  it('issues DELETE for retired call sessions and tolerates an already-gone 404', async () => {
    const requests: { method: string; url: string }[] = [];
    const server = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        requests.push({ method: request.method ?? '', url: request.url ?? '' });
        // First delete: session exists. Second delete: already gone.
        response.statusCode = requests.length === 1 ? 200 : 404;
        response.end(requests.length === 1 ? '{"removed":true}' : '{"removed":false}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new HttpWebRtcTranscriptionSubmissionClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    try {
      await client.deleteSession('call_demo_participant_1_r2');
      // 404 ({removed:false}) is a defined outcome and must not reject.
      await expect(client.deleteSession('call_demo_participant_1_r2')).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('DELETE');
      expect(request.url).toBe('/internal/webrtc/sessions/call_demo_participant_1_r2');
    }
  });
});

describe('CallRuntime caption language changes', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('moves only the requesting reader onto the new caption language', async () => {
    const socketA = new FakeSocket('socket-a');
    const socketB = new FakeSocket('socket-b');
    const ackA = await join(harness, socketA, { ...JOIN_A });
    await join(harness, socketB, { ...JOIN_B });
    if (!ackA.ok) throw new Error('join A failed');

    const ack = vi.fn();
    await socketA.trigger(CALL_EVENTS.SET_CAPTION_LANGUAGE, {
      callId: 'demo',
      participantId: ackA.participantId,
      hearLanguage: 'fr',
    }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    const states = roomEmissions(harness, CALL_EVENTS.STATE);
    const latest = states.at(-1)?.payload as { participants: { participantId: string; hearLanguage: string }[] };
    expect(latest.participants.find((p) => p.participantId === ackA.participantId)?.hearLanguage).toBe('fr');
    // Beto asked for nothing and must not have been re-languaged.
    expect(latest.participants.find((p) => p.participantId !== ackA.participantId)?.hearLanguage).toBe('es');
  });

  it('refuses a participant trying to re-language somebody else', async () => {
    const socketA = new FakeSocket('socket-a');
    const socketB = new FakeSocket('socket-b');
    const ackA = await join(harness, socketA, { ...JOIN_A });
    await join(harness, socketB, { ...JOIN_B });
    if (!ackA.ok) throw new Error('join A failed');

    const ack = vi.fn();
    // Beto's socket, Ana's participantId: the binding check is the whole defence.
    await socketB.trigger(CALL_EVENTS.SET_CAPTION_LANGUAGE, {
      callId: 'demo',
      participantId: ackA.participantId,
      hearLanguage: 'fr',
    }, ack);

    expect(ack.mock.calls[0]?.[0]).toEqual({ ok: false, error: expect.any(String) });
    const state = harness.store.snapshot('demo');
    expect(state?.participants.find((p) => p.participantId === ackA.participantId)?.hearLanguage).toBe('en');
  });

  it('rejects a language the call cannot produce, without changing anything', async () => {
    const socketA = new FakeSocket('socket-a');
    const ackA = await join(harness, socketA, { ...JOIN_A });
    if (!ackA.ok) throw new Error('join A failed');

    const ack = vi.fn();
    await socketA.trigger(CALL_EVENTS.SET_CAPTION_LANGUAGE, {
      callId: 'demo',
      participantId: ackA.participantId,
      hearLanguage: 'kl',
    }, ack);

    expect((ack.mock.calls[0]?.[0] as { ok: boolean }).ok).toBe(false);
    expect(harness.store.snapshot('demo')?.participants[0]?.hearLanguage).toBe('en');
  });
});
