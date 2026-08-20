/** @owner masterzee001 */
/**
 * P6.5 — the connect-join security matrix (R6/R7/R12), the server-authority
 * paths (R4), and one full /v1 → token → socket join → authority loop.
 *
 * The unit half drives a CallRuntime with REAL connect-control machinery (a
 * real gate, jti set, live-call map, and signed tokens) over the house fake
 * socket, so what is proven is the composed behavior, not a mock's opinion.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSessionStore } from '@videofy-live/call-session';
import {
  ConnectJoinGate,
  ConnectJtiRegistry,
  ConnectLiveCallRegistry,
  ConnectProjectRegistry,
  issueConnectJoinToken,
  type ConnectProjectRecord,
} from '@videofy-live/connect-control';
import type {
  WebRtcIceCandidateEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { WEBRTC_BACKEND_MEDIA_PEER_ID } from '@videofy-live/shared-types';
import {
  CALL_EVENTS,
  CallRuntime,
  callRoom,
  type CallSocketLike,
} from '../call-runtime.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';
import { createApp } from '../app.js';
import { Gateway, createSocketOriginPolicy } from '../gateway.js';
import { loadConfig } from '../config.js';

const SECRET_STRING = 'connect-secret-0123456789abcdef0123456789abcdef';
const SECRET = Buffer.from(SECRET_STRING, 'utf8');
const WRONG_SECRET = Buffer.from('wrong-secret-0123456789abcdef0123456789abcdefff', 'utf8');
const NOW_SECONDS = 1_755_500_000;

const PROJECT_A = 'proj_alpha0000000';
const PROJECT_B = 'proj_beta00000000';
const ORIGIN_A = 'https://support.acme.example';
const ORIGIN_B = 'https://desk.beta.example';
const PUBLIC_A = 'vc_aaaaaaaaaaaaaaaa';
const INTERNAL_A = 'connect_alpha000_aaaaaaaaaaaa';
const PUBLIC_B = 'vc_bbbbbbbbbbbbbbbb';
const INTERNAL_B = 'connect_beta0000_bbbbbbbbbbbb';
const RAW_KEY = 'vfk_dev_0123456789abcdef0123456789abcdef';

function projectRecord(overrides: Partial<ConnectProjectRecord>): ConnectProjectRecord {
  return {
    projectId: PROJECT_A,
    name: 'Alpha',
    keyHash: createHash('sha256').update(RAW_KEY, 'utf8').digest('hex'),
    allowedOrigins: [ORIGIN_A],
    allowOriginless: false,
    createdAt: '2026-08-18T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

class FakeSocket implements CallSocketLike {
  readonly rooms = new Set<string>();
  readonly emitted: { event: string; payload: unknown }[] = [];
  handshake?: { headers?: Record<string, string | string[] | undefined> };

  constructor(
    readonly id: string,
    origin?: string,
  ) {
    if (origin !== undefined) {
      this.handshake = { headers: { origin } };
    }
  }

  join(room: string): void {
    this.rooms.add(room);
  }

  leave(room: string): void {
    this.rooms.delete(room);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  on(): void {}
}

interface JoinAckLike {
  ok: boolean;
  code?: string;
  error?: string;
  participantId?: string;
  resumeToken?: string;
  snapshot?: {
    callId: string;
    callType: string;
    callMode: string;
    state: string;
    participants: {
      participantId: string;
      displayName: string;
      subject?: string;
      joined: boolean;
    }[];
  };
}

function createHarness(options: { registerLiveCalls?: boolean } = {}) {
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
        createdAt: '2026-08-18T00:00:00.000Z',
        payload: { targetPeerId: offer.peerId, sdp: 'answer-sdp' },
      }),
    ),
    addRemoteCandidate: vi.fn(async (_envelope: WebRtcIceCandidateEnvelope) => {}),
    closeSession: vi.fn((_sessionId: string | undefined, _reason?: string) => {}),
    getSnapshots: vi.fn(() => [] as unknown[]),
  };
  const receivePeers = {
    acceptOffer: vi.fn(async () => 'receive-answer-sdp'),
    addRemoteCandidate: vi.fn(async () => {}),
    fanOut: vi.fn(),
    syncSpeakers: vi.fn(),
    trackMapping: vi.fn(() => []),
    closePeer: vi.fn(),
    closeCall: vi.fn(),
    count: vi.fn(() => 0),
  };
  const registry = new ConnectProjectRegistry([
    projectRecord({}),
    projectRecord({
      projectId: PROJECT_B,
      name: 'Beta',
      allowedOrigins: [ORIGIN_B],
      allowOriginless: true,
    }),
  ]);
  const liveCalls = new ConnectLiveCallRegistry();
  if (options.registerLiveCalls !== false) {
    liveCalls.register({
      publicCallId: PUBLIC_A,
      internalCallId: INTERNAL_A,
      projectId: PROJECT_A,
      callType: 'conference',
      mode: 'translated',
      createdAt: '2026-08-18T00:00:00.000Z',
      ended: false,
    });
    liveCalls.register({
      publicCallId: PUBLIC_B,
      internalCallId: INTERNAL_B,
      projectId: PROJECT_B,
      callType: 'personal',
      mode: 'translated',
      createdAt: '2026-08-18T00:00:00.000Z',
      ended: false,
    });
  }
  const jti = new ConnectJtiRegistry();
  const gate = new ConnectJoinGate({
    secret: SECRET,
    registry,
    liveCalls,
    jti,
    nowSeconds: () => NOW_SECONDS,
  });
  const runtime = new CallRuntime({
    store,
    emitToRoom,
    ingestControl,
    transcriptionBridge,
    createMediaPeers: () => mediaPeers,
    createReceivePeers: () => receivePeers,
    connectAuthority: gate,
  });
  if (options.registerLiveCalls !== false) {
    // The /v1 create path preregisters both calls in the store.
    expect(runtime.preregisterConnectCall(INTERNAL_A, {
      callType: 'conference',
      callMode: 'translated',
      projectTag: PROJECT_A,
    }).ok).toBe(true);
    expect(runtime.preregisterConnectCall(INTERNAL_B, {
      callType: 'personal',
      callMode: 'translated',
      projectTag: PROJECT_B,
    }).ok).toBe(true);
  }
  return { runtime, store, emitToRoom, ingestControl, receivePeers, liveCalls, jti };
}

let mintedSerial = 0;
function mintToken(overrides: Partial<Parameters<typeof issueConnectJoinToken>[0]> = {}): string {
  return issueConnectJoinToken({
    secret: SECRET,
    proj: PROJECT_A,
    call: PUBLIC_A,
    sub: `customer_${++mintedSerial}`,
    name: `Guest ${mintedSerial}`,
    prefs: { speak: 'en', hear: 'en', audioMode: 'translated', captions: true, voiceGender: 'female' },
    jti: `jti_matrix_${mintedSerial}`,
    nowSeconds: NOW_SECONDS,
    ...overrides,
  }).token;
}

async function joinWith(
  runtime: CallRuntime,
  socket: FakeSocket,
  payload: Record<string, unknown>,
): Promise<JoinAckLike> {
  return (await runtime.handleJoin(socket, payload)) as JoinAckLike;
}

describe('connect join — token verification and single use (R6)', () => {
  it('grants a valid token, seats the participant under token identity, and exposes subject in STATE', async () => {
    const harness = createHarness();
    const socket = new FakeSocket('s1', ORIGIN_A);
    const ack = await joinWith(harness.runtime, socket, {
      connectToken: mintToken({ sub: 'customer_8291', name: 'Ana', jti: 'jti_grant_1' }),
      // Everything client-stated is stripped and rederived — these lies change nothing.
      callId: 'evil-call',
      displayName: 'Impostor',
      callType: 'personal',
      callMode: 'normal',
      voiceOwnerId: 'acct_victim',
    });
    expect(ack.ok).toBe(true);
    expect(ack.resumeToken).toBeDefined();
    expect(ack.snapshot?.callId).toBe(INTERNAL_A);
    expect(ack.snapshot?.callType).toBe('conference');
    expect(ack.snapshot?.callMode).toBe('translated');
    const seat = ack.snapshot?.participants.find((p) => p.participantId === ack.participantId);
    expect(seat?.displayName).toBe('Ana');
    expect(seat?.subject).toBe('customer_8291');
    expect(socket.rooms.has(callRoom(INTERNAL_A))).toBe(true);
    // The broadcast STATE carries both identities for the connect seat.
    const stateEmit = harness.emitToRoom.mock.calls.find(
      ([room, event]) => room === callRoom(INTERNAL_A) && event === CALL_EVENTS.STATE,
    );
    expect(stateEmit).toBeDefined();
    const statePayload = stateEmit?.[2] as JoinAckLike['snapshot'];
    expect(statePayload?.participants[0]?.subject).toBe('customer_8291');
  });

  it('refuses garbage, forged, and expired tokens with distinct terminal codes', async () => {
    const harness = createHarness();
    const garbage = await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
      connectToken: 'not-a-token',
    });
    expect(garbage).toMatchObject({ ok: false, code: 'AUTH_INVALID_TOKEN' });

    const forged = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: mintToken({ secret: WRONG_SECRET, jti: 'jti_forged_1' }),
    });
    expect(forged).toMatchObject({ ok: false, code: 'AUTH_INVALID_TOKEN' });

    const expired = await joinWith(harness.runtime, new FakeSocket('s3', ORIGIN_A), {
      connectToken: mintToken({ nowSeconds: NOW_SECONDS - 301, jti: 'jti_expired_1' }),
    });
    expect(expired).toMatchObject({ ok: false, code: 'AUTH_EXPIRED_TOKEN' });
  });

  it('a forged token can never burn a jti a genuine token still needs', async () => {
    const harness = createHarness();
    const forged = await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
      connectToken: mintToken({ secret: WRONG_SECRET, jti: 'jti_shared' }),
    });
    expect(forged).toMatchObject({ ok: false, code: 'AUTH_INVALID_TOKEN' });
    const genuine = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: mintToken({ jti: 'jti_shared' }),
    });
    expect(genuine.ok).toBe(true);
  });

  it('refuses a second presentation of a used token with AUTH_TOKEN_USED', async () => {
    const harness = createHarness();
    const token = mintToken({ jti: 'jti_used_1' });
    expect((await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), { connectToken: token })).ok).toBe(true);
    const replay = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: token,
    });
    expect(replay).toMatchObject({ ok: false, code: 'AUTH_TOKEN_USED' });
  });

  it('R6 atomic first-claim-wins: two SIMULTANEOUS joins on one token — exactly one seats', async () => {
    const harness = createHarness();
    const token = mintToken({ jti: 'jti_race_1' });
    // Both handlers start on the same event-loop turn; the synchronous
    // check-and-claim decides before either reaches an await.
    const first = harness.runtime.handleJoin(new FakeSocket('s1', ORIGIN_A), { connectToken: token });
    const second = harness.runtime.handleJoin(new FakeSocket('s2', ORIGIN_A), { connectToken: token });
    const [a, b] = (await Promise.all([first, second])) as [JoinAckLike, JoinAckLike];
    const winners = [a, b].filter((ack) => ack.ok);
    const losers = [a, b].filter((ack) => !ack.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ code: 'AUTH_TOKEN_USED' });
    expect(harness.store.snapshot(INTERNAL_A)?.participants).toHaveLength(1);
  });

  it('a claimed token that fails later is BURNED: the store refusal costs the token', async () => {
    const harness = createHarness();
    // First seat takes the name "Twin".
    expect(
      (await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
        connectToken: mintToken({ name: 'Twin', jti: 'jti_first_twin' }),
      })).ok,
    ).toBe(true);
    // Same display name → store refuses; the jti is already claimed.
    const token = mintToken({ name: 'Twin', jti: 'jti_burn_1' });
    const refused = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: token,
    });
    expect(refused).toMatchObject({ ok: false, code: 'duplicate-display-name' });
    const retry = await joinWith(harness.runtime, new FakeSocket('s3', ORIGIN_A), {
      connectToken: token,
    });
    expect(retry).toMatchObject({ ok: false, code: 'AUTH_TOKEN_USED' });
  });
});

describe('connect join — origin authorization (R7)', () => {
  it('refuses an origin the project did not register, and burns the token doing it', async () => {
    const harness = createHarness();
    const token = mintToken({ jti: 'jti_origin_1' });
    const refused = await joinWith(harness.runtime, new FakeSocket('s1', 'https://evil.example'), {
      connectToken: token,
    });
    expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN_ORIGIN' });
    // Correct origin now — but the token died with the first attempt.
    const retry = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: token,
    });
    expect(retry).toMatchObject({ ok: false, code: 'AUTH_TOKEN_USED' });
  });

  it('a missing Origin is refused unless the project explicitly allows originless', async () => {
    const harness = createHarness();
    // Project A: allowOriginless false → refused.
    const strict = await joinWith(harness.runtime, new FakeSocket('s1'), {
      connectToken: mintToken({ jti: 'jti_originless_a' }),
    });
    expect(strict).toMatchObject({ ok: false, code: 'FORBIDDEN_ORIGIN' });
    // Project B: allowOriginless true → seats.
    const permissive = await joinWith(harness.runtime, new FakeSocket('s2'), {
      connectToken: mintToken({ proj: PROJECT_B, call: PUBLIC_B, jti: 'jti_originless_b' }),
    });
    expect(permissive.ok).toBe(true);
    expect(permissive.snapshot?.callId).toBe(INTERNAL_B);
  });
});

describe('connect join — project scoping, restarts, and structural refusals (R12/R13)', () => {
  it('a cross-project token reads the call as nonexistent', async () => {
    const harness = createHarness();
    // Signed by us, project B claims — naming project A's call.
    const crossProject = await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_B), {
      connectToken: mintToken({ proj: PROJECT_B, call: PUBLIC_A, jti: 'jti_cross_1' }),
    });
    expect(crossProject).toMatchObject({ ok: false, code: 'CALL_NOT_FOUND' });
  });

  it('a token naming an unknown project is FORBIDDEN_PROJECT', async () => {
    const harness = createHarness();
    const unknown = await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
      connectToken: mintToken({ proj: 'proj_nobody000000', jti: 'jti_ghost_1' }),
    });
    expect(unknown).toMatchObject({ ok: false, code: 'FORBIDDEN_PROJECT' });
  });

  it('R13 restart semantics: a fresh live registry refuses outstanding tokens closed', async () => {
    // Same secret and projects — but the live-call map is empty, as after a
    // gateway restart. The token verifies and still dies on membership.
    const restarted = createHarness({ registerLiveCalls: false });
    const refused = await joinWith(restarted.runtime, new FakeSocket('s1', ORIGIN_A), {
      connectToken: mintToken({ jti: 'jti_restart_1' }),
    });
    expect(refused).toMatchObject({ ok: false, code: 'CALL_NOT_FOUND' });
  });

  it('R12 prefix rule: tokenless joins naming connect_* ids are refused regardless of existence', async () => {
    const harness = createHarness();
    for (const callId of [
      INTERNAL_A, // exists
      'connect_alpha000_zzzzzzzzzzzz', // does not exist — same answer
      'CONNECT_lookalike_000000', // case tricks refuse too
    ]) {
      const ack = await joinWith(harness.runtime, new FakeSocket(`s_${callId}`), {
        callId,
        displayName: 'Squatter',
        speakLanguage: 'en',
        hearLanguage: 'en',
        captionsEnabled: true,
        voiceGender: 'male',
        audioMode: 'translated',
      });
      expect(ack).toMatchObject({ ok: false, code: 'invalid-input' });
    }
    // Nothing squatted a seat, and no lookalike call was created.
    expect(harness.store.snapshot(INTERNAL_A)?.participants).toHaveLength(0);
    expect(harness.store.activeCallCount()).toBe(2); // the two preregistered calls only
  });

  it('R12: connectToken + sessionToken together is refused — before the token is burned', async () => {
    const harness = createHarness();
    const token = mintToken({ jti: 'jti_both_1' });
    const refused = await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
      connectToken: token,
      sessionToken: 'some-account-session-token',
    });
    expect(refused).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    // The mistake cost nothing: the same token still joins cleanly.
    const clean = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: token,
    });
    expect(clean.ok).toBe(true);
  });

  it('a runtime without a connect authority refuses every connect join fail-closed', async () => {
    const harness = createHarness();
    const bare = new CallRuntime({
      store: new CallSessionStore(),
      emitToRoom: vi.fn(),
      ingestControl: {
        createSession: vi.fn(async () => {}),
        stopSession: vi.fn(async () => {}),
        deleteSession: vi.fn(async () => {}),
      },
      transcriptionBridge: {
        handleFrame: vi.fn(),
        endSession: vi.fn(),
        cleanupClosedSessions: vi.fn(() => 0),
      },
      createMediaPeers: () => ({
        acceptOffer: vi.fn(async () => ({}) as WebRtcSdpAnswerEnvelope),
        addRemoteCandidate: vi.fn(async () => {}),
        closeSession: vi.fn(),
        getSnapshots: vi.fn(() => []),
      }),
      createReceivePeers: () => ({
        acceptOffer: vi.fn(async () => 'sdp'),
        addRemoteCandidate: vi.fn(async () => {}),
        fanOut: vi.fn(),
        syncSpeakers: vi.fn(),
        trackMapping: vi.fn(() => []),
        closePeer: vi.fn(),
        closeCall: vi.fn(),
        count: vi.fn(() => 0),
      }),
    });
    const refused = await joinWith(bare, new FakeSocket('s1', ORIGIN_A), {
      connectToken: mintToken({ jti: 'jti_noauth_1' }),
    });
    expect(refused).toMatchObject({ ok: false, code: 'AUTH_INVALID_TOKEN' });
    void harness;
  });
});

describe('connect join — one CONNECTED participant per subject (R8)', () => {
  it('refuses a second CONNECTED seat for the same subject, and burns that token', async () => {
    const harness = createHarness();
    expect(
      (await joinWith(harness.runtime, new FakeSocket('s1', ORIGIN_A), {
        connectToken: mintToken({ sub: 'customer_8291', name: 'Ana', jti: 'jti_subject_1' }),
      })).ok,
    ).toBe(true);
    const second = mintToken({ sub: 'customer_8291', name: 'Ana Again', jti: 'jti_subject_2' });
    const refused = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: second,
    });
    expect(refused).toMatchObject({ ok: false, code: 'SUBJECT_ALREADY_ACTIVE' });
    const retry = await joinWith(harness.runtime, new FakeSocket('s3', ORIGIN_A), {
      connectToken: second,
    });
    expect(retry).toMatchObject({ ok: false, code: 'AUTH_TOKEN_USED' });
    // A DIFFERENT subject is not blocked.
    const other = await joinWith(harness.runtime, new FakeSocket('s4', ORIGIN_A), {
      connectToken: mintToken({ sub: 'customer_9000', name: 'Beto', jti: 'jti_subject_3' }),
    });
    expect(other.ok).toBe(true);
  });

  it('a disconnected-in-grace seat does NOT block a fresh join under the same subject', async () => {
    const harness = createHarness();
    const socket1 = new FakeSocket('s1', ORIGIN_A);
    const first = await joinWith(harness.runtime, socket1, {
      connectToken: mintToken({ sub: 'customer_8291', name: 'Ana', jti: 'jti_grace_1' }),
    });
    expect(first.ok).toBe(true);
    // The socket drops; the seat stays for resume, disconnected-in-grace.
    harness.runtime.handleSocketDisconnect(socket1.id);
    const recovered = await joinWith(harness.runtime, new FakeSocket('s2', ORIGIN_A), {
      connectToken: mintToken({ sub: 'customer_8291', name: 'Ana Prime', jti: 'jti_grace_2' }),
    });
    expect(recovered.ok).toBe(true);
    // A fresh participation identity under the same stable subject (R8).
    expect(recovered.participantId).not.toBe(first.participantId);
  });
});

describe('server-authority mode change and end (R4) — the runtime consequences', () => {
  async function seatTwo(harness: ReturnType<typeof createHarness>) {
    const ackA = await joinWith(harness.runtime, new FakeSocket('sA', ORIGIN_A), {
      connectToken: mintToken({ sub: 'sub_a', name: 'Ana', jti: `jti_seat_a_${++mintedSerial}` }),
    });
    const ackB = await joinWith(harness.runtime, new FakeSocket('sB', ORIGIN_A), {
      connectToken: mintToken({
        sub: 'sub_b',
        name: 'Beto',
        jti: `jti_seat_b_${++mintedSerial}`,
        prefs: { speak: 'es', hear: 'es', audioMode: 'translated', captions: true, voiceGender: 'male' },
      }),
    });
    expect(ackA.ok).toBe(true);
    expect(ackB.ok).toBe(true);
    return { ackA, ackB };
  }

  it('applyAuthorityModeChange emits STATE and retires/reapplies ingest work end-to-end', async () => {
    const harness = createHarness();
    await seatTwo(harness);
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBeGreaterThan(0);
    harness.emitToRoom.mockClear();

    const toNormal = await harness.runtime.applyAuthorityModeChange(INTERNAL_A, 'normal');
    expect(toNormal.ok).toBe(true);
    const stateEmits = harness.emitToRoom.mock.calls.filter(
      ([room, event]) => room === callRoom(INTERNAL_A) && event === CALL_EVENTS.STATE,
    );
    expect(stateEmits).toHaveLength(1);
    expect((stateEmits[0]?.[2] as { callMode: string }).callMode).toBe('normal');
    // The engine is off: every ingest session for the call retired.
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBe(0);
    expect(harness.ingestControl.stopSession).toHaveBeenCalled();

    harness.emitToRoom.mockClear();
    harness.ingestControl.createSession.mockClear();
    const backToTranslated = await harness.runtime.applyAuthorityModeChange(INTERNAL_A, 'translated');
    expect(backToTranslated.ok).toBe(true);
    const restateEmits = harness.emitToRoom.mock.calls.filter(
      ([room, event]) => room === callRoom(INTERNAL_A) && event === CALL_EVENTS.STATE,
    );
    expect((restateEmits[0]?.[2] as { callMode: string }).callMode).toBe('translated');
    // Fresh plans flowed through the same path a join uses.
    expect(harness.ingestControl.createSession).toHaveBeenCalled();
    expect(harness.runtime.getDiagnostics().ingestSessionCount).toBeGreaterThan(0);

    // Unknown call / no-op semantics.
    expect(await harness.runtime.applyAuthorityModeChange('connect_alpha000_missing00000', 'normal')).toMatchObject({
      ok: false,
      reason: 'unknown-call',
    });
    const unchanged = await harness.runtime.applyAuthorityModeChange(INTERNAL_A, 'translated');
    expect(unchanged).toMatchObject({ ok: true, changed: false });
  });

  it('endCallByAuthority emits one final STATE (ended) and tears down every seat and session', async () => {
    const harness = createHarness();
    await seatTwo(harness);
    harness.emitToRoom.mockClear();

    const ended = await harness.runtime.endCallByAuthority(INTERNAL_A);
    expect(ended.ok).toBe(true);
    const stateEmit = harness.emitToRoom.mock.calls.find(
      ([room, event]) => room === callRoom(INTERNAL_A) && event === CALL_EVENTS.STATE,
    );
    expect((stateEmit?.[2] as { state: string; participants: unknown[] }).state).toBe('ended');
    expect((stateEmit?.[2] as { participants: unknown[] }).participants).toHaveLength(2);

    const diagnostics = harness.runtime.getDiagnostics();
    expect(diagnostics.participantCount).toBe(0);
    expect(diagnostics.ingestSessionCount).toBe(0);
    expect(diagnostics.socketBindingCount).toBe(0);
    expect(harness.store.snapshot(INTERNAL_A)).toBeNull();
    expect(harness.receivePeers.closeCall).toHaveBeenCalledWith(INTERNAL_A, expect.any(String));
    // Ending twice reports unknown-call — the call is gone whole.
    expect(await harness.runtime.endCallByAuthority(INTERNAL_A)).toEqual({ ok: false });
  });
});

describe('socket CORS origin policy and config surface (FE3)', () => {
  it('allows dev origins ∪ live project origins, refuses others, and passes non-browser clients', () => {
    const policy = createSocketOriginPolicy(['http://localhost:5175'], () => [ORIGIN_A]);
    const decisions = new Map<string | undefined, boolean | undefined>();
    const decide = (origin: string | undefined) =>
      policy(origin, (error, allow) => {
        expect(error).toBeNull();
        decisions.set(origin, allow);
      });
    decide('http://localhost:5175');
    decide(ORIGIN_A);
    decide('https://evil.example');
    decide(undefined);
    expect(decisions.get('http://localhost:5175')).toBe(true);
    expect(decisions.get(ORIGIN_A)).toBe(true);
    expect(decisions.get('https://evil.example')).toBe(false);
    expect(decisions.get(undefined)).toBe(true);
  });

  it('loadConfig defaults the Connect settings and honours overrides', () => {
    const original = { ...process.env };
    try {
      process.env['CONNECT_AUTH_SECRET'] = '';
      delete process.env['CONNECT_PROJECTS_PATH'];
      const defaults = loadConfig();
      expect(defaults.connectAuthSecret).toBeNull();
      expect(defaults.connectProjectsPath).toBe('./connect-projects.json');
      process.env['CONNECT_AUTH_SECRET'] = SECRET_STRING;
      process.env['CONNECT_PROJECTS_PATH'] = './somewhere/registry.json';
      const overridden = loadConfig();
      expect(overridden.connectAuthSecret).toBe(SECRET_STRING);
      expect(overridden.connectProjectsPath).toBe('./somewhere/registry.json');
    } finally {
      process.env = { ...original };
    }
  });
});

describe('end-to-end: /v1 create → mint → socket join → authority mode change → end', () => {
  let server: Server;
  let baseUrl: string;
  let tempDir: string;
  let clients: ClientSocket[];

  beforeEach(async () => {
    tempDir = mkdtempSync(joinPath(tmpdir(), 'connect-e2e-'));
    const registryPath = joinPath(tempDir, 'connect-projects.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            projectId: PROJECT_A,
            name: 'Alpha',
            keyHash: createHash('sha256').update(RAW_KEY, 'utf8').digest('hex'),
            allowedOrigins: [ORIGIN_A],
            allowOriginless: false,
            createdAt: '2026-08-18T00:00:00.000Z',
            active: true,
          },
        ],
      }),
      'utf8',
    );
    // The index.ts wiring, in miniature: app first, gateway after, lazy router.
    let gateway: Gateway;
    const app = createApp({ connectV1Router: () => gateway.getConnectV1Router() });
    server = createServer(app);
    gateway = new Gateway(server, ['http://localhost:5175'], {
      connect: { authSecret: SECRET_STRING, projectsPath: registryPath },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  function callClient(): ClientSocket {
    const socket = connectClient(baseUrl, {
      query: { role: 'call-participant' },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: ORIGIN_A },
    });
    clients.push(socket);
    return socket;
  }

  function waitForConnect(socket: ClientSocket): Promise<void> {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }

  function waitForEvent<T>(socket: ClientSocket, eventName: string, predicate: (payload: T) => boolean): Promise<T> {
    return new Promise((resolve) => {
      const handler = (payload: T) => {
        if (!predicate(payload)) return;
        socket.off(eventName, handler);
        resolve(payload);
      };
      socket.on(eventName, handler);
    });
  }

  function emitJoin(socket: ClientSocket, payload: Record<string, unknown>): Promise<JoinAckLike> {
    return new Promise((resolve) => {
      socket.emit(CALL_EVENTS.JOIN, payload, (ack: JoinAckLike) => resolve(ack));
    });
  }

  it('runs the whole loop against one real gateway process', async () => {
    // 1. Partner server creates a call.
    const created = await request(baseUrl)
      .post('/v1/calls')
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .send({ type: 'personal', mode: 'translated', metadata: { ticket: 'T-1' } });
    expect(created.status).toBe(201);
    const publicCallId = (created.body as { callId: string }).callId;
    expect(publicCallId).toMatch(/^vc_/);

    // 2. Partner server mints a join token for its customer.
    const minted = await request(baseUrl)
      .post(`/v1/calls/${publicCallId}/join-tokens`)
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .send({
        participant: {
          subject: 'customer_8291',
          displayName: 'Ana',
          speakLanguage: 'en',
          hearLanguage: 'en',
        },
      });
    expect(minted.status).toBe(201);
    const token = (minted.body as { token: string }).token;

    // 3. The browser joins with ONLY the token (origin rides the handshake).
    const socket = callClient();
    await waitForConnect(socket);
    const ack = await emitJoin(socket, { connectToken: token });
    expect(ack.ok).toBe(true);
    expect(ack.snapshot?.participants[0]?.subject).toBe('customer_8291');
    const internalCallId = ack.snapshot?.callId as string;
    expect(internalCallId).toMatch(/^connect_/);

    // A second use of the same token dies (R6), even from a fresh socket.
    const socket2 = callClient();
    await waitForConnect(socket2);
    expect(await emitJoin(socket2, { connectToken: token })).toMatchObject({
      ok: false,
      code: 'AUTH_TOKEN_USED',
    });
    // And a raw join naming the internal id without a token dies structurally (R12).
    expect(
      await emitJoin(socket2, {
        callId: internalCallId,
        displayName: 'Squatter',
        speakLanguage: 'en',
        hearLanguage: 'en',
        captionsEnabled: true,
        voiceGender: 'male',
        audioMode: 'translated',
      }),
    ).toMatchObject({ ok: false, code: 'invalid-input' });

    // 4. /v1 state shows the seat, with both identities and no internal ids.
    const state = await request(baseUrl)
      .get(`/v1/calls/${publicCallId}/state`)
      .set('Authorization', `Bearer ${RAW_KEY}`);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      callId: publicCallId,
      type: 'personal',
      mode: 'translated',
      participants: [
        {
          participantId: ack.participantId,
          subject: 'customer_8291',
          displayName: 'Ana',
          connected: true,
        },
      ],
    });
    expect(JSON.stringify(state.body)).not.toContain('connect_');

    // 5. Project authority flips the mode; the CLIENT sees STATE change (R4).
    const modeChanged = waitForEvent<{ callMode: string }>(
      socket,
      CALL_EVENTS.STATE,
      (payload) => payload.callMode === 'normal',
    );
    const patched = await request(baseUrl)
      .patch(`/v1/calls/${publicCallId}`)
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .send({ mode: 'normal' });
    expect(patched.status).toBe(200);
    expect((patched.body as { mode: string }).mode).toBe('normal');
    await modeChanged;

    // 6. Project authority ends the call; the client sees the final STATE.
    const endedState = waitForEvent<{ state: string }>(
      socket,
      CALL_EVENTS.STATE,
      (payload) => payload.state === 'ended',
    );
    const ended = await request(baseUrl)
      .post(`/v1/calls/${publicCallId}/end`)
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .send({});
    expect(ended.status).toBe(200);
    expect((ended.body as { ended?: boolean }).ended).toBe(true);
    await endedState;

    // 7. Post-end: reads say ended, fresh tokens are refused at mint time.
    const after = await request(baseUrl)
      .get(`/v1/calls/${publicCallId}`)
      .set('Authorization', `Bearer ${RAW_KEY}`);
    expect((after.body as { ended?: boolean }).ended).toBe(true);
    const mintAfter = await request(baseUrl)
      .post(`/v1/calls/${publicCallId}/join-tokens`)
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .send({
        participant: { subject: 's', displayName: 'B', speakLanguage: 'en', hearLanguage: 'en' },
      });
    expect(mintAfter.status).toBe(410);
    expect((mintAfter.body as { error: { code: string } }).error.code).toBe('CALL_ENDED');
  }, 20_000);
});

describe('native joins cannot forge a partner subject (review fix)', () => {
  it('strips a wire-supplied subject before the store ever sees it', async () => {
    const harness = createHarness();
    const socket = new FakeSocket('socket-forge');
    const ack = await joinWith(harness.runtime, socket, {
      callId: 'native-forge',
      displayName: 'Eve',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
      // The forged partner identity a native client must never be able to
      // broadcast: subject arrives ONLY through a verified connect token.
      subject: 'customer_8291',
    });

    expect(ack.ok).toBe(true);
    const snapshot = harness.store.snapshot('native-forge');
    expect(snapshot).not.toBeNull();
    for (const participant of snapshot!.participants) {
      expect(participant.subject).toBeUndefined();
    }
    expect(JSON.stringify(snapshot)).not.toContain('customer_8291');
  });
});
