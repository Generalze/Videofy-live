/** @author masterzee001 */
/**
 * The webhook door: challenge answering, signature enforcement, and the
 * started/interrupted/stopped distinction.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildZoomWebhookApp, type RtmsStreamStart } from '../webhook.js';
import { webhookSignature } from '../credentials.js';

const SECRET = 'webhook-secret-token';
/** A signed delivery is only valid near its timestamp, so the clock is fixed. */
const SIGNED_AT_SECONDS = 1700000000;
const NOW_MS = SIGNED_AT_SECONDS * 1000;
/** Zoom hosts only: the url decides who receives our stream signature. */
const ZOOM_SIGNALING_URL = 'wss://rtms.zoom.us/signaling';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Harness {
  url: string;
  started: RtmsStreamStart[];
  stopped: Array<{ rtmsStreamId: string; reason: string }>;
  interrupted: string[];
  warnings: string[];
}

async function startWebhook(): Promise<Harness> {
  const started: RtmsStreamStart[] = [];
  const stopped: Array<{ rtmsStreamId: string; reason: string }> = [];
  const interrupted: string[] = [];
  const warnings: string[] = [];
  const app = buildZoomWebhookApp({
    secretToken: SECRET,
    now: () => NOW_MS,
    handlers: {
      onStreamStarted: async (start) => {
        started.push(start);
      },
      onStreamStopped: async (input) => {
        stopped.push({ rtmsStreamId: input.rtmsStreamId, reason: input.reason });
      },
      onStreamInterrupted: async (input) => {
        interrupted.push(input.rtmsStreamId);
      },
      onConcurrencyWarning: (event) => warnings.push(event),
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, started, stopped, interrupted, warnings };
}

async function post(
  harness: Harness,
  body: unknown,
  options: { sign?: boolean; timestamp?: string } = {},
): Promise<{ status: number; body: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(SIGNED_AT_SECONDS);
  const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
  if (options.sign !== false) {
    headers['x-zm-request-timestamp'] = timestamp;
    headers['x-zm-signature'] = webhookSignature({ secretToken: SECRET, timestamp, rawBody });
  }
  const response = await fetch(`${harness.url}/zoom/webhook`, { method: 'POST', headers, body: rawBody });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function startedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'meeting.rtms_started',
    payload: {
      meeting_uuid: 'meet_uuid_1',
      rtms_stream_id: 'stream_1',
      // Webhook shape: a BARE STRING, unlike the handshake response object.
      server_urls: ZOOM_SIGNALING_URL,
      ...overrides,
    },
  };
}

describe('zoom webhook', () => {
  it('answers the endpoint validation challenge when it is properly signed', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, { event: 'endpoint.url_validation', payload: { plainToken: 'plain-1' } });
    expect(answer.status).toBe(200);
    expect(answer.body.plainToken).toBe('plain-1');
    expect(answer.body.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('BLOCKER pin: the challenge is NOT an unauthenticated signing oracle', async () => {
    const harness = await startWebhook();
    // The attack: the challenge returns HMAC(secret, plainToken) under the very
    // secret and algorithm that signs webhooks. If it were answered before
    // authentication, an attacker could submit a webhook signing payload as the
    // plainToken, receive a valid signature, and replay it as a genuine
    // rtms_started pointed at their own websocket.
    const forgedBody = JSON.stringify({
      event: 'meeting.rtms_started',
      payload: {
        meeting_uuid: 'MEET',
        rtms_stream_id: 'STREAM',
        server_urls: 'wss://attacker.example/steal',
      },
    });
    const oracleAsk = await post(
      harness,
      { event: 'endpoint.url_validation', payload: { plainToken: `v0:${SIGNED_AT_SECONDS}:${forgedBody}` } },
      { sign: false },
    );
    expect(oracleAsk.status).toBe(401);
    expect(oracleAsk.body?.encryptedToken).toBeUndefined();
    expect(harness.started).toHaveLength(0);
  });

  it('refuses a delivery whose signed timestamp is stale, closing the replay window', async () => {
    const harness = await startWebhook();
    const sixMinutesEarlier = String(SIGNED_AT_SECONDS - 360);
    const answer = await post(harness, startedEvent(), { timestamp: sixMinutesEarlier });
    expect(answer.status).toBe(401);
    expect(harness.started).toHaveLength(0);
  });

  it('refuses a signed start that points at a non-Zoom host', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, startedEvent({ server_urls: 'wss://attacker.example/steal' }));
    expect(answer.status).toBe(400);
    expect(harness.started).toHaveLength(0);
  });

  it('refuses a signed start whose url is not wss', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, startedEvent({ server_urls: 'http://rtms.zoom.us/signaling' }));
    expect(answer.status).toBe(400);
    expect(harness.started).toHaveLength(0);
  });

  it('refuses an unsigned delivery — a forged start would make us dial an attacker', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, startedEvent(), { sign: false });
    expect(answer.status).toBe(401);
    expect(harness.started).toHaveLength(0);
  });

  it('refuses a delivery signed with the wrong secret or a replayed timestamp', async () => {
    const harness = await startWebhook();
    const rawBody = JSON.stringify(startedEvent());
    const forged = webhookSignature({ secretToken: 'not-the-secret', timestamp: String(SIGNED_AT_SECONDS), rawBody });
    const response = await fetch(`${harness.url}/zoom/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        'x-zm-request-timestamp': String(SIGNED_AT_SECONDS),
        'x-zm-signature': forged,
      },
      body: rawBody,
    });
    expect(response.status).toBe(401);

    // Right secret, but the timestamp it was signed against is not the one sent.
    const mismatched = await fetch(`${harness.url}/zoom/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        'x-zm-request-timestamp': String(SIGNED_AT_SECONDS + 1),
        'x-zm-signature': webhookSignature({ secretToken: SECRET, timestamp: String(SIGNED_AT_SECONDS), rawBody }),
      },
      body: rawBody,
    });
    expect(mismatched.status).toBe(401);
    expect(harness.started).toHaveLength(0);
  });

  it('accepts a properly signed start and hands over the signaling url', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, startedEvent());
    expect(answer.status).toBe(204);
    expect(harness.started).toEqual([
      { meetingUuid: 'meet_uuid_1', rtmsStreamId: 'stream_1', signalingServerUrl: ZOOM_SIGNALING_URL },
    ]);
  });

  it('refuses an incomplete start rather than dialling a blank url', async () => {
    const harness = await startWebhook();
    const answer = await post(harness, startedEvent({ server_urls: '' }));
    expect(answer.status).toBe(400);
    expect(harness.started).toHaveLength(0);
  });

  it('keeps interrupted separate from stopped — one is recoverable, one is not', async () => {
    const harness = await startWebhook();
    await post(harness, {
      event: 'meeting.rtms_interrupted',
      payload: { meeting_uuid: 'meet_uuid_1', rtms_stream_id: 'stream_1' },
    });
    await post(harness, {
      event: 'meeting.rtms_stopped',
      payload: { meeting_uuid: 'meet_uuid_1', rtms_stream_id: 'stream_1', reason: 'meeting ended' },
    });
    expect(harness.interrupted).toEqual(['stream_1']);
    expect(harness.stopped).toEqual([{ rtmsStreamId: 'stream_1', reason: 'meeting ended' }]);
  });

  it('records account concurrency warnings and ignores unknown events', async () => {
    const harness = await startWebhook();
    await post(harness, { event: 'rtms.concurrency_near_limit', payload: {} });
    await post(harness, { event: 'meeting.something_new_zoom_added', payload: {} });
    expect(harness.warnings).toEqual(['rtms.concurrency_near_limit']);
  });
});
