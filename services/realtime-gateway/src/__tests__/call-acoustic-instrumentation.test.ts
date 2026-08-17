/** @owner masterzee001 */
/**
 * W1 / W3 / W4 / W5A wired into the call runtime.
 *
 * These are INSTRUMENTATION. The point of the wave is that measurement lands
 * before suppression, so the assertion that matters most here is the negative
 * one: with all of it running, the audio path is byte-for-byte what it was, no
 * room id exists, and nothing consults the observer's output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSessionStore } from '@videofy-live/call-session';
import type {
  GeneratedAudioReadyEvent,
  WebRtcIceCandidateEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { WEBRTC_BACKEND_MEDIA_PEER_ID } from '@videofy-live/shared-types';
import {
  CALL_EVENTS,
  CallRuntime,
  type CallJoinAck,
  type CallMediaPeerHandlers,
  type CallSocketLike,
} from '../call-runtime.js';
import type { CallReceivePeerHandlers } from '../call-receive-peers.js';
import { CallAcousticRoomObserver } from '../call-acoustic-rooms.js';
import { CallTranscriptLog, type CallTranscriptRecord } from '../call-transcript-log.js';
import type { WebRtcAudioDataLike } from '../webrtc-audio-ingest-bridge.js';
import type { WebRtcTranscriptionBridgeContext } from '../webrtc-transcription-bridge.js';

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

class RecordingTranscriptLog extends CallTranscriptLog {
  readonly records: CallTranscriptRecord[] = [];
  constructor() {
    super(null);
  }
  override append(record: CallTranscriptRecord): void {
    this.records.push(record);
  }
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

function createHarness(acousticObserver?: CallAcousticRoomObserver) {
  let tokenSerial = 0;
  const store = new CallSessionStore({
    now: () => '2026-08-17T00:00:00.000Z',
    createResumeToken: () => `resume-token-${++tokenSerial}`,
  });
  const transcriptionBridge = {
    handleFrame: vi.fn(
      (
        _context: WebRtcTranscriptionBridgeContext,
        _data: WebRtcAudioDataLike,
        _receivedAtMs?: number,
      ) => {},
    ),
    endSession: vi.fn(() => {}),
    cleanupClosedSessions: vi.fn(() => 0),
  };
  const receivePeers = {
    acceptOffer: vi.fn(async () => 'receive-answer-sdp'),
    addRemoteCandidate: vi.fn(async () => {}),
    fanOut: vi.fn((_callId: string, _speakerId: string, _data: WebRtcAudioDataLike) => {}),
    closePeer: vi.fn(() => {}),
    closeCall: vi.fn(() => {}),
    count: vi.fn(() => 0),
  };
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
        createdAt: '2026-08-17T00:00:00.000Z',
        payload: { targetPeerId: offer.peerId, sdp: 'answer-sdp' },
      }),
    ),
    addRemoteCandidate: vi.fn(async (_envelope: WebRtcIceCandidateEnvelope) => {}),
    closeSession: vi.fn(() => {}),
    getSnapshots: vi.fn(() => [] as unknown[]),
  };
  const transcriptLog = new RecordingTranscriptLog();
  let clockMs = 200_000;
  let mediaHandlers: CallMediaPeerHandlers | null = null;
  const runtime = new CallRuntime({
    store,
    emitToRoom: vi.fn(),
    ingestControl: {
      createSession: vi.fn(async () => {}),
      stopSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    },
    transcriptionBridge,
    createMediaPeers: (handlers) => {
      mediaHandlers = handlers;
      return mediaPeers;
    },
    createReceivePeers: (_handlers: CallReceivePeerHandlers) => receivePeers,
    transcriptLog,
    now: () => clockMs,
    ...(acousticObserver ? { acousticObserver } : {}),
  });
  return {
    runtime,
    transcriptionBridge,
    receivePeers,
    transcriptLog,
    records: (kind: CallTranscriptRecord['kind']) =>
      transcriptLog.records.filter((record) => record.kind === kind),
    setClock: (next: number) => {
      clockMs = next;
    },
    mediaHandlers: () => {
      if (!mediaHandlers) throw new Error('media peer handlers were not captured');
      return mediaHandlers;
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
  return ack.mock.calls[0]?.[0] as CallJoinAck;
}

async function publish(harness: Harness, socket: FakeSocket, participantId: string): Promise<void> {
  await socket.trigger(
    CALL_EVENTS.PUBLISH_OFFER,
    { callId: 'demo', participantId, sdp: 'offer-sdp' },
    vi.fn(),
  );
}

const AUDIO_CONTEXT = {
  sessionId: 'callpeer_demo_participant_1',
  broadcastId: 'callcast_demo_participant_1_r2',
  broadcasterPeerId: 'peer_call_participant_1',
  revision: 1,
};

function frameMetadata(receivedAtMs: number) {
  return { receivedAtMs, sampleRate: 48_000, channelCount: 1 };
}

describe('W1 — capture settings provenance', () => {
  let harness: Harness;
  let socketA: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    await join(harness, socketA, JOIN_A);
  });

  it('records what the browser granted, including the value of echoCancellation', async () => {
    await socketA.trigger(CALL_EVENTS.CAPTURE_SETTINGS, {
      callId: 'demo',
      participantId: 'participant_1',
      reason: 'join',
      requestedCaptureProfile: 'explicit-all',
      settings: {
        deviceLabel: 'Microphone Array (Intel Smart Sound)',
        echoCancellation: 'all',
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48_000,
      },
    });

    const [record] = harness.records('capture-settings');
    expect(record).toMatchObject({
      callId: 'demo',
      participantId: 'participant_1',
      reason: 'join',
      requestedCaptureProfile: 'explicit-all',
    });
    // The measurement that removed echo-cancellation tuning from the candidate
    // list had to be taken by hand last time. Now every call carries it.
    expect((record as unknown as { settings: Record<string, unknown> }).settings).toMatchObject({
      echoCancellation: 'all',
    });
  });

  it('keeps asked-for and granted apart, because asking is not complying', async () => {
    // The control profile asks for nothing and Chrome grants its defaults; the
    // modern profile asks for 'all' and may be refused. Either way the corpus
    // needs BOTH halves — the request to attribute the run, the grant to know
    // what actually happened.
    await socketA.trigger(CALL_EVENTS.CAPTURE_SETTINGS, {
      callId: 'demo',
      participantId: 'participant_1',
      reason: 'join',
      requestedCaptureProfile: 'explicit-all',
      settings: { echoCancellation: true },
    });

    const [record] = harness.records('capture-settings');
    expect(record).toMatchObject({ requestedCaptureProfile: 'explicit-all' });
    // Asked for 'all', got plain `true`. That is a real and reportable outcome,
    // not a reason to rewrite either field.
    expect((record as unknown as { settings: Record<string, unknown> }).settings).toMatchObject({
      echoCancellation: true,
    });
  });

  it('records an unrecognised profile name rather than normalising it away', async () => {
    // An unexpected profile is a provenance question. Rewriting it to a known
    // value would destroy the evidence that a run was collected under something
    // nobody planned.
    await socketA.trigger(CALL_EVENTS.CAPTURE_SETTINGS, {
      callId: 'demo',
      participantId: 'participant_1',
      reason: 'join',
      requestedCaptureProfile: 'something-nobody-defined',
      settings: { echoCancellation: true },
    });

    expect(harness.records('capture-settings')[0]).toMatchObject({
      requestedCaptureProfile: 'something-nobody-defined',
    });
  });

  it('re-records on a device change, so an unplugged headset does not leave a stale claim', async () => {
    for (const reason of ['join', 'device-change']) {
      await socketA.trigger(CALL_EVENTS.CAPTURE_SETTINGS, {
        callId: 'demo',
        participantId: 'participant_1',
        reason,
        settings: { echoCancellation: reason === 'join' ? 'all' : true },
      });
    }

    expect(harness.records('capture-settings').map((record) => record['reason'])).toEqual([
      'join',
      'device-change',
    ]);
  });

  it('refuses a report that names a different participant', async () => {
    // A capture-settings record is provenance for a specific microphone. A
    // socket that could file one against somebody else's identity would corrupt
    // exactly the fact this exists to establish.
    await socketA.trigger(CALL_EVENTS.CAPTURE_SETTINGS, {
      callId: 'demo',
      participantId: 'participant_2',
      reason: 'join',
      settings: { echoCancellation: false },
    });

    expect(harness.records('capture-settings')).toHaveLength(0);
  });
});

describe('W3 — input sample rate provenance', () => {
  it('stamps the true input rate once per participant', async () => {
    const harness = createHarness();
    const socketA = new FakeSocket('socket-a');
    await join(harness, socketA, JOIN_A);
    await publish(harness, socketA, 'participant_1');

    const data = { samples: new Int16Array(480), sampleRate: 48_000, channelCount: 1 };
    harness.mediaHandlers().onAudioFrame(AUDIO_CONTEXT, data, frameMetadata(200_010));
    harness.mediaHandlers().onAudioFrame(AUDIO_CONTEXT, data, frameMetadata(200_020));

    const records = harness.records('input-format');
    // Once, not per frame: it does not change mid-track, and a per-frame record
    // would bury the log in the one fact it is meant to make findable.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      participantId: 'participant_1',
      inputSampleRate: 48_000,
      inputChannelCount: 1,
    });
  });
});

describe('W4 — dual-path playback ledger', () => {
  let harness: Harness;
  let socketA: FakeSocket;
  let socketB: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    socketA = new FakeSocket('socket-a');
    socketB = new FakeSocket('socket-b');
    await join(harness, socketA, JOIN_A);
    await join(harness, socketB, JOIN_B);
  });

  function generatedAudio(sequence: number): GeneratedAudioReadyEvent {
    return {
      sessionId: 'call_demo_participant_1_r2',
      streamId: 'callcast_demo_participant_1_r2',
      chunkId: `chunk-${sequence}`,
      sequence,
      targetLanguage: 'es',
      voiceId: 'es_ES-sharvard-female',
      audioUrl: 'http://localhost:3002/generated/clip.wav',
      startMs: 0,
      endMs: 1_000,
      durationMs: 900,
      provider: 'piper',
      createdAtMs: 200_000,
    } as unknown as GeneratedAudioReadyEvent;
  }

  it('registers a clip against its recipient and matches the client report to it', async () => {
    harness.runtime.interceptGeneratedAudioEvent(generatedAudio(1));
    harness.setClock(200_800);
    await socketB.trigger(CALL_EVENTS.PLAYBACK, {
      callId: 'demo',
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'participant_1:es:2:1:1',
      phase: 'start',
      atMs: 55_000,
    });

    const ledger = harness.runtime.getPlaybackLedger();
    expect(ledger.wasAudibleAt('demo', 'participant_2', 200_800)).toBe(true);
    expect(ledger.statsFor('demo')).toMatchObject({
      registeredClipCount: 1,
      startedClipCount: 1,
      unreportedClipCount: 0,
      unknownClipReportCount: 0,
    });
  });

  it('leaves a clip nobody confirmed playing visibly unconfirmed', () => {
    harness.runtime.interceptGeneratedAudioEvent(generatedAudio(2));

    const ledger = harness.runtime.getPlaybackLedger();
    expect(ledger.wasAudibleAt('demo', 'participant_2', 200_500)).toBe(false);
    expect(ledger.statsFor('demo').unreportedClipCount).toBe(1);
    expect(ledger.unreportedClips('demo')).toHaveLength(1);
  });

  it('records the raw remote fan-out, which has no clip and no duration', async () => {
    await socketA.trigger(CALL_EVENTS.PLAYBACK, {
      callId: 'demo',
      participantId: 'participant_1',
      stream: 'remote-original',
      phase: 'start',
      atMs: 1_000,
    });
    harness.setClock(206_000);

    // Path B is continuous: it is audible for as long as the other person keeps
    // talking, which is exactly why it can never be gated on a clip window.
    expect(harness.runtime.getPlaybackLedger().wasAudibleAt('demo', 'participant_1', 205_000)).toBe(
      true,
    );
    const [record] = harness.records('playback');
    expect(record).toMatchObject({ stream: 'remote-original', phase: 'start', clipId: null });
    // Client clock and gateway clock kept apart, so the skew is measurable.
    expect(record).toMatchObject({ clientAtMs: 1_000, gatewayAtMs: 200_000 });
  });

  it('refuses a playback report filed against another participant', async () => {
    // NG6 puts the aggregation server-side precisely because the consequence
    // lands on a DIFFERENT participant's microphone. A socket that could report
    // somebody else's loudspeaker would poison that.
    await socketA.trigger(CALL_EVENTS.PLAYBACK, {
      callId: 'demo',
      participantId: 'participant_2',
      stream: 'remote-original',
      phase: 'start',
      atMs: 1_000,
    });

    expect(harness.records('playback')).toHaveLength(0);
    expect(harness.runtime.getPlaybackLedger().audibleWindows('demo', 'participant_2')).toEqual([]);
  });
});

describe('the instrumentation changes no audio', () => {
  it('delivers byte-identical frames to the bridge and the fan-out, observer on or off', async () => {
    // Deterministic equivalence (verification method 2). It must fail if anyone
    // later moves real work — correlation, gating, allocation — onto the frame
    // path, which is the road by which "observation only" quietly stops being
    // true.
    const silent = new CallAcousticRoomObserver({ intervalMs: 1_000_000 });
    const observing = createHarness();
    const stubbed = createHarness(silent);
    silent.observeFrame = () => {};

    for (const harness of [observing, stubbed]) {
      const socket = new FakeSocket('socket-a');
      await join(harness, socket, JOIN_A);
      // Both seats: a lone participant has nobody to be translated for, so no
      // ingest session is active and no frame would reach the bridge at all.
      await join(harness, new FakeSocket('socket-b'), JOIN_B);
      await publish(harness, socket, 'participant_1');
      for (let index = 0; index < 40; index += 1) {
        const samples = new Int16Array(480);
        for (let sample = 0; sample < samples.length; sample += 1) {
          samples[sample] = ((index * 31 + sample * 7) % 2000) - 1000;
        }
        harness
          .mediaHandlers()
          .onAudioFrame(
            AUDIO_CONTEXT,
            { samples, sampleRate: 48_000, channelCount: 1 },
            frameMetadata(200_000 + index * 10),
          );
      }
    }

    const bridgeFrames = (harness: Harness) =>
      harness.transcriptionBridge.handleFrame.mock.calls.map((call) => call[1]);
    const fanOutFrames = (harness: Harness) =>
      harness.receivePeers.fanOut.mock.calls.map((call) => call[2]);

    expect(bridgeFrames(observing)).toHaveLength(40);
    expect(bridgeFrames(observing)).toEqual(bridgeFrames(stubbed));
    expect(fanOutFrames(observing)).toEqual(fanOutFrames(stubbed));
    // Same bridge context, same order, same count — nothing rerouted.
    expect(observing.transcriptionBridge.handleFrame.mock.calls.map((call) => call[0])).toEqual(
      stubbed.transcriptionBridge.handleFrame.mock.calls.map((call) => call[0]),
    );
  });

  it('delivers the frame even when the observer throws', async () => {
    // Found by auditing the diff, not by a failing test: the instrumentation
    // originally ran BEFORE the bridge and the fan-out, unguarded. Nothing in
    // it throws today, which is precisely why it was easy to miss that a throw
    // would have silently stopped audio. Order and guard are asserted here so
    // the guarantee survives whatever gets added to the observer later.
    const hostile = new CallAcousticRoomObserver({ intervalMs: 1_000_000 });
    hostile.observeFrame = () => {
      throw new Error('instrumentation exploded');
    };
    const harness = createHarness(hostile);
    const socket = new FakeSocket('socket-a');
    await join(harness, socket, JOIN_A);
    await join(harness, new FakeSocket('socket-b'), JOIN_B);
    await publish(harness, socket, 'participant_1');

    const data = { samples: new Int16Array(480), sampleRate: 48_000, channelCount: 1 };
    expect(() =>
      harness.mediaHandlers().onAudioFrame(AUDIO_CONTEXT, data, frameMetadata(200_010)),
    ).not.toThrow();

    expect(harness.transcriptionBridge.handleFrame).toHaveBeenCalledTimes(1);
    expect(harness.receivePeers.fanOut).toHaveBeenCalledTimes(1);
  });

  it('produces no room id and nothing that could bind a participant', async () => {
    const harness = createHarness();
    const socketA = new FakeSocket('socket-a');
    await join(harness, socketA, JOIN_A);
    await publish(harness, socketA, 'participant_1');
    harness
      .mediaHandlers()
      .onAudioFrame(
        AUDIO_CONTEXT,
        { samples: new Int16Array(480), sampleRate: 48_000, channelCount: 1 },
        frameMetadata(200_010),
      );

    // Every record this wave can write, checked for the one field it must never
    // acquire. W5B is where a roomId may first exist, and W5B is blocked on M1
    // and M5 having been done.
    expect(JSON.stringify(harness.transcriptLog.records)).not.toMatch(/roomId/i);
    expect(harness.records('acoustic-observation')).toHaveLength(0);
  });
});
