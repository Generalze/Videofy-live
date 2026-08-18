/** @author masterzee001 */
/**
 * Proof of the server half against a fake /v1 injected through the server
 * SDK's fetch seam. The fake speaks the strict Connect v1 contract shapes, so
 * these tests exercise the real @videofy/server-sdk validation path end to
 * end: sample route -> SDK -> (fake) wire -> SDK response validation -> route
 * answer.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createVideofyConnect, type VideofyFetch } from '@videofy/server-sdk';
import { buildSampleApp } from '../app.js';
import { readSampleConfig } from '../config.js';
import { connectSdkDistDir, samplePublicDir, socketIoClientDistDir } from '../paths.js';

const API_KEY = 'vfk_dev_0123456789abcdef0123456789abcdef';
const CALL_ID = 'vc_sampleSampleAB12';
const CREATED_AT = '2026-08-18T12:00:00.000Z';
const EXPIRES_AT = '2026-08-18T12:05:00.000Z';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface ForcedEnvelope {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'req-sample-1' : null),
    },
    text: async () => JSON.stringify(body),
  };
}

/** A minimal, contract-shaped /v1 that records everything it is asked. */
function makeFakeVideofy(recorded: RecordedRequest[], forced?: ForcedEnvelope): VideofyFetch {
  return async (url, init) => {
    recorded.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (forced !== undefined) {
      return jsonResponse(forced.status, {
        error: {
          code: forced.code,
          message: forced.message,
          requestId: 'req-sample-1',
          retryable: forced.retryable,
        },
      });
    }
    const { pathname } = new URL(url);
    if (init.method === 'POST' && pathname === '/v1/calls') {
      const parsed = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return jsonResponse(201, {
        callId: CALL_ID,
        type: parsed['type'],
        mode: parsed['mode'],
        createdAt: CREATED_AT,
      });
    }
    if (init.method === 'POST' && /^\/v1\/calls\/[^/]+\/join-tokens$/.test(pathname)) {
      const parsed = JSON.parse(init.body ?? '{}') as { participant: Record<string, unknown> };
      // The SDK sends the participant defaults-resolved; echoing it back is
      // exactly what the strict echo schema expects.
      return jsonResponse(201, {
        token: 'sample-single-use-credential',
        expiresAt: EXPIRES_AT,
        participant: parsed.participant,
      });
    }
    if (init.method === 'POST' && /^\/v1\/calls\/[^/]+\/end$/.test(pathname)) {
      return jsonResponse(200, {
        callId: CALL_ID,
        type: 'conference',
        mode: 'translated',
        createdAt: CREATED_AT,
        ended: true,
      });
    }
    if (init.method === 'GET' && /^\/v1\/calls\/[^/]+\/state$/.test(pathname)) {
      return jsonResponse(200, {
        callId: CALL_ID,
        type: 'conference',
        mode: 'translated',
        participants: [
          {
            participantId: 'participant_1',
            subject: 'customer_1',
            displayName: 'Ana',
            speakLanguage: 'es',
            hearLanguage: 'en',
            connected: true,
          },
        ],
      });
    }
    if (init.method === 'GET' && pathname === '/v1/capabilities') {
      return jsonResponse(200, {
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
    }
    return jsonResponse(404, {
      error: {
        code: 'CALL_NOT_FOUND',
        message: 'No such Connect resource.',
        requestId: 'req-sample-1',
        retryable: false,
      },
    });
  };
}

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
});

async function startSample(forced?: ForcedEnvelope) {
  const recorded: RecordedRequest[] = [];
  const connect = createVideofyConnect({
    apiKey: API_KEY,
    baseUrl: 'http://videofy.test',
    fetch: makeFakeVideofy(recorded, forced),
  });
  const app = buildSampleApp({
    connect,
    videofyUrl: 'http://localhost:3001',
    publicDir: samplePublicDir(),
    connectSdkDistDir: connectSdkDistDir(),
    socketIoClientDistDir: socketIoClientDistDir(),
  });
  const server = createServer(app);
  openServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, recorded };
}

describe('sample partner server', () => {
  it('creates a video chat through the server SDK and answers with the public resource', async () => {
    const { base, recorded } = await startSample();
    const response = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'conference', mode: 'translated' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['callId']).toBe(CALL_ID);
    expect(body['type']).toBe('conference');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe('http://videofy.test/v1/calls');
    // The key travels only in the Authorization header of the outbound request.
    expect(recorded[0]?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('mints a join token, inventing a guest subject and letting defaults resolve', async () => {
    const { base, recorded } = await startSample();
    const response = await fetch(`${base}/api/calls/${CALL_ID}/join-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ana', speakLanguage: 'es', hearLanguage: 'en' }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      expiresAt: string;
      participant: Record<string, unknown>;
    };
    expect(body.token).toBe('sample-single-use-credential');
    expect(body.expiresAt).toBe(EXPIRES_AT);
    expect(body.participant['audioMode']).toBe('translated');
    expect(body.participant['captionsEnabled']).toBe(true);
    expect(body.participant['voiceGender']).toBe('female');
    expect(String(body.participant['subject'])).toMatch(/^guest-/);
    // The generated subject is what actually went over the wire.
    const wireBody = JSON.parse(recorded[0]?.body ?? '{}') as {
      participant: Record<string, unknown>;
    };
    expect(wireBody.participant['subject']).toBe(body.participant['subject']);
  });

  it('honors a partner-provided subject verbatim', async () => {
    const { base } = await startSample();
    const response = await fetch(`${base}/api/calls/${CALL_ID}/join-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'customer_42',
        displayName: 'Bo',
        speakLanguage: 'en',
        hearLanguage: 'fr',
      }),
    });
    const body = (await response.json()) as { participant: Record<string, unknown> };
    expect(body.participant['subject']).toBe('customer_42');
  });

  it('passes /v1 error envelopes through with their status, code, and requestId', async () => {
    const { base } = await startSample({
      status: 404,
      code: 'CALL_NOT_FOUND',
      message: 'That video chat does not exist.',
      retryable: false,
    });
    const response = await fetch(`${base}/api/calls/${CALL_ID}/state`);
    expect(response.status).toBe(404);
    const text = await response.text();
    const body = JSON.parse(text) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('CALL_NOT_FOUND');
    expect(body.error['retryable']).toBe(false);
    expect(body.error['requestId']).toBe('req-sample-1');
    // The project key never leaks into anything a page can see.
    expect(text).not.toContain(API_KEY);
  });

  it('refuses invalid input locally, before any network traffic', async () => {
    const { base, recorded } = await startSample();
    const response = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'group', mode: 'translated' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('INVALID_REQUEST');
    expect(recorded).toHaveLength(0);
  });

  it('reads live participant state for the host page', async () => {
    const { base } = await startSample();
    const response = await fetch(`${base}/api/calls/${CALL_ID}/state`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { participants: Record<string, unknown>[] };
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0]?.['displayName']).toBe('Ana');
    expect(body.participants[0]?.['subject']).toBe('customer_1');
  });

  it('ends a video chat by project authority', async () => {
    const { base, recorded } = await startSample();
    const response = await fetch(`${base}/api/calls/${CALL_ID}/end`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ended']).toBe(true);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toBe(`http://videofy.test/v1/calls/${CALL_ID}/end`);
  });

  it('proxies capabilities so the pages can build language pickers', async () => {
    const { base } = await startSample();
    const response = await fetch(`${base}/api/capabilities`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { languages: string[] };
    expect(body.languages).toEqual(['en', 'es', 'fr']);
  });

  it('tells the pages where the Videofy gateway lives', async () => {
    const { base } = await startSample();
    const response = await fetch(`${base}/api/config`);
    expect(await response.json()).toEqual({ videofyUrl: 'http://localhost:3001' });
  });

  it('serves the host page at the root and the join page beside it', async () => {
    const { base } = await startSample();
    const hostPage = await fetch(base);
    expect(hostPage.status).toBe(200);
    expect(await hostPage.text()).toContain('Videofy Connect sample — host');
    const joinPage = await fetch(`${base}/join.html`);
    expect(joinPage.status).toBe(200);
    const joinText = await joinPage.text();
    expect(joinText).toContain('importmap');
    expect(joinText).toContain('/vendor/videofy-connect/index.js');
  });

  it('serves the real browser SDK bundle and its one runtime dependency', async () => {
    const { base } = await startSample();
    const bundle = await fetch(`${base}/vendor/videofy-connect/index.js`);
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toContain('createVideofyClient');
    const socketIo = await fetch(`${base}/vendor/socket.io-client/socket.io.esm.min.js`);
    expect(socketIo.status).toBe(200);
  });

  it('answers unknown /api paths with the sample error shape', async () => {
    const { base } = await startSample();
    const response = await fetch(`${base}/api/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('INVALID_REQUEST');
  });
});

describe('sample config', () => {
  it('requires VIDEOFY_API_KEY and points at the provisioning script', () => {
    expect(() => readSampleConfig({})).toThrowError(/VIDEOFY_API_KEY/);
    expect(() => readSampleConfig({})).toThrowError(/connect:project:create/);
  });

  it('defaults the gateway URL and port, trimming trailing slashes', () => {
    const config = readSampleConfig({ VIDEOFY_API_KEY: ' vfk_dev_x ' });
    expect(config).toEqual({
      apiKey: 'vfk_dev_x',
      videofyUrl: 'http://localhost:3001',
      port: 4173,
    });
    const custom = readSampleConfig({
      VIDEOFY_API_KEY: 'vfk_dev_x',
      VIDEOFY_CONNECT_URL: 'https://connect.example.com/',
      PORT: '8080',
    });
    expect(custom.videofyUrl).toBe('https://connect.example.com');
    expect(custom.port).toBe(8080);
  });

  it('refuses a nonsense PORT', () => {
    expect(() => readSampleConfig({ VIDEOFY_API_KEY: 'vfk_dev_x', PORT: 'abc' })).toThrowError(
      /PORT/,
    );
  });
});
