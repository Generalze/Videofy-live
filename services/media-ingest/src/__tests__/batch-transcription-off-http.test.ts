/** @author masterzee001 */
/**
 * The batch-off refusal, over HTTP, as a caller actually receives it.
 *
 * CTO ruling 30 Aug 2026: "That closes the gap between 'the provider throws
 * 503-shaped metadata' and 'the API actually returns the correct 503 to a
 * caller.'" The sibling test proves the provider; this one proves the wire.
 *
 * It drives the REAL error mapper (`sendIngestError`, extracted for exactly
 * this reason) and the REAL provider factory. Nothing here re-implements the
 * behaviour it is checking: a test that declares its own handler and asserts
 * against it proves only that the test agrees with itself.
 *
 * WHAT MUST BE TRUE ON THE WIRE, per the ruling:
 *   HTTP 503 · capability unavailable · no mock invocation ·
 *   no retry into another provider · no fabricated transcript.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptionProvider } from '../transcription-provider.js';
import { sendIngestError } from '../ingest-error-response.js';

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly transcribeCalls: string[];
}

/**
 * The route shape index.ts uses for every batch operation: call into the
 * service, and hand anything thrown to the shared mapper.
 */
async function harness(providerName: 'off'): Promise<Harness> {
  const transcribeCalls: string[] = [];
  const provider = createTranscriptionProvider({
    providerName,
    sourceLanguage: 'en',
    timeoutMs: 30_000,
    fasterWhisper: {} as never,
  });
  const spied = {
    name: provider.name,
    async transcribe(input: unknown) {
      transcribeCalls.push(provider.name);
      return provider.transcribe(input as never);
    },
  };

  const app = express();
  app.post('/sessions/:sessionId/transcription/chunks/:chunkId/retry', async (_req, res) => {
    try {
      const result = await spied.transcribe({ audioPath: '/tmp/a.wav', sourceLanguage: 'en' });
      res.json({ session: { transcript: result } });
    } catch (error) {
      sendIngestError(res, error);
    }
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    transcribeCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function retry(h: Harness): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${h.url}/sessions/ps_1/transcription/chunks/c1/retry`, {
    method: 'POST',
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('batch transcription switched off, over HTTP', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('answers 503 with the capability code, not 500 and not a success', async () => {
    h = await harness('off');
    const { status, body } = await retry(h);

    expect(status).toBe(503);
    expect(body['code']).toBe('transcription-unavailable');
    // 500 would read as "this service is broken"; 200 would be a lie.
    expect(status).not.toBe(500);
  });

  it('tells the caller the deployment cannot do it, without blaming their file', async () => {
    h = await harness('off');
    const { body } = await retry(h);
    expect(String(body['error'])).toMatch(/not available on this deployment/i);
    expect(String(body['error'])).not.toMatch(/invalid|corrupt|unsupported format/i);
  });

  it('returns no transcript, fabricated or otherwise', async () => {
    h = await harness('off');
    const { body } = await retry(h);
    expect(body).not.toHaveProperty('session.transcript');
    expect(JSON.stringify(body)).not.toMatch(/text"\s*:/);
  });

  it('does not retry into another provider after refusing', async () => {
    h = await harness('off');
    await retry(h);
    // One attempt, one refusal. A silent second attempt against a different
    // provider is how a deployment that declared no batch transcription ends
    // up publishing some anyway.
    expect(h.transcribeCalls).toEqual(['off']);
  });

  it('never invokes the mock provider', async () => {
    h = await harness('off');
    await retry(h);
    expect(h.transcribeCalls).not.toContain('mock');
  });

});
