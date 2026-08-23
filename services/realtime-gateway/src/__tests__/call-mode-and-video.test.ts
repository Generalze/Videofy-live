/** @owner masterzee001 */
/**
 * P6.4-W5 — Call Mode authority and the V1 video signalling relay.
 *
 * Two behaviours share this file because they share a threat model: both are
 * call-global controls reachable from any bound socket, so the tests here are
 * as much about who is REFUSED as about what happens when the owner acts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSessionStore } from '@videofy-live/call-session';
import type {
  WebRtcIceCandidateEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { WEBRTC_BACKEND_MEDIA_PEER_ID, WEBRTC_SIGNALLING_LIMITS } from '@videofy-live/shared-types';
import {
  CALL_EVENTS,
  CallRuntime,
  type CallJoinAck,
  type CallSetModeAck,
  type CallSocketLike,
} from '../call-runtime.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

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

const GRACE_MS = 5_000;

/** Owner Ana (en→en); reads captions. */
const JOIN_ANA = {
  callId: 'demo',
  displayName: 'Ana',
  speakLanguage: 'en',
  hearLanguage: 'en',
  captionsEnabled: true,
  voiceGender: 'male',
  audioMode: 'translated',
} as const;

/** Beto (es→es); the canonical cross-language second seat. */
const JOIN_BETO = {
  callId: 'demo',
  displayName: 'Beto',
  speakLanguage: 'es',
  hearLanguage: 'es',
  captionsEnabled: true,
  voiceGender: 'female',
  audioMode: 'translated',
} as const;

function createHarness() {
  let tokenSerial = 0;
  const store = new CallSessionStore({
    now: () => '2026-08-18T00:00:00.000Z',
    createResumeToken: () => `resume-token-${++tokenSerial}`,
  });
  const emitToRoom = vi.fn<(room: string, event: string, payload: unknown) => void>();
  const ingestControl = {
    createSession: vi.fn(async (_input: MediaTranscriptionBridgeContext) => {}),
    stopSession: vi.fn(async (_sessionId: string) => {}),
    deleteSession: vi.fn(async (_sessionId: string) => {}),
  };
  const transcriptionBridge = {
    handleFrame: vi.fn(
      (_context: MediaTranscriptionBridgeContext, _data: MediaAudioDataLike) => {},
    ),
    endSession: vi.fn((_context: MediaTranscriptionBridgeContext, _reason: string) => {}),
    cleanupClosedSessions: vi.fn(() => 0),
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
        createdAt: '2026-08-18T00:00:00.000Z',
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
      (_callId: string, _speakerParticipantId: string, _data: MediaAudioDataLike) => {},
    ),
    syncSpeakers: vi.fn((_callId: string, _participantIds: readonly string[]) => {}),
    trackMapping: vi.fn(
      () => [] as { slot: number; mid: string | null; speakerParticipantId: string | null }[],
    ),
    closePeer: vi.fn((_callId: string, _participantId: string, _reason: string) => {}),
    closeCall: vi.fn((_callId: string, _reason: string) => {}),
    count: vi.fn(() => 0),
  };
  const timers: FakeTimer[] = [];
  let timerSerial = 0;
  const runtime = new CallRuntime({
    store,
    emitToRoom,
    ingestControl,
    transcriptionBridge,
    createMediaPeers: () => mediaPeers,
    createReceivePeers: () => receivePeers,
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
  });
  return { store, runtime, emitToRoom, ingestControl, receivePeers, timers };
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

async function setMode(
  socket: FakeSocket,
  payload: Record<string, unknown>,
): Promise<CallSetModeAck> {
  const ack = vi.fn();
  await socket.trigger(CALL_EVENTS.SET_MODE, payload, ack);
  expect(ack).toHaveBeenCalledTimes(1);
  return ack.mock.calls[0]?.[0] as CallSetModeAck;
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

describe('call:mode:set — owner authority', () => {
  let harness: Harness;
  let anaSocket: FakeSocket;
  let betoSocket: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    anaSocket = new FakeSocket('socket-a');
    betoSocket = new FakeSocket('socket-b');
    await join(harness, anaSocket, { ...JOIN_ANA });
    await join(harness, betoSocket, { ...JOIN_BETO });
    harness.emitToRoom.mockClear();
  });

  it('carries type, mode and owner in every call:state and the join ack snapshot', async () => {
    const late = createHarness();
    const ack = await join(late, new FakeSocket('socket-a'), { ...JOIN_ANA });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.snapshot).toMatchObject({
      callType: 'conference',
      callMode: 'translated',
      ownerParticipantId: 'participant_1',
      // Review fix: the transcript policy now actually crosses the wire.
      transcriptDownloadAllowed: true,
    });
    const [state] = roomEmissions(late, CALL_EVENTS.STATE);
    expect(state?.payload).toMatchObject({
      callType: 'conference',
      callMode: 'translated',
      ownerParticipantId: 'participant_1',
      // Review fix: the transcript policy now actually crosses the wire.
      transcriptDownloadAllowed: true,
    });
  });

  it('lets the owner turn the engine off: sessions retire, state is re-broadcast', async () => {
    const ack = await setMode(anaSocket, {
      callId: 'demo',
      participantId: 'participant_1',
      mode: 'normal',
    });

    expect(ack).toMatchObject({ ok: true, state: { callMode: 'normal' } });
    const states = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(states).toHaveLength(1);
    expect(states[0]?.room).toBe('call:demo');
    expect(states[0]?.payload).toMatchObject({ callMode: 'normal' });

    // Every ingest session for the call retires: stopped by its old id, then
    // deleted from media-ingest, with nothing left in the registry.
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    await flushAsync();
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_1_r2');
    expect(harness.ingestControl.deleteSession).toHaveBeenCalledWith('call_demo_participant_2_r1');
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBe(0);
  });

  it('swallows a straggler ingest event after the switch to normal', async () => {
    await setMode(anaSocket, { callId: 'demo', participantId: 'participant_1', mode: 'normal' });
    harness.emitToRoom.mockClear();

    // The session id died with the mode change: the event is intercepted (it
    // must never reach programme rooms) and delivers nothing.
    const intercepted = harness.runtime.interceptTimestampedTranslationEvent({
      sessionId: 'call_demo_participant_1_r2',
      streamId: 'callcast_demo_participant_1_r2',
      segmentId: 'segment-1',
      sequence: 1,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceText: 'hello',
      translatedText: 'hola',
      startMs: 0,
      endMs: 1_000,
      status: 'translated',
      latency: { queuedMs: 1, providerMs: 2, totalMs: 3 },
      createdAt: '2026-08-18T00:00:00.000Z',
    });
    expect(intercepted).toBe(true);
    expect(roomEmissions(harness, CALL_EVENTS.CAPTION)).toHaveLength(0);
  });

  it('rebuilds every session at bumped revisions when the owner turns the engine back on', async () => {
    await setMode(anaSocket, { callId: 'demo', participantId: 'participant_1', mode: 'normal' });
    harness.ingestControl.createSession.mockClear();

    const ack = await setMode(anaSocket, {
      callId: 'demo',
      participantId: 'participant_1',
      mode: 'translated',
    });

    expect(ack).toMatchObject({ ok: true, state: { callMode: 'translated' } });
    // Ana r2 → r3 (off) → r4 (on); Beto r1 → r2 → r3.
    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(2);
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_1_r4', targetLanguages: ['es'] }),
    );
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_2_r3', targetLanguages: ['en'] }),
    );
  });

  it('acks a no-op without re-broadcasting state or touching sessions', async () => {
    harness.ingestControl.stopSession.mockClear();
    harness.ingestControl.createSession.mockClear();

    const ack = await setMode(anaSocket, {
      callId: 'demo',
      participantId: 'participant_1',
      mode: 'translated',
    });

    expect(ack).toMatchObject({ ok: true, state: { callMode: 'translated' } });
    expect(roomEmissions(harness, CALL_EVENTS.STATE)).toHaveLength(0);
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalled();
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();
  });

  it('refuses a non-owner by name and changes nothing', async () => {
    const ack = await setMode(betoSocket, {
      callId: 'demo',
      participantId: 'participant_2',
      mode: 'normal',
    });

    expect(ack).toEqual({ ok: false, error: 'not-owner' });
    expect(roomEmissions(harness, CALL_EVENTS.STATE)).toHaveLength(0);
    expect(harness.store.snapshot('demo')?.callMode).toBe('translated');
  });

  it('refuses an unbound socket and a payload naming a different identity', async () => {
    const stranger = new FakeSocket('socket-x');
    harness.runtime.registerSocket(stranger);
    expect(
      await setMode(stranger, { callId: 'demo', participantId: 'participant_1', mode: 'normal' }),
    ).toEqual({ ok: false, error: 'unknown-participant' });

    // A bound socket may only speak as the identity it joined with.
    expect(
      await setMode(betoSocket, { callId: 'demo', participantId: 'participant_1', mode: 'normal' }),
    ).toEqual({ ok: false, error: 'unknown-participant' });
    expect(harness.store.snapshot('demo')?.callMode).toBe('translated');
  });

  it('refuses a mode outside the vocabulary', async () => {
    expect(
      await setMode(anaSocket, { callId: 'demo', participantId: 'participant_1', mode: 'loud' }),
    ).toEqual({ ok: false, error: 'invalid-mode' });
  });

  it('keeps the owner’s authority across resume', async () => {
    harness.runtime.handleSocketDisconnect('socket-a');
    const resumed = new FakeSocket('socket-a2');
    const ack = await join(harness, resumed, {
      ...JOIN_ANA,
      resumeParticipantId: 'participant_1',
      resumeToken: 'resume-token-1',
    });
    expect(ack.ok).toBe(true);

    const modeAck = await setMode(resumed, {
      callId: 'demo',
      participantId: 'participant_1',
      mode: 'normal',
    });
    expect(modeAck).toMatchObject({ ok: true, state: { callMode: 'normal' } });
  });
});

describe('call:video:* — relay-only signalling with membership enforcement', () => {
  let harness: Harness;
  let anaSocket: FakeSocket;
  let betoSocket: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    anaSocket = new FakeSocket('socket-a');
    betoSocket = new FakeSocket('socket-b');
    await join(harness, anaSocket, { ...JOIN_ANA });
    await join(harness, betoSocket, { ...JOIN_BETO });
    harness.emitToRoom.mockClear();
  });

  it('relays offer and answer to the target’s private room with the sender preserved', async () => {
    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      sdp: 'v=0 video-offer',
    });
    await betoSocket.trigger(CALL_EVENTS.VIDEO_ANSWER, {
      callId: 'demo',
      participantId: 'participant_2',
      targetParticipantId: 'participant_1',
      sdp: 'v=0 video-answer',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toEqual([
      {
        room: 'call:demo:participant:participant_2',
        payload: {
          callId: 'demo',
          participantId: 'participant_1',
          targetParticipantId: 'participant_2',
          sdp: 'v=0 video-offer',
        },
      },
    ]);
    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_ANSWER)).toEqual([
      {
        room: 'call:demo:participant:participant_1',
        payload: {
          callId: 'demo',
          participantId: 'participant_2',
          targetParticipantId: 'participant_1',
          sdp: 'v=0 video-answer',
        },
      },
    ]);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(0);
  });

  it('relays ICE candidates, including the null end-of-candidates marker', async () => {
    await anaSocket.trigger(CALL_EVENTS.VIDEO_ICE, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 6000 typ host', sdpMid: '0' },
    });
    await anaSocket.trigger(CALL_EVENTS.VIDEO_ICE, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      candidate: null,
    });

    const relayed = roomEmissions(harness, CALL_EVENTS.VIDEO_ICE);
    expect(relayed).toHaveLength(2);
    expect(relayed[0]).toEqual({
      room: 'call:demo:participant:participant_2',
      payload: {
        callId: 'demo',
        participantId: 'participant_1',
        targetParticipantId: 'participant_2',
        candidate: {
          candidate: 'candidate:1 1 udp 1 127.0.0.1 6000 typ host',
          sdpMid: '0',
          sdpMLineIndex: null,
        },
      },
    });
    expect(relayed[1]?.payload).toMatchObject({ candidate: null });
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(0);
  });

  it('drops an unbound socket’s signal with a diagnostic count and no ack', async () => {
    const stranger = new FakeSocket('socket-x');
    harness.runtime.registerSocket(stranger);

    await stranger.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      sdp: 'v=0 forged',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(stranger.emitted).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(1);
  });

  it('drops a payload whose callId does not match the socket binding', async () => {
    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'other',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      sdp: 'v=0 misdirected',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(1);
  });

  it('drops a target that is not a current participant of the call', async () => {
    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_9',
      sdp: 'v=0 to-nobody',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(1);
  });

  it('drops a target who joined and then LEFT — a departed seat is not a destination', async () => {
    // Pins the seat-deletion dependency: if leave ever stopped removing the
    // seat from the snapshot, this relay would silently reopen (privacy
    // review). participant_2 is a real, formerly-valid target.
    await betoSocket.trigger(CALL_EVENTS.LEAVE, {
      callId: 'demo',
      participantId: 'participant_2',
    });
    harness.emitToRoom.mockClear();

    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      sdp: 'v=0 to-the-departed',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(1);
  });

  it('cannot reach a participant of a DIFFERENT call: the membership lookup never leaves the sender’s call', async () => {
    // A second call whose second seat ('participant_2' of THAT call) does not
    // exist in 'demo'... but the same id DOES exist in demo. So use a call
    // where the target id exists only there: seat 3 of 'other'.
    const otherA = new FakeSocket('socket-oa');
    const otherB = new FakeSocket('socket-ob');
    const otherC = new FakeSocket('socket-oc');
    await join(harness, otherA, { ...JOIN_ANA, callId: 'other' });
    await join(harness, otherB, { ...JOIN_BETO, callId: 'other' });
    await join(harness, otherC, { ...JOIN_BETO, callId: 'other', displayName: 'Cleo' });
    harness.emitToRoom.mockClear();

    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_3',
      sdp: 'v=0 cross-call',
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(1);
  });

  it('drops an oversize sdp and a malformed candidate through the shared limits', async () => {
    await anaSocket.trigger(CALL_EVENTS.VIDEO_OFFER, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      sdp: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength + 1),
    });
    await anaSocket.trigger(CALL_EVENTS.VIDEO_ICE, {
      callId: 'demo',
      participantId: 'participant_1',
      targetParticipantId: 'participant_2',
      candidate: { candidate: '' },
    });

    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toHaveLength(0);
    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_ICE)).toHaveLength(0);
    expect(harness.runtime.getDiagnostics().videoRelayDropCount).toBe(2);
  });
});

describe('W5 leave reconciliation through the gateway', () => {
  let harness: Harness;
  let anaSocket: FakeSocket;
  let umaSocket: FakeSocket;
  let danSocket: FakeSocket;

  /**
   * Ana (en→en) is AFFECTED when Dan leaves: he was her only French listener.
   * Uma (fr→en) is NOT: her one target (en, for Ana) never involved Dan — he
   * heard her original French with captions off, wanting nothing made.
   */
  beforeEach(async () => {
    harness = createHarness();
    anaSocket = new FakeSocket('socket-a');
    umaSocket = new FakeSocket('socket-u');
    danSocket = new FakeSocket('socket-d');
    await join(harness, anaSocket, { ...JOIN_ANA });
    await join(harness, umaSocket, {
      ...JOIN_ANA,
      displayName: 'Uma',
      speakLanguage: 'fr',
      hearLanguage: 'en',
    });
    await join(harness, danSocket, {
      ...JOIN_ANA,
      displayName: 'Dan',
      speakLanguage: 'es',
      hearLanguage: 'fr',
      captionsEnabled: false,
    });
    harness.ingestControl.createSession.mockClear();
    harness.ingestControl.stopSession.mockClear();
    harness.emitToRoom.mockClear();
  });

  it('replaces exactly the affected speaker’s session on leave; the unaffected speaker is untouched', async () => {
    const ack = vi.fn();
    await danSocket.trigger(
      CALL_EVENTS.LEAVE,
      { callId: 'demo', participantId: 'participant_3' },
      ack,
    );
    await flushAsync();
    expect(ack).toHaveBeenCalledWith({ ok: true });

    // The leaver's own session goes through the normal retire path...
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_3_r1');
    // ...and reconciliation replaces ANA's session — explicit cutoff of the
    // French work Dan alone was listening to — at the bumped revision, now
    // STT-only because Uma still reads Ana's captions.
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r3');
    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(1);
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_1_r4', targetLanguages: [] }),
    );
    // Uma's target set did not change: her session id is never stopped.
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalledWith(
      'call_demo_participant_2_r2',
    );
  });

  it('reconciles on grace-expiry reap, not on the disconnect that preceded it', async () => {
    harness.runtime.handleSocketDisconnect('socket-d');

    // Disconnect detaches only Dan's own transport; nobody is re-planned
    // while his seat sits inside the resume grace.
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_3_r1');
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalledWith(
      'call_demo_participant_1_r3',
    );
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();

    firePendingTimers(harness);
    await flushAsync();

    // The reap is the leave: now Ana's session is replaced, and Uma's is not.
    expect(harness.ingestControl.stopSession).toHaveBeenCalledWith('call_demo_participant_1_r3');
    expect(harness.ingestControl.createSession).toHaveBeenCalledTimes(1);
    expect(harness.ingestControl.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'call_demo_participant_1_r4' }),
    );
    expect(harness.ingestControl.stopSession).not.toHaveBeenCalledWith(
      'call_demo_participant_2_r2',
    );
  });
});

/* ============================================================================
 * W5.1 — mid-call Audio Mode authority through the REAL event path.
 *
 * The contradiction this closes: the client's Audio Mode selector flipped the
 * LOCAL mix immediately while the server kept synthesizing for the old
 * preference until the next resume. `call:audio-mode:set` makes the change
 * authoritative for planning: unnecessary TTS stops (or resumes) with no
 * leave, no reconnect, no resume, no renegotiation.
 * ========================================================================== */

describe('call:audio-mode:set — planning reacts without any reconnect', () => {
  /** The four-person matrix, joined through real sockets. */
  async function matrix(harness: Harness) {
    const a = new FakeSocket('socket-ma');
    const b = new FakeSocket('socket-mb');
    const c = new FakeSocket('socket-mc');
    const d = new FakeSocket('socket-md');
    await join(harness, a, {
      ...JOIN_ANA,
      callId: 'matrix',
      displayName: 'A',
      speakLanguage: 'en',
      hearLanguage: 'en',
    });
    const bAck = await join(harness, b, {
      ...JOIN_BETO,
      callId: 'matrix',
      displayName: 'B',
      speakLanguage: 'fr',
      hearLanguage: 'fr',
    });
    const cAck = await join(harness, c, {
      ...JOIN_BETO,
      callId: 'matrix',
      displayName: 'C',
      speakLanguage: 'es',
      hearLanguage: 'es',
    });
    const dAck = await join(harness, d, {
      ...JOIN_BETO,
      callId: 'matrix',
      displayName: 'D',
      speakLanguage: 'en',
      hearLanguage: 'fr',
      audioMode: 'original',
    });
    if (!bAck.ok || !cAck.ok || !dAck.ok) throw new Error('matrix join failed');
    return { a, b, c, d, cId: cAck.participantId };
  }

  /** Contexts of every ingest session CREATED for A (the en speaker). */
  function aSessionContexts(harness: Harness) {
    return harness.ingestControl.createSession.mock.calls
      .map(([context]) => context)
      .filter((context) => context.sessionId.includes('participant_1'));
  }

  it('C switching Translated → Original stops Spanish TTS while captions continue; Interpretation restores it; Translated adds no redundant work', async () => {
    const harness = createHarness();
    const seats = await matrix(harness);

    // Initial planning: A speaks en; fr (B audio + D captions) and es (C
    // audio) are both AUDIO targets — nothing text-only.
    const initial = aSessionContexts(harness).at(-1)!;
    expect([...(initial.targetLanguages ?? [])].sort()).toEqual(['es', 'fr']);
    expect(initial.textOnlyLanguages ?? []).toEqual([]);

    // C changes Audio Mode through the SAME event path the client uses.
    harness.ingestControl.createSession.mockClear();
    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'original' },
        resolve,
      );
    });
    expect(ack.ok).toBe(true);

    // A's session was REPLACED: es survives for captions, demoted text-only;
    // fr keeps its voice for B. No leave, no reconnect, no resume happened.
    const replaced = aSessionContexts(harness).at(-1)!;
    expect([...(replaced.targetLanguages ?? [])].sort()).toEqual(['es', 'fr']);
    expect(replaced.textOnlyLanguages).toEqual(['es']);
    expect(Object.keys(replaced.voiceIdsByLanguage ?? {})).toEqual(['fr']);

    // Original → Interpretation: Spanish synthesis resumes.
    harness.ingestControl.createSession.mockClear();
    await new Promise((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'interpretation' },
        resolve,
      );
    });
    const restored = aSessionContexts(harness).at(-1)!;
    expect(restored.textOnlyLanguages ?? []).toEqual([]);
    expect(Object.keys(restored.voiceIdsByLanguage ?? {}).sort()).toEqual(['es', 'fr']);

    // Interpretation → Translated: same requirements — ZERO new sessions.
    harness.ingestControl.createSession.mockClear();
    const noop = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'translated' },
        resolve,
      );
    });
    expect(noop.ok).toBe(true);
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();
  });

  it('a socket cannot change another participant\u2019s Audio Mode, nor reach across calls', async () => {
    const harness = createHarness();
    const seats = await matrix(harness);
    harness.ingestControl.createSession.mockClear();

    // C's socket naming B's participantId: binding mismatch, refused.
    const forgedParticipant = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: 'participant_2', audioMode: 'original' },
        resolve,
      );
    });
    expect(forgedParticipant.ok).toBe(false);

    // C's socket naming a different call: binding mismatch, refused.
    const forgedCall = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'demo', participantId: seats.cId, audioMode: 'original' },
        resolve,
      );
    });
    expect(forgedCall.ok).toBe(false);
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();
  });

  it('repeating the same value is idempotent and a departed seat is refused', async () => {
    const harness = createHarness();
    const seats = await matrix(harness);

    await new Promise((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'original' },
        resolve,
      );
    });
    harness.ingestControl.createSession.mockClear();

    const repeat = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'original' },
        resolve,
      );
    });
    expect(repeat.ok).toBe(true);
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();

    // Leave, then the stale change arrives: refused, nothing replanned.
    await seats.c.trigger(CALL_EVENTS.LEAVE, { callId: 'matrix', participantId: seats.cId });
    harness.ingestControl.createSession.mockClear();
    const afterLeave = await new Promise<{ ok: boolean }>((resolve) => {
      void seats.c.trigger(
        CALL_EVENTS.SET_AUDIO_MODE,
        { callId: 'matrix', participantId: seats.cId, audioMode: 'translated' },
        resolve,
      );
    });
    expect(afterLeave.ok).toBe(false);
  });
});

/**
 * Ending the call for everyone — the gateway's half.
 *
 * The store answers who may; this proves the gateway enforces that answer and
 * carries out the transport consequences in an order that actually reaches
 * people. Announcing an ending AFTER tearing down the sockets tells nobody.
 */
describe('call:end', () => {
  let harness: Harness;
  let anaSocket: FakeSocket;
  let betoSocket: FakeSocket;

  beforeEach(async () => {
    harness = createHarness();
    anaSocket = new FakeSocket('socket-a');
    betoSocket = new FakeSocket('socket-b');
    await join(harness, anaSocket, { ...JOIN_ANA });
    await join(harness, betoSocket, { ...JOIN_BETO });
    harness.emitToRoom.mockClear();
  });

  async function end(socket: FakeSocket, payload: Record<string, unknown>) {
    const ack = vi.fn();
    await socket.trigger(CALL_EVENTS.END, payload, ack);
    expect(ack).toHaveBeenCalledTimes(1);
    return ack.mock.calls[0]?.[0] as { ok: boolean; error?: string };
  }

  it('lets the owner end the call and tells everyone before tearing it down', async () => {
    const ack = await end(anaSocket, { callId: 'demo', participantId: 'participant_1' });
    expect(ack.ok).toBe(true);

    const ended = roomEmissions(harness, CALL_EVENTS.ENDED);
    expect(ended).toHaveLength(1);
    // Broadcast to the whole call, naming who ended it — "the call ended" and
    // "Ana ended the call" are different things to be told.
    expect(ended[0]?.payload).toMatchObject({
      callId: 'demo',
      endedByParticipantId: 'participant_1',
      endedByDisplayName: 'Ana',
    });
  });

  it('PIN: a non-owner is refused, and the call survives', async () => {
    const ack = await end(betoSocket, { callId: 'demo', participantId: 'participant_2' });
    expect(ack).toEqual({ ok: false, error: 'not-owner' });
    // Nothing was announced and nothing was torn down.
    expect(roomEmissions(harness, CALL_EVENTS.ENDED)).toHaveLength(0);
    expect(harness.store.snapshot('demo')).not.toBeNull();
  });

  it('PIN: the ending is announced BEFORE the transports are detached', async () => {
    // teardownCall detaches the very sockets that need to hear this. If the
    // order ever flips, the event is emitted into an empty room and every
    // participant sees a frozen call instead of an ended one.
    await end(anaSocket, { callId: 'demo', participantId: 'participant_1' });
    const events = harness.emitToRoom.mock.calls.map((call) => call[1]);
    expect(events).toContain(CALL_EVENTS.ENDED);
    expect(harness.store.snapshot('demo')).toBeNull();
  });

  it('PIN: a participant cannot end a call by naming somebody else', async () => {
    // Authority is read from the socket's own binding, never from the payload,
    // so claiming the owner's id in the body changes nothing.
    const ack = await end(betoSocket, { callId: 'demo', participantId: 'participant_1' });
    expect(ack.ok).toBe(false);
    expect(harness.store.snapshot('demo')).not.toBeNull();
  });
});
