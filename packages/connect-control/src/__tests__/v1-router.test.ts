/** @owner masterzee001 */
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  CallResourceSchema,
  CallStateResponseSchema,
  isRetryableConnectError,
  type ConnectErrorCode,
} from '@videofy-live/connect-contracts';
import type {
  ConnectCallFacade,
  ConnectFacadeParticipant,
} from '../connect-facade.js';
import { verifyConnectJoinToken } from '../join-token.js';
import {
  ConnectLiveCallRegistry,
  ConnectProjectRegistry,
  type ConnectProjectRecord,
} from '../project-registry.js';
import { createConnectV1Router } from '../v1-router.js';

const KEY_A = 'vfk_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'vfk_dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_INACTIVE = 'vfk_dev_cccccccccccccccccccccccccccccccc';
const SECRET = Buffer.from('connect-secret-0123456789abcdef0123456789abcdef', 'utf8');
const T0 = Date.parse('2026-08-18T12:00:00.000Z');

function hashOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function projectRecord(overrides: Partial<ConnectProjectRecord>): ConnectProjectRecord {
  return {
    projectId: 'proj_abc123def456',
    name: 'Acme Support',
    keyHash: hashOf(KEY_A),
    allowedOrigins: ['https://support.acme.example'],
    allowOriginless: false,
    createdAt: '2026-08-18T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

interface FakeCall {
  callType: 'personal' | 'conference';
  callMode: 'normal' | 'translated';
  participants: ConnectFacadeParticipant[];
}

function createHarness(options: {
  rateCapacity?: number;
  rateRefillPerSecond?: number;
  tokenSecret?: Buffer | null;
  registryDisabled?: boolean;
} = {}) {
  const registry = options.registryDisabled
    ? null
    : new ConnectProjectRegistry([
        projectRecord({}),
        projectRecord({
          projectId: 'proj_other0000000',
          name: 'Other',
          keyHash: hashOf(KEY_B),
          allowedOrigins: ['https://other.example'],
        }),
        projectRecord({
          projectId: 'proj_gone00000000',
          name: 'Gone',
          keyHash: hashOf(KEY_INACTIVE),
          active: false,
        }),
      ]);
  const liveCalls = new ConnectLiveCallRegistry();
  const calls = new Map<string, FakeCall>();
  const facade: ConnectCallFacade = {
    preregisterCall: vi.fn((internalCallId, input) => {
      if (calls.has(internalCallId)) return { ok: false as const, reason: 'call-already-exists' as const };
      calls.set(internalCallId, {
        callType: input.callType,
        callMode: input.callMode,
        participants: [],
      });
      return { ok: true as const };
    }),
    snapshot: (internalCallId) => calls.get(internalCallId) ?? null,
    applyAuthorityModeChange: vi.fn(async (internalCallId, mode) => {
      const call = calls.get(internalCallId);
      if (!call) return { ok: false as const, reason: 'unknown-call' as const };
      const changed = call.callMode !== mode;
      call.callMode = mode;
      return { ok: true as const, changed };
    }),
    endCallByAuthority: vi.fn(async (internalCallId) => {
      if (!calls.delete(internalCallId)) return { ok: false as const, reason: 'unknown-call' as const };
      return { ok: true as const };
    }),
  };
  let nowMs = T0;
  let serial = 0;
  const router = createConnectV1Router({
    registry,
    liveCalls,
    facade,
    tokenSecret: options.tokenSecret === undefined ? SECRET : options.tokenSecret,
    nowMs: () => nowMs,
    randomHex: (byteCount) => (++serial).toString(16).padStart(byteCount * 2, '0').slice(-byteCount * 2),
    rateLimit: {
      capacity: options.rateCapacity ?? 100,
      refillPerSecond: options.rateRefillPerSecond ?? 100,
    },
  });
  const app = express();
  app.use('/v1', router);
  return {
    app,
    calls,
    facade,
    liveCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function expectEnvelope(body: unknown, code: ConnectErrorCode): void {
  const envelope = body as { error: { code: string; message: string; requestId: string; retryable: boolean } };
  expect(envelope.error.code).toBe(code);
  expect(envelope.error.requestId.length).toBeGreaterThan(0);
  expect(envelope.error.retryable).toBe(isRetryableConnectError(code));
  expect(envelope.error.message.length).toBeGreaterThan(0);
}

async function createCall(
  harness: ReturnType<typeof createHarness>,
  body: Record<string, unknown> = { type: 'personal', mode: 'translated' },
  key = KEY_A,
) {
  return request(harness.app).post('/v1/calls').set('Authorization', `Bearer ${key}`).send(body);
}

describe('auth and fail-closed states', () => {
  it('refuses a missing, malformed, or unknown bearer key with AUTH_INVALID_KEY', async () => {
    const harness = createHarness();
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic x' }]) {
      const res = await request(harness.app).get('/v1/capabilities').set(headers);
      expect(res.status).toBe(401);
      expectEnvelope(res.body, 'AUTH_INVALID_KEY');
    }
  });

  it('refuses a deactivated project with FORBIDDEN_PROJECT', async () => {
    const harness = createHarness();
    const res = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_INACTIVE}`);
    expect(res.status).toBe(403);
    expectEnvelope(res.body, 'FORBIDDEN_PROJECT');
  });

  it('R12: with no registry file every /v1 route answers 503 UNSUPPORTED_CAPABILITY', async () => {
    const harness = createHarness({ registryDisabled: true });
    for (const path of ['/v1/capabilities', '/v1/calls/vc_0000000000000000']) {
      const res = await request(harness.app).get(path).set('Authorization', `Bearer ${KEY_A}`);
      expect(res.status).toBe(503);
      expectEnvelope(res.body, 'UNSUPPORTED_CAPABILITY');
    }
  });

  it('always answers with an X-Request-Id: echoed when sane, replaced when not', async () => {
    const harness = createHarness();
    const echoed = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('X-Request-Id', 'partner-trace-42');
    expect(echoed.headers['x-request-id']).toBe('partner-trace-42');
    const replaced = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('X-Request-Id', 'bad value with spaces!');
    expect(replaced.headers['x-request-id']).toMatch(/^req_/);
    const missing = await request(harness.app).get('/v1/capabilities');
    expect(missing.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('POST /v1/calls', () => {
  it('creates a call: vc_ public id out, connect_ internal id preregistered with the project tag', async () => {
    const harness = createHarness();
    const res = await createCall(harness, {
      type: 'conference',
      mode: 'translated',
      metadata: { ticket: 'T-1207' },
    });
    expect(res.status).toBe(201);
    const resource = CallResourceSchema.parse(res.body);
    expect(resource.callId).toMatch(/^vc_[A-Za-z0-9]{16}$/);
    expect(resource.type).toBe('conference');
    expect(resource.mode).toBe('translated');
    expect(resource.metadata).toEqual({ ticket: 'T-1207' });
    expect(resource.ended).toBeUndefined();
    // The internal id never crosses the boundary.
    expect(JSON.stringify(res.body)).not.toContain('connect_');
    expect(harness.facade.preregisterCall).toHaveBeenCalledTimes(1);
    const [internalId, input] = (harness.facade.preregisterCall as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { callType: string; callMode: string; projectTag: string }];
    expect(internalId).toMatch(/^connect_abc123de_[0-9a-f]{12}$/);
    expect(input).toEqual({
      callType: 'conference',
      callMode: 'translated',
      projectTag: 'proj_abc123def456',
    });
  });

  it('refuses invalid bodies and oversized metadata with INVALID_REQUEST', async () => {
    const harness = createHarness();
    const bad = await createCall(harness, { type: 'group', mode: 'translated' });
    expect(bad.status).toBe(400);
    expectEnvelope(bad.body, 'INVALID_REQUEST');
    const oversize = await createCall(harness, {
      type: 'personal',
      mode: 'normal',
      metadata: { blob: 'x'.repeat(1100) },
    });
    expect(oversize.status).toBe(400);
    expectEnvelope(oversize.body, 'INVALID_REQUEST');
  });

  it('replays the SAME response for a repeated Idempotency-Key and refuses a changed body', async () => {
    const harness = createHarness();
    const first = await request(harness.app)
      .post('/v1/calls')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Idempotency-Key', 'create-1')
      .send({ type: 'personal', mode: 'translated' });
    expect(first.status).toBe(201);
    const replay = await request(harness.app)
      .post('/v1/calls')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Idempotency-Key', 'create-1')
      .send({ type: 'personal', mode: 'translated' });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body); // same call id — no second call minted
    expect(harness.facade.preregisterCall).toHaveBeenCalledTimes(1);
    const conflict = await request(harness.app)
      .post('/v1/calls')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Idempotency-Key', 'create-1')
      .send({ type: 'conference', mode: 'translated' });
    expect(conflict.status).toBe(409);
    expectEnvelope(conflict.body, 'IDEMPOTENCY_CONFLICT');
  });
});

describe('GET /v1/calls/:id and /state', () => {
  it('reads a call back, refuses unknown ids and other projects’ ids identically', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const ok = await request(harness.app)
      .get(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(ok.status).toBe(200);
    expect(CallResourceSchema.parse(ok.body).callId).toBe(id);
    const unknown = await request(harness.app)
      .get('/v1/calls/vc_ffffffffffffffff')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(unknown.status).toBe(404);
    expectEnvelope(unknown.body, 'CALL_NOT_FOUND');
    const crossProject = await request(harness.app)
      .get(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_B}`);
    expect(crossProject.status).toBe(404);
    expectEnvelope(crossProject.body, 'CALL_NOT_FOUND');
    const garbage = await request(harness.app)
      .get('/v1/calls/connect_abc123de_000000000001')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(garbage.status).toBe(404);
    expectEnvelope(garbage.body, 'CALL_NOT_FOUND');
  });

  it('maps the facade snapshot to public participant state — both identities, no internals', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const internalId = [...harness.calls.keys()][0]!;
    harness.calls.get(internalId)!.participants = [
      {
        participantId: 'participant_1',
        subject: 'customer_8291',
        displayName: 'Ana',
        speakLanguage: 'en',
        hearLanguage: 'es',
        connected: true,
      },
      {
        participantId: 'participant_2',
        subject: 'agent_7',
        displayName: 'Beto',
        speakLanguage: 'es',
        hearLanguage: 'es',
        connected: false,
      },
    ];
    const res = await request(harness.app)
      .get(`/v1/calls/${id}/state`)
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(res.status).toBe(200);
    const state = CallStateResponseSchema.parse(res.body);
    expect(state.callId).toBe(id);
    expect(state.participants).toEqual([
      {
        participantId: 'participant_1',
        subject: 'customer_8291',
        displayName: 'Ana',
        speakLanguage: 'en',
        hearLanguage: 'es',
        connected: true,
      },
      {
        participantId: 'participant_2',
        subject: 'agent_7',
        displayName: 'Beto',
        speakLanguage: 'es',
        hearLanguage: 'es',
        connected: false,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('connect_');
  });

  it('a call the store no longer knows reads as ended (native death reconciliation)', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    harness.calls.clear(); // the call died with its last seat, without /end
    const resource = await request(harness.app)
      .get(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(resource.status).toBe(200);
    expect((resource.body as { ended?: boolean }).ended).toBe(true);
    const state = await request(harness.app)
      .get(`/v1/calls/${id}/state`)
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(state.status).toBe(410);
    expectEnvelope(state.body, 'CALL_ENDED');
  });
});

describe('POST /v1/calls/:id/join-tokens', () => {
  it('mints a verifiable single-use token carrying the PUBLIC id and resolved defaults', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const res = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        participant: {
          subject: 'customer_8291',
          displayName: 'Ana',
          speakLanguage: 'en',
          hearLanguage: 'es',
        },
      });
    expect(res.status).toBe(201);
    const body = res.body as {
      token: string;
      expiresAt: string;
      participant: Record<string, unknown>;
    };
    expect(body.expiresAt).toBe(new Date(T0 + 300_000).toISOString());
    expect(body.participant).toEqual({
      subject: 'customer_8291',
      displayName: 'Ana',
      speakLanguage: 'en',
      hearLanguage: 'es',
      audioMode: 'translated',
      captionsEnabled: true,
      voiceGender: 'female',
    });
    const verified = verifyConnectJoinToken({
      secret: SECRET,
      token: body.token,
      nowSeconds: Math.floor(T0 / 1000) + 1,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.call).toBe(id); // public id, never internal
    expect(verified.claims.proj).toBe('proj_abc123def456');
    expect(verified.claims.sub).toBe('customer_8291');
    expect(verified.claims.prefs).toEqual({
      speak: 'en',
      hear: 'es',
      audioMode: 'translated',
      captions: true,
      voiceGender: 'female',
    });
  });

  it('honours expiresInSeconds up to 900 and refuses beyond via schema', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const participant = {
      subject: 's',
      displayName: 'Ana',
      speakLanguage: 'en',
      hearLanguage: 'en',
    };
    const ok = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ participant, expiresInSeconds: 900 });
    expect(ok.status).toBe(201);
    expect((ok.body as { expiresAt: string }).expiresAt).toBe(new Date(T0 + 900_000).toISOString());
    const over = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ participant, expiresInSeconds: 901 });
    expect(over.status).toBe(400);
    expectEnvelope(over.body, 'INVALID_REQUEST');
  });

  it('refuses a well-formed but unsupported language with INVALID_LANGUAGE', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const res = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        participant: { subject: 's', displayName: 'Ana', speakLanguage: 'de', hearLanguage: 'en' },
      });
    expect(res.status).toBe(400);
    expectEnvelope(res.body, 'INVALID_LANGUAGE');
  });

  it('answers 503 UNSUPPORTED_CAPABILITY when CONNECT_AUTH_SECRET is unusable (R12)', async () => {
    const harness = createHarness({ tokenSecret: null });
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const res = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        participant: { subject: 's', displayName: 'Ana', speakLanguage: 'en', hearLanguage: 'en' },
      });
    expect(res.status).toBe(503);
    expectEnvelope(res.body, 'UNSUPPORTED_CAPABILITY');
  });
});

describe('PATCH /v1/calls/:id and POST /v1/calls/:id/end (R4 project authority)', () => {
  it('changes mode through the facade and reflects it in the resource', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const res = await request(harness.app)
      .patch(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ mode: 'normal' });
    expect(res.status).toBe(200);
    expect((res.body as { mode: string }).mode).toBe('normal');
    expect(harness.facade.applyAuthorityModeChange).toHaveBeenCalledWith(
      expect.stringMatching(/^connect_/),
      'normal',
    );
    const invalid = await request(harness.app)
      .patch(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ mode: 'loud' });
    expect(invalid.status).toBe(400);
    expectEnvelope(invalid.body, 'INVALID_REQUEST');
  });

  it('ends a call through the facade, idempotently, and gates later mutations on CALL_ENDED', async () => {
    const harness = createHarness();
    const created = await createCall(harness);
    const id = (created.body as { callId: string }).callId;
    const first = await request(harness.app)
      .post(`/v1/calls/${id}/end`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({});
    expect(first.status).toBe(200);
    expect((first.body as { ended?: boolean }).ended).toBe(true);
    expect(harness.facade.endCallByAuthority).toHaveBeenCalledTimes(1);
    const again = await request(harness.app)
      .post(`/v1/calls/${id}/end`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({});
    expect(again.status).toBe(200);
    expect((again.body as { ended?: boolean }).ended).toBe(true);
    expect(harness.facade.endCallByAuthority).toHaveBeenCalledTimes(1); // idempotent replay, no re-teardown
    const patchAfter = await request(harness.app)
      .patch(`/v1/calls/${id}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ mode: 'normal' });
    expect(patchAfter.status).toBe(410);
    expectEnvelope(patchAfter.body, 'CALL_ENDED');
    const tokensAfter = await request(harness.app)
      .post(`/v1/calls/${id}/join-tokens`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        participant: { subject: 's', displayName: 'A', speakLanguage: 'en', hearLanguage: 'en' },
      });
    expect(tokensAfter.status).toBe(410);
    expectEnvelope(tokensAfter.body, 'CALL_ENDED');
  });
});

describe('GET /v1/capabilities (R9 exact)', () => {
  it('returns exactly the locked shape', async () => {
    const harness = createHarness();
    const res = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      languages: ['en', 'es', 'fr'],
      limits: { personalParticipants: 2, conferenceParticipants: 4 },
      features: {
        personalCall: true,
        conference: true,
        video: true,
        translatedCalls: true,
        personalVoice: false,
      },
    });
  });
});

describe('rate limiting, CORS decoration, and envelope hygiene', () => {
  it('drains the per-project bucket, answers 429 RATE_LIMITED with headers, and refills over time', async () => {
    const harness = createHarness({ rateCapacity: 3, rateRefillPerSecond: 1 });
    for (let i = 0; i < 3; i++) {
      const ok = await request(harness.app)
        .get('/v1/capabilities')
        .set('Authorization', `Bearer ${KEY_A}`);
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
    }
    const limited = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(limited.status).toBe(429);
    expectEnvelope(limited.body, 'RATE_LIMITED');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another project's bucket is untouched.
    const otherProject = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_B}`);
    expect(otherProject.status).toBe(200);
    harness.advance(2_000);
    const refilled = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(refilled.status).toBe(200);
  });

  it('reflects only origins the authenticated project registered', async () => {
    const harness = createHarness();
    const allowed = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Origin', 'https://support.acme.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://support.acme.example');
    const foreign = await request(harness.app)
      .get('/v1/capabilities')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Origin', 'https://other.example'); // registered — but to the OTHER project
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers unknown /v1 paths and malformed JSON with proper envelopes', async () => {
    const harness = createHarness();
    const unknown = await request(harness.app)
      .get('/v1/no-such-endpoint')
      .set('Authorization', `Bearer ${KEY_A}`);
    expect(unknown.status).toBe(404);
    expectEnvelope(unknown.body, 'INVALID_REQUEST');
    const badJson = await request(harness.app)
      .post('/v1/calls')
      .set('Authorization', `Bearer ${KEY_A}`)
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(badJson.status).toBe(400);
    expectEnvelope(badJson.body, 'INVALID_REQUEST');
  });
});
