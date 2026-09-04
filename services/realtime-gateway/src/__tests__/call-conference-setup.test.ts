/** @owner masterzee001 */
/**
 * Conference setup on the wire (founder canon 29 Aug): title and privacy
 * cross in call:state, a restricted room makes joiners knock, the host is
 * the only one who answers, silence is a refusal, and GET /calls/public
 * lists exactly the public rooms.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSessionStore } from '@videofy-live/call-session';
import type {
  WebRtcIceCandidateEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { WEBRTC_BACKEND_MEDIA_PEER_ID } from '@videofy-live/shared-types';
import type { CallAdmitAck } from '@videofy-live/call-wire';
import { createApp } from '../app.js';
import {
  CALL_EVENTS,
  CALL_KNOCK_TIMEOUT_MS,
  CallRuntime,
  callParticipantRoom,
  callRoom,
  type CallJoinAck,
  type CallSocketLike,
} from '../call-runtime.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

class FakeSocket implements CallSocketLike {
  readonly rooms = new Set<string>();
  readonly emitted: { event: string; payload: unknown }[] = [];
  disconnected = false;
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

  disconnect(): void {
    this.disconnected = true;
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

const HOST = {
  callId: 'room',
  displayName: 'Host',
  speakLanguage: 'en',
  hearLanguage: 'en',
  captionsEnabled: true,
  voiceGender: 'male',
  audioMode: 'translated',
} as const;

const GUEST = {
  callId: 'room',
  displayName: 'Guest',
  speakLanguage: 'es',
  hearLanguage: 'es',
  captionsEnabled: true,
  voiceGender: 'female',
  audioMode: 'translated',
} as const;

function createHarness() {
  let tokenSerial = 0;
  const store = new CallSessionStore({
    now: () => '2026-08-29T00:00:00.000Z',
    createResumeToken: () => `resume-token-${++tokenSerial}`,
  });
  const emitToRoom = vi.fn<(room: string, event: string, payload: unknown) => void>();
  const ingestControl = {
    createSession: vi.fn(async (_input: MediaTranscriptionBridgeContext) => {}),
    stopSession: vi.fn(async (_sessionId: string) => {}),
    deleteSession: vi.fn(async (_sessionId: string) => {}),
  };
  const transcriptionBridge = {
    handleFrame: vi.fn((_context: MediaTranscriptionBridgeContext, _data: MediaAudioDataLike) => {}),
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
        createdAt: '2026-08-29T00:00:00.000Z',
        payload: { targetPeerId: offer.peerId, sdp: 'answer-sdp' },
      }),
    ),
    addRemoteCandidate: vi.fn(async (_envelope: WebRtcIceCandidateEnvelope) => {}),
    closeSession: vi.fn((_sessionId: string | undefined, _reason?: string) => {}),
    getSnapshots: vi.fn(() => [] as unknown[]),
  };
  const receivePeers = {
    acceptOffer: vi.fn(async (_callId: string, _participantId: string, _sdp: string) => 'answer'),
    addRemoteCandidate: vi.fn(
      async (_callId: string, _participantId: string, _candidate: { candidate: string }) => {},
    ),
    fanOut: vi.fn((_callId: string, _speakerParticipantId: string, _data: MediaAudioDataLike) => {}),
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
    authorizeCallHost: async () => true,
    store,
    emitToRoom,
    ingestControl,
    transcriptionBridge,
    createMediaPeers: () => mediaPeers,
    createReceivePeers: () => receivePeers,
    disconnectGraceMs: 5_000,
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

async function admit(
  socket: FakeSocket,
  payload: Record<string, unknown>,
): Promise<CallAdmitAck> {
  const ack = vi.fn();
  await socket.trigger(CALL_EVENTS.ADMIT, payload, ack);
  expect(ack).toHaveBeenCalledTimes(1);
  return ack.mock.calls[0]?.[0] as CallAdmitAck;
}

function roomEmissions(harness: Harness, event: string): { room: string; payload: unknown }[] {
  return harness.emitToRoom.mock.calls
    .filter((call) => call[1] === event)
    .map((call) => ({ room: call[0], payload: call[2] }));
}

function knockTimers(harness: Harness): FakeTimer[] {
  return harness.timers.filter((timer) => timer.delayMs === CALL_KNOCK_TIMEOUT_MS);
}

function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('title, privacy and target languages on the wire', () => {
  it('carries the creating join setup in the ack snapshot and every call:state', async () => {
    const harness = createHarness();
    const ack = await join(harness, new FakeSocket('s-host'), {
      ...HOST,
      title: '  Quarterly review ',
      privacy: 'public',
      targetLanguages: ['yo', 'pt-BR'],
    });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.admission).toBeUndefined();
    expect(ack.snapshot).toMatchObject({
      title: 'Quarterly review',
      privacy: 'public',
      targetLanguages: ['yo', 'pt-BR'],
      knocking: [],
    });
    const [state] = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(state?.payload).toMatchObject({
      title: 'Quarterly review',
      privacy: 'public',
      targetLanguages: ['yo', 'pt-BR'],
      knocking: [],
    });
  });

  it('defaults to untitled and private, and a personal call carries a null title', async () => {
    const harness = createHarness();
    const conference = await join(harness, new FakeSocket('s-1'), { ...HOST });
    expect(conference.ok && conference.snapshot).toMatchObject({ title: null, privacy: 'private' });
    const personal = await join(harness, new FakeSocket('s-2'), {
      ...HOST,
      callId: 'direct',
      callType: 'personal',
      title: 'Ignored on a personal call',
    });
    expect(personal.ok && personal.snapshot).toMatchObject({
      callType: 'personal',
      title: null,
      privacy: 'private',
      targetLanguages: [],
    });
  });

  it('refuses a malformed target language with the store wording', async () => {
    const harness = createHarness();
    const ack = await join(harness, new FakeSocket('s-1'), { ...HOST, targetLanguages: ['EN'] });
    expect(ack).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(harness.store.snapshot('room')).toBeNull();
  });
});

describe('restricted admission', () => {
  let harness: Harness;
  let hostSocket: FakeSocket;
  let guestSocket: FakeSocket;
  let hostId: string;
  let guestAck: CallJoinAck;

  beforeEach(async () => {
    harness = createHarness();
    hostSocket = new FakeSocket('s-host');
    guestSocket = new FakeSocket('s-guest');
    const hostAck = await join(harness, hostSocket, { ...HOST, privacy: 'restricted', title: 'Board' });
    if (!hostAck.ok) throw new Error('host join failed');
    hostId = hostAck.participantId;
    harness.emitToRoom.mockClear();
    guestAck = await join(harness, guestSocket, { ...GUEST });
  });

  it('a non-host join knocks: pending ack, KNOCK to the host, no roster, no media', () => {
    expect(guestAck.ok).toBe(true);
    if (!guestAck.ok) return;
    expect(guestAck.admission).toBe('pending');
    expect(guestAck.snapshot).toMatchObject({ title: 'Board', privacy: 'restricted', participants: [] });
    expect(roomEmissions(harness, CALL_EVENTS.KNOCK)).toEqual([
      {
        room: callParticipantRoom('room', hostId),
        payload: { callId: 'room', participantId: guestAck.participantId, displayName: 'Guest' },
      },
    ]);
    // The knocker's own private room only: never the call room.
    expect(guestSocket.rooms.has(callRoom('room'))).toBe(false);
    expect(guestSocket.rooms.has(callParticipantRoom('room', guestAck.participantId))).toBe(true);
    // The room's call:state shows the host the knocking entry, roster unchanged.
    const states = roomEmissions(harness, CALL_EVENTS.STATE);
    expect(states.at(-1)?.payload).toMatchObject({
      participants: [{ participantId: hostId }],
      knocking: [{ participantId: guestAck.participantId, displayName: 'Guest' }],
    });
    expect(harness.ingestControl.createSession).not.toHaveBeenCalled();
    expect(knockTimers(harness)).toHaveLength(1);
  });

  it('admit seats the knocker: ADMISSION, STATE, plans as a normal join', async () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    harness.emitToRoom.mockClear();
    const ack = await admit(hostSocket, {
      callId: 'room',
      participantId: hostId,
      targetParticipantId: guestAck.participantId,
      admit: true,
    });
    expect(ack).toEqual({ ok: true });
    await flushAsync();
    expect(knockTimers(harness)[0]?.cleared).toBe(true);
    expect(guestSocket.rooms.has(callRoom('room'))).toBe(true);
    expect(roomEmissions(harness, CALL_EVENTS.ADMISSION)).toEqual([
      {
        room: callParticipantRoom('room', guestAck.participantId),
        payload: expect.objectContaining({
          callId: 'room',
          admitted: true,
          snapshot: expect.objectContaining({ knocking: [] }),
        }),
      },
    ]);
    const state = roomEmissions(harness, CALL_EVENTS.STATE).at(-1)?.payload as {
      participants: { participantId: string }[];
      knocking: unknown[];
      state: string;
    };
    expect(state.participants.map((p) => p.participantId)).toEqual([hostId, guestAck.participantId]);
    expect(state.knocking).toEqual([]);
    expect(state.state).toBe('active');
    // The host was re-planned for the Spanish listener, like any join.
    const created = harness.ingestControl.createSession.mock.calls.map((call) => call[0]);
    expect(created.some((ctx) => ctx.sessionId.includes(hostId))).toBe(true);
    expect(harness.runtime.getDiagnostics().participantCount).toBe(2);
    // And the admitted seat is now a full participant: it may leave.
    const leaveAck = vi.fn();
    await guestSocket.trigger(
      CALL_EVENTS.LEAVE,
      { callId: 'room', participantId: guestAck.participantId },
      leaveAck,
    );
    expect(leaveAck).toHaveBeenCalledWith({ ok: true });
  });

  it('refuse tells the knocker, releases the seat and disconnects them', async () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    harness.emitToRoom.mockClear();
    const ack = await admit(hostSocket, {
      callId: 'room',
      participantId: hostId,
      targetParticipantId: guestAck.participantId,
      admit: false,
    });
    expect(ack).toEqual({ ok: true });
    expect(roomEmissions(harness, CALL_EVENTS.ADMISSION)).toEqual([
      {
        room: callParticipantRoom('room', guestAck.participantId),
        payload: { callId: 'room', admitted: false, reason: 'refused' },
      },
    ]);
    expect(guestSocket.disconnected).toBe(true);
    expect(guestSocket.rooms.size).toBe(0);
    expect(knockTimers(harness)[0]?.cleared).toBe(true);
    expect(harness.store.snapshot('room')?.knocking).toEqual([]);
    expect(roomEmissions(harness, CALL_EVENTS.STATE).at(-1)?.payload).toMatchObject({ knocking: [] });
    expect(harness.runtime.getDiagnostics().socketBindingCount).toBe(1);
    // A refused socket cannot act on the call any more.
    const leaveAck = vi.fn();
    await guestSocket.trigger(
      CALL_EVENTS.LEAVE,
      { callId: 'room', participantId: guestAck.participantId },
      leaveAck,
    );
    expect(leaveAck).toHaveBeenCalledWith({ ok: false });
    // The host is still alone in a live room.
    expect(harness.store.snapshot('room')?.participants).toHaveLength(1);
  });

  it('a knock nobody answers within 60 s is refused as a timeout', () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    harness.emitToRoom.mockClear();
    const [timer] = knockTimers(harness);
    expect(timer?.delayMs).toBe(60_000);
    timer!.callback();
    expect(roomEmissions(harness, CALL_EVENTS.ADMISSION)).toEqual([
      {
        room: callParticipantRoom('room', guestAck.participantId),
        payload: { callId: 'room', admitted: false, reason: 'timeout' },
      },
    ]);
    expect(guestSocket.disconnected).toBe(true);
    expect(harness.store.snapshot('room')?.knocking).toEqual([]);
    expect(harness.store.snapshot('room')?.participants).toHaveLength(1);
  });

  it('only the host may answer; the knocker cannot admit themselves', async () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    // A second knocker, so a non-host seat exists that is bound to a socket.
    const otherSocket = new FakeSocket('s-other');
    const otherAck = await join(harness, otherSocket, { ...GUEST, displayName: 'Other' });
    if (!otherAck.ok) throw new Error('other join failed');
    // A knocker is not in the call, so its binding is refused before the
    // store is asked; the store's own 'not-owner' is pinned in call-session.
    expect(
      await admit(guestSocket, {
        callId: 'room',
        participantId: guestAck.participantId,
        targetParticipantId: otherAck.participantId,
        admit: true,
      }),
    ).toEqual({ ok: false, error: 'unknown-participant' });
    expect(
      await admit(guestSocket, {
        callId: 'room',
        participantId: guestAck.participantId,
        targetParticipantId: guestAck.participantId,
        admit: true,
      }),
    ).toEqual({ ok: false, error: 'unknown-participant' });
    // Impersonating the host's binding is refused before the store is asked.
    expect(
      await admit(guestSocket, {
        callId: 'room',
        participantId: hostId,
        targetParticipantId: guestAck.participantId,
        admit: true,
      }),
    ).toEqual({ ok: false, error: 'unknown-participant' });
    // The host answering for a seat that is not knocking, or malformed input.
    expect(
      await admit(hostSocket, {
        callId: 'room',
        participantId: hostId,
        targetParticipantId: hostId,
        admit: true,
      }),
    ).toEqual({ ok: false, error: 'not-knocking' });
    expect(
      await admit(hostSocket, { callId: 'room', participantId: hostId, admit: 'yes' }),
    ).toEqual({ ok: false, error: 'invalid-input' });
    expect(harness.store.snapshot('room')?.knocking).toHaveLength(2);
  });

  it('a knocking seat is bound but not in the call: no receive peer, no video relay, no state, only leave', async () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    const me = { callId: 'room', participantId: guestAck.participantId };
    harness.emitToRoom.mockClear();
    // The host's own join already reconciled slots; only the knocker's
    // attempts are counted from here.
    harness.receivePeers.syncSpeakers.mockClear();
    // Receive peer: refused before the peer registry hears of it, so no
    // seated speaker is ever bound into a knocker's slots.
    const receiveAck = vi.fn();
    await guestSocket.trigger(CALL_EVENTS.RECEIVE_OFFER, { ...me, sdp: 'offer' }, receiveAck);
    expect(receiveAck.mock.calls[0]?.[0]).toMatchObject({ ok: false });
    expect(harness.receivePeers.acceptOffer).not.toHaveBeenCalled();
    expect(harness.receivePeers.syncSpeakers).not.toHaveBeenCalled();
    await guestSocket.trigger(CALL_EVENTS.RECEIVE_ICE, { ...me, candidate: { candidate: 'c' } });
    expect(harness.receivePeers.addRemoteCandidate).not.toHaveBeenCalled();
    // Video signalling towards a seated member is dropped, not relayed.
    await guestSocket.trigger(CALL_EVENTS.VIDEO_OFFER, { ...me, targetParticipantId: hostId, sdp: 'v' });
    expect(roomEmissions(harness, CALL_EVENTS.VIDEO_OFFER)).toEqual([]);
    // Call state is out of reach until admitted.
    const captionAck = vi.fn();
    await guestSocket.trigger(CALL_EVENTS.SET_CAPTION_LANGUAGE, { ...me, language: 'fr' }, captionAck);
    expect(captionAck.mock.calls[0]?.[0]).toMatchObject({ ok: false });
    expect(harness.store.snapshot('room')?.knocking).toHaveLength(1);
    // Leaving is the one act a knocker's binding permits.
    const leaveAck = vi.fn();
    await guestSocket.trigger(CALL_EVENTS.LEAVE, me, leaveAck);
    expect(leaveAck).toHaveBeenCalledWith({ ok: true });
    expect(harness.store.snapshot('room')?.knocking).toEqual([]);
    expect(knockTimers(harness)[0]?.cleared).toBe(true);
  });

  it('a knocker whose socket drops is forgotten: no reaper, no seat, no answer owed', () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    harness.emitToRoom.mockClear();
    harness.runtime.handleSocketDisconnect(guestSocket.id);
    expect(knockTimers(harness)[0]?.cleared).toBe(true);
    expect(harness.timers.filter((t) => t.delayMs === 5_000 && !t.cleared)).toHaveLength(0);
    expect(harness.store.snapshot('room')?.knocking).toEqual([]);
    expect(roomEmissions(harness, CALL_EVENTS.ADMISSION)).toEqual([]);
    expect(roomEmissions(harness, CALL_EVENTS.STATE).at(-1)?.payload).toMatchObject({ knocking: [] });
  });

  it('the host ending the call turns the knocker away', async () => {
    if (!guestAck.ok) throw new Error('guest join failed');
    harness.emitToRoom.mockClear();
    const ack = vi.fn();
    await hostSocket.trigger(CALL_EVENTS.END, { callId: 'room', participantId: hostId }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(roomEmissions(harness, CALL_EVENTS.ADMISSION)).toEqual([
      {
        room: callParticipantRoom('room', guestAck.participantId),
        payload: { callId: 'room', admitted: false, reason: 'refused' },
      },
    ]);
    expect(guestSocket.disconnected).toBe(true);
    expect(harness.store.snapshot('room')).toBeNull();
  });

  it('public and private conferences seat joiners directly, as before', async () => {
    for (const privacy of ['public', 'private'] as const) {
      const fresh = createHarness();
      await join(fresh, new FakeSocket('h'), { ...HOST, callId: `c-${privacy}`, privacy });
      const ack = await join(fresh, new FakeSocket('g'), { ...GUEST, callId: `c-${privacy}` });
      expect(ack.ok && ack.admission).toBeUndefined();
      expect(roomEmissions(fresh, CALL_EVENTS.KNOCK)).toEqual([]);
    }
  });
});

describe('GET /calls/public', () => {
  it('lists exactly the public conferences the runtime reports', async () => {
    const harness = createHarness();
    await join(harness, new FakeSocket('a'), { ...HOST, callId: 'open', privacy: 'public', title: 'Open' });
    await join(harness, new FakeSocket('b'), { ...HOST, callId: 'closed', privacy: 'private' });
    await join(harness, new FakeSocket('c'), { ...HOST, callId: 'door', privacy: 'restricted' });
    const server = createServer(createApp({ publicCalls: () => harness.runtime.listPublicCalls() }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/calls/public`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        calls: [
          {
            callId: 'open',
            title: 'Open',
            participantCount: 1,
            createdAtMs: Date.parse('2026-08-29T00:00:00.000Z'),
          },
        ],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('is not mounted when no listing is provided', async () => {
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/calls/public`);
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
