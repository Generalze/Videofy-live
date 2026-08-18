/** @owner masterzee001 */
/**
 * Injected-fetch coverage of every SDK method: wire shape (URL, method,
 * headers, body), response decoding, error-envelope surfacing with retryable
 * passthrough, malformed-response refusal, idempotency-key handling, and the
 * client-side TTL bounds.
 */
import { describe, expect, it } from 'vitest';
import {
  VideofyApiError,
  VideofyContractError,
  VideofyInputError,
  createVideofyConnect,
} from '../index.js';
import type {
  CallMode,
  CreateCallInput,
  VideofyConnectClient,
  VideofyFetchRequestInit,
  VideofyFetchResponse,
} from '../index.js';
import {
  API_KEY,
  BASE_URL,
  CALL_ID,
  CALL_RESOURCE,
  CAPABILITIES_BODY,
  JOIN_TOKEN_BODY,
  PARTICIPANT_INPUT,
  STATE_BODY,
  createFetchFake,
  envelope,
  jsonResponse,
  textResponse,
} from './helpers.js';
import type { RecordedRequest } from './helpers.js';

function makeClient(...responses: VideofyFetchResponse[]): {
  client: VideofyConnectClient;
  requests: RecordedRequest[];
} {
  const fake = createFetchFake(...responses);
  const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
  return { client, requests: fake.requests };
}

async function captureRejection<T extends Error>(
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as T;
  }
  throw new Error('expected the promise to reject');
}

function parsedBody(request: RecordedRequest): Record<string, unknown> {
  if (request.init.body === undefined) throw new Error('expected a request body');
  return JSON.parse(request.init.body) as Record<string, unknown>;
}

interface MethodCase {
  name: string;
  invoke: (client: VideofyConnectClient) => Promise<unknown>;
  method: string;
  path: string;
  okBody: unknown;
}

const METHOD_CASES: MethodCase[] = [
  {
    name: 'calls.create',
    invoke: (client) => client.calls.create({ type: 'personal', mode: 'normal' }),
    method: 'POST',
    path: '/v1/calls',
    okBody: { ...CALL_RESOURCE, mode: 'normal' },
  },
  {
    name: 'calls.retrieve',
    invoke: (client) => client.calls.retrieve(CALL_ID),
    method: 'GET',
    path: `/v1/calls/${CALL_ID}`,
    okBody: CALL_RESOURCE,
  },
  {
    name: 'calls.state',
    invoke: (client) => client.calls.state(CALL_ID),
    method: 'GET',
    path: `/v1/calls/${CALL_ID}/state`,
    okBody: STATE_BODY,
  },
  {
    name: 'calls.setMode',
    invoke: (client) => client.calls.setMode(CALL_ID, 'normal'),
    method: 'PATCH',
    path: `/v1/calls/${CALL_ID}`,
    okBody: { ...CALL_RESOURCE, mode: 'normal' },
  },
  {
    name: 'calls.end',
    invoke: (client) => client.calls.end(CALL_ID),
    method: 'POST',
    path: `/v1/calls/${CALL_ID}/end`,
    okBody: { ...CALL_RESOURCE, ended: true },
  },
  {
    name: 'joinTokens.create',
    invoke: (client) => client.joinTokens.create(CALL_ID, { participant: PARTICIPANT_INPUT }),
    method: 'POST',
    path: `/v1/calls/${CALL_ID}/join-tokens`,
    okBody: JOIN_TOKEN_BODY,
  },
  {
    name: 'capabilities',
    invoke: (client) => client.capabilities(),
    method: 'GET',
    path: '/v1/capabilities',
    okBody: CAPABILITIES_BODY,
  },
];

describe('createVideofyConnect configuration', () => {
  it('refuses a missing or empty apiKey before doing anything else', () => {
    expect(() =>
      createVideofyConnect({ apiKey: '', baseUrl: BASE_URL }),
    ).toThrowError(VideofyInputError);
    expect(() =>
      createVideofyConnect({ baseUrl: BASE_URL } as unknown as Parameters<
        typeof createVideofyConnect
      >[0]),
    ).toThrowError(VideofyInputError);
  });

  it('refuses a missing or blank baseUrl', () => {
    expect(() => createVideofyConnect({ apiKey: API_KEY, baseUrl: '   ' })).toThrowError(
      VideofyInputError,
    );
  });

  it('trims trailing slashes from baseUrl so /v1 appears exactly once', async () => {
    const fake = createFetchFake(jsonResponse(200, CAPABILITIES_BODY));
    const client = createVideofyConnect({
      apiKey: API_KEY,
      baseUrl: `${BASE_URL}///`,
      fetch: fake.fetch,
    });
    await client.capabilities();
    expect(fake.requests[0]?.url).toBe(`${BASE_URL}/v1/capabilities`);
  });

  it('falls back to globalThis.fetch when no fetch is injected', async () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    const seen: RecordedRequest[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (
      url: string,
      init: VideofyFetchRequestInit,
    ) => {
      seen.push({ url, init });
      return jsonResponse(200, CAPABILITIES_BODY);
    };
    try {
      const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL });
      const capabilities = await client.capabilities();
      expect(capabilities.features.personalVoice).toBe(false);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(`${BASE_URL}/v1/capabilities`);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it('refuses construction when neither injected nor global fetch exists', () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL })).toThrowError(
        VideofyInputError,
      );
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});

describe('wire shape per method', () => {
  for (const methodCase of METHOD_CASES) {
    it(`${methodCase.name} sends ${methodCase.method} ${methodCase.path} with auth headers`, async () => {
      const { client, requests } = makeClient(jsonResponse(200, methodCase.okBody));
      await methodCase.invoke(client);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe(`${BASE_URL}${methodCase.path}`);
      expect(request.init.method).toBe(methodCase.method);
      expect(request.init.headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(request.init.headers['accept']).toBe('application/json');
      if (request.init.body !== undefined) {
        expect(request.init.headers['content-type']).toBe('application/json');
      }
    });
  }
});

describe('calls.create', () => {
  it('sends the validated body and returns the parsed call', async () => {
    const metadata = { orderId: 'ord_1', region: 'eu' };
    const { client, requests } = makeClient(jsonResponse(201, { ...CALL_RESOURCE, metadata }));
    const call = await client.calls.create({ type: 'personal', mode: 'translated', metadata });
    expect(parsedBody(requests[0]!)).toEqual({ type: 'personal', mode: 'translated', metadata });
    expect(call).toEqual({
      callId: CALL_ID,
      type: 'personal',
      mode: 'translated',
      createdAt: CALL_RESOURCE.createdAt,
      metadata,
    });
  });

  it('sends the Idempotency-Key header when provided', async () => {
    const { client, requests } = makeClient(jsonResponse(201, CALL_RESOURCE));
    await client.calls.create({ type: 'personal', mode: 'translated' }, { idempotencyKey: 'idem-1' });
    expect(requests[0]?.init.headers['Idempotency-Key']).toBe('idem-1');
  });

  it('omits the Idempotency-Key header when not provided', async () => {
    const { client, requests } = makeClient(jsonResponse(201, CALL_RESOURCE));
    await client.calls.create({ type: 'personal', mode: 'translated' });
    expect(requests[0]?.init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('refuses an empty idempotencyKey without calling fetch', async () => {
    const { client, requests } = makeClient();
    await captureRejection(
      client.calls.create({ type: 'personal', mode: 'translated' }, { idempotencyKey: '' }),
      VideofyInputError,
    );
    expect(requests).toHaveLength(0);
  });

  it('refuses an unknown call type client-side', async () => {
    const { client, requests } = makeClient();
    const error = await captureRejection(
      client.calls.create({ type: 'webinar', mode: 'normal' } as unknown as CreateCallInput),
      VideofyInputError,
    );
    expect(error.issues.join('\n')).toContain('type');
    expect(requests).toHaveLength(0);
  });

  it('refuses an extra unknown key client-side (strict contract)', async () => {
    const { client, requests } = makeClient();
    await captureRejection(
      client.calls.create({
        type: 'personal',
        mode: 'normal',
        webhookUrl: 'https://x.test',
      } as unknown as CreateCallInput),
      VideofyInputError,
    );
    expect(requests).toHaveLength(0);
  });

  it('refuses metadata over 1024 serialized bytes client-side', async () => {
    const { client, requests } = makeClient();
    await captureRejection(
      client.calls.create({
        type: 'personal',
        mode: 'normal',
        metadata: { blob: 'x'.repeat(1100) },
      }),
      VideofyInputError,
    );
    expect(requests).toHaveLength(0);
  });
});

describe('calls.retrieve and call-id validation', () => {
  it('returns the parsed call including the ended flag', async () => {
    const { client } = makeClient(jsonResponse(200, { ...CALL_RESOURCE, ended: true }));
    const call = await client.calls.retrieve(CALL_ID);
    expect(call.ended).toBe(true);
    expect(call.callId).toBe(CALL_ID);
  });

  it('sends no body and no content-type on GET', async () => {
    const { client, requests } = makeClient(jsonResponse(200, CALL_RESOURCE));
    await client.calls.retrieve(CALL_ID);
    expect(requests[0]?.init.body).toBeUndefined();
    expect(requests[0]?.init.headers).not.toHaveProperty('content-type');
  });

  it('refuses malformed call ids locally, so nothing odd can reach the URL', async () => {
    const { client, requests } = makeClient();
    const badIds = [
      'vc_short',
      'connect_proj_abcdef123456',
      '../../v1/secrets',
      `vc_0123456789abcde/`,
      `${CALL_ID}extra`,
      '',
    ];
    for (const badId of badIds) {
      await captureRejection(client.calls.retrieve(badId), VideofyInputError);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('calls.state', () => {
  it('maps the participant roster faithfully', async () => {
    const { client } = makeClient(jsonResponse(200, STATE_BODY));
    const state = await client.calls.state(CALL_ID);
    expect(state).toEqual(STATE_BODY);
  });

  it('rejects a participant entry missing subject as off-contract', async () => {
    const broken = {
      ...STATE_BODY,
      participants: [
        {
          participantId: 'participant_1',
          displayName: 'Ada',
          speakLanguage: 'en',
          hearLanguage: 'es',
          connected: true,
        },
      ],
    };
    const { client } = makeClient(jsonResponse(200, broken));
    const error = await captureRejection(client.calls.state(CALL_ID), VideofyContractError);
    expect(error.issues.join('\n')).toContain('subject');
  });
});

describe('calls.setMode', () => {
  it('sends PATCH with the validated mode body', async () => {
    const { client, requests } = makeClient(jsonResponse(200, { ...CALL_RESOURCE, mode: 'normal' }));
    const call = await client.calls.setMode(CALL_ID, 'normal');
    expect(parsedBody(requests[0]!)).toEqual({ mode: 'normal' });
    expect(call.mode).toBe('normal');
  });

  it('refuses an unknown mode client-side', async () => {
    const { client, requests } = makeClient();
    await captureRejection(
      client.calls.setMode(CALL_ID, 'loud' as unknown as CallMode),
      VideofyInputError,
    );
    expect(requests).toHaveLength(0);
  });
});

describe('calls.end', () => {
  it('sends POST with no body and no content-type', async () => {
    const { client, requests } = makeClient(jsonResponse(200, { ...CALL_RESOURCE, ended: true }));
    const call = await client.calls.end(CALL_ID);
    expect(requests[0]?.init.body).toBeUndefined();
    expect(requests[0]?.init.headers).not.toHaveProperty('content-type');
    expect(call.ended).toBe(true);
  });

  it('supports an idempotency key like the other POSTs', async () => {
    const { client, requests } = makeClient(jsonResponse(200, { ...CALL_RESOURCE, ended: true }));
    await client.calls.end(CALL_ID, { idempotencyKey: 'end-once' });
    expect(requests[0]?.init.headers['Idempotency-Key']).toBe('end-once');
  });
});

describe('joinTokens.create', () => {
  it('applies the contract defaults in the wire body (audioMode, captions, voiceGender)', async () => {
    const { client, requests } = makeClient(jsonResponse(201, JOIN_TOKEN_BODY));
    await client.joinTokens.create(CALL_ID, { participant: PARTICIPANT_INPUT });
    const body = parsedBody(requests[0]!);
    expect(body['participant']).toEqual({
      ...PARTICIPANT_INPUT,
      audioMode: 'translated',
      captionsEnabled: true,
      voiceGender: 'female',
    });
    expect(body).not.toHaveProperty('expiresInSeconds');
  });

  it('preserves explicit participant preferences instead of the defaults', async () => {
    const { client, requests } = makeClient(jsonResponse(201, JOIN_TOKEN_BODY));
    await client.joinTokens.create(CALL_ID, {
      participant: {
        ...PARTICIPANT_INPUT,
        audioMode: 'original',
        captionsEnabled: false,
        voiceGender: 'male',
      },
    });
    const body = parsedBody(requests[0]!) as { participant: Record<string, unknown> };
    expect(body.participant['audioMode']).toBe('original');
    expect(body.participant['captionsEnabled']).toBe(false);
    expect(body.participant['voiceGender']).toBe('male');
  });

  it('passes boundary TTLs 1 and 900 through to the wire', async () => {
    const { client, requests } = makeClient(
      jsonResponse(201, JOIN_TOKEN_BODY),
      jsonResponse(201, JOIN_TOKEN_BODY),
    );
    await client.joinTokens.create(CALL_ID, { participant: PARTICIPANT_INPUT, expiresInSeconds: 1 });
    await client.joinTokens.create(CALL_ID, {
      participant: PARTICIPANT_INPUT,
      expiresInSeconds: 900,
    });
    expect(parsedBody(requests[0]!)['expiresInSeconds']).toBe(1);
    expect(parsedBody(requests[1]!)['expiresInSeconds']).toBe(900);
  });

  it('refuses TTLs beyond 1..900 (and non-integers) client-side, never sending them', async () => {
    const { client, requests } = makeClient();
    for (const expiresInSeconds of [0, 901, 90000, -5, 300.5]) {
      const error = await captureRejection(
        client.joinTokens.create(CALL_ID, { participant: PARTICIPANT_INPUT, expiresInSeconds }),
        VideofyInputError,
      );
      expect(error.issues.join('\n')).toContain('expiresInSeconds');
    }
    expect(requests).toHaveLength(0);
  });

  it('enforces subject and displayName bounds client-side', async () => {
    const { client, requests } = makeClient();
    await captureRejection(
      client.joinTokens.create(CALL_ID, {
        participant: { ...PARTICIPANT_INPUT, subject: 'x'.repeat(129) },
      }),
      VideofyInputError,
    );
    await captureRejection(
      client.joinTokens.create(CALL_ID, {
        participant: { ...PARTICIPANT_INPUT, displayName: '   ' },
      }),
      VideofyInputError,
    );
    expect(requests).toHaveLength(0);
  });

  it('trims the displayName before sending, matching server parsing', async () => {
    const { client, requests } = makeClient(jsonResponse(201, JOIN_TOKEN_BODY));
    await client.joinTokens.create(CALL_ID, {
      participant: { ...PARTICIPANT_INPUT, displayName: '  Ada  ' },
    });
    const body = parsedBody(requests[0]!) as { participant: Record<string, unknown> };
    expect(body.participant['displayName']).toBe('Ada');
  });

  it('supports an idempotency key and returns the token unmodified', async () => {
    const { client, requests } = makeClient(jsonResponse(201, JOIN_TOKEN_BODY));
    const grant = await client.joinTokens.create(
      CALL_ID,
      { participant: PARTICIPANT_INPUT },
      { idempotencyKey: 'mint-1' },
    );
    expect(requests[0]?.init.headers['Idempotency-Key']).toBe('mint-1');
    expect(grant.token).toBe(JOIN_TOKEN_BODY.token);
    expect(grant.expiresAt).toBe(JOIN_TOKEN_BODY.expiresAt);
    expect(grant.participant).toEqual(JOIN_TOKEN_BODY.participant);
  });
});

describe('capabilities', () => {
  it('returns the exact R9 shape', async () => {
    const { client } = makeClient(jsonResponse(200, CAPABILITIES_BODY));
    expect(await client.capabilities()).toEqual(CAPABILITIES_BODY);
  });

  it('rejects capability growth the contract does not know about', async () => {
    const grown = {
      ...CAPABILITIES_BODY,
      features: { ...CAPABILITIES_BODY.features, telepathy: true },
    };
    const { client } = makeClient(jsonResponse(200, grown));
    await captureRejection(client.capabilities(), VideofyContractError);
  });
});

describe('error envelopes become VideofyApiError on every method', () => {
  for (const methodCase of METHOD_CASES) {
    it(`${methodCase.name} surfaces code, requestId, retryable, and status`, async () => {
      const { client } = makeClient(
        jsonResponse(403, envelope('FORBIDDEN_PROJECT', 'This project may not act on that call.', 'req_777', false)),
      );
      const error = await captureRejection(methodCase.invoke(client), VideofyApiError);
      expect(error.code).toBe('FORBIDDEN_PROJECT');
      expect(error.message).toBe('This project may not act on that call.');
      expect(error.requestId).toBe('req_777');
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(403);
    });
  }

  it('passes retryable through verbatim, even when it contradicts the taxonomy', async () => {
    const contradicting = makeClient(
      jsonResponse(404, envelope('CALL_NOT_FOUND', 'No such call.', 'req_1', true)),
    );
    const surprising = await captureRejection(
      contradicting.client.calls.retrieve(CALL_ID),
      VideofyApiError,
    );
    expect(surprising.retryable).toBe(true);

    const honest = makeClient(
      jsonResponse(429, envelope('RATE_LIMITED', 'Slow down.', 'req_2', true)),
    );
    const rateLimited = await captureRejection(honest.client.capabilities(), VideofyApiError);
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.status).toBe(429);
  });

  it('treats an unknown error code as off-contract, not as an api error', async () => {
    const { client } = makeClient(
      jsonResponse(500, envelope('FLYING_SAUCER', 'what', 'req_3', false)),
    );
    const error = await captureRejection(client.capabilities(), VideofyContractError);
    expect(error.status).toBe(500);
  });

  it('treats an envelope with extra keys as off-contract', async () => {
    const bloated = {
      error: { code: 'INTERNAL', message: 'x', requestId: 'r', retryable: true, hint: 'no' },
    };
    const { client } = makeClient(jsonResponse(500, bloated));
    await captureRejection(client.capabilities(), VideofyContractError);
  });

  it('surfaces the X-Request-Id header on non-envelope failures', async () => {
    const { client } = makeClient(
      textResponse(502, '<html>Bad gateway</html>', { 'X-Request-Id': 'req_hdr_9' }),
    );
    const error = await captureRejection(client.capabilities(), VideofyContractError);
    expect(error.status).toBe(502);
    expect(error.requestId).toBe('req_hdr_9');
  });
});

describe('malformed success bodies are refused on every method', () => {
  for (const methodCase of METHOD_CASES) {
    it(`${methodCase.name} throws VideofyContractError on an off-contract 200`, async () => {
      const { client } = makeClient(
        jsonResponse(200, { unexpected: true }, { 'X-Request-Id': 'req_bad' }),
      );
      const error = await captureRejection(methodCase.invoke(client), VideofyContractError);
      expect(error.requestId).toBe('req_bad');
      expect(error.issues.length).toBeGreaterThan(0);
    });
  }

  it('rejects a success body that is not JSON at all', async () => {
    const { client } = makeClient(textResponse(200, 'OK'));
    const error = await captureRejection(client.capabilities(), VideofyContractError);
    expect(error.message).toContain('not valid JSON');
  });

  it('rejects a call resource carrying an extra key', async () => {
    const { client } = makeClient(jsonResponse(200, { ...CALL_RESOURCE, internalNote: 'x' }));
    await captureRejection(client.calls.retrieve(CALL_ID), VideofyContractError);
  });

  it('rejects a response naming a non-public call id', async () => {
    const { client } = makeClient(
      jsonResponse(200, { ...CALL_RESOURCE, callId: 'connect_abcdefgh_123456789012' }),
    );
    const error = await captureRejection(client.calls.retrieve(CALL_ID), VideofyContractError);
    expect(error.issues.join('\n')).toContain('callId');
  });
});
