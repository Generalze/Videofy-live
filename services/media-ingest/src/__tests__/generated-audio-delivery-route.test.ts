import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerGeneratedAudioDeliveryRoute,
  type GeneratedAudioDeliveryService,
} from '../generated-audio-delivery-route.js';
import { MediaIngestError } from '../ingest-error.js';
import type { GeneratedAudioFile } from '../media-session.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generated-audio delivery route', () => {
  it('serves generated WAV audio with browser range support', async () => {
    const temp = await tempDir();
    const audioPath = join(temp, 'tts-000000.wav');
    const wav = testWavBuffer();
    await writeFile(audioPath, wav);
    const file = generatedAudioFile(audioPath, wav.length);
    const baseUrl = await startDeliveryApp({
      getGeneratedAudioFile: async () => file,
    });

    const full = await fetch(`${baseUrl}/sessions/ps_ok/generated-audio/segments/segment-0/audio`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toContain('audio/wav');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await full.arrayBuffer()).byteLength).toBe(wav.length);

    const partial = await fetch(
      `${baseUrl}/sessions/ps_ok/generated-audio/segments/segment-0/audio`,
      {
        headers: { range: 'bytes=0-3' },
      },
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-3/${wav.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).toString('ascii')).toBe('RIFF');
  });

  it('selects the requested language channel for shared segment IDs', async () => {
    const requested: Array<[string, string, string | undefined]> = [];
    const temp = await tempDir();
    const audioPath = join(temp, 'tts-000000.wav');
    const wav = testWavBuffer();
    await writeFile(audioPath, wav);
    const baseUrl = await startDeliveryApp({
      getGeneratedAudioFile: async (sessionId, segmentId, targetLanguage) => {
        requested.push([sessionId, segmentId, targetLanguage]);
        return generatedAudioFile(audioPath, wav.length);
      },
    });

    const response = await fetch(
      `${baseUrl}/sessions/ps_ok/generated-audio/segments/segment-0/audio?language=es`,
    );

    expect(response.status).toBe(200);
    expect(requested).toEqual([['ps_ok', 'segment-0', 'es']]);
  });

  it('returns clear errors for missing, wrong-session and unsafe audio requests', async () => {
    const baseUrl = await startDeliveryApp({
      getGeneratedAudioFile: async (sessionId, segmentId) => {
        if (segmentId.includes('..')) {
          throw new MediaIngestError('Unsafe generated-audio segment ID rejected.', 'unsafe-path', 400);
        }
        if (sessionId !== 'ps_ok') {
          throw new MediaIngestError(
            `Generated audio file is missing for segment ${segmentId}.`,
            'generated-audio-unavailable',
            404,
          );
        }
        throw new MediaIngestError(
          `Generated audio file is missing for segment ${segmentId}.`,
          'generated-audio-unavailable',
          404,
        );
      },
    });

    const missing = await fetch(`${baseUrl}/sessions/ps_ok/generated-audio/segments/missing/audio`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'generated-audio-unavailable' });

    const wrongSession = await fetch(
      `${baseUrl}/sessions/ps_other/generated-audio/segments/segment-0/audio`,
    );
    expect(wrongSession.status).toBe(404);
    expect(await wrongSession.json()).toMatchObject({ code: 'generated-audio-unavailable' });

    const unsafe = await fetch(`${baseUrl}/sessions/ps_ok/generated-audio/segments/..%2Fbad/audio`);
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ code: 'unsafe-path' });
  });
});

async function startDeliveryApp(service: GeneratedAudioDeliveryService): Promise<string> {
  const app = express();
  registerGeneratedAudioDeliveryRoute(app, service);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-audio-delivery-'));
  tempDirs.push(dir);
  return dir;
}

function generatedAudioFile(audioPath: string, sizeBytes: number): GeneratedAudioFile {
  return {
    sessionId: 'ps_ok',
    segmentId: 'segment-0',
    sequence: 0,
    targetLanguage: 'es',
    voiceId: 'es-test',
    durationMs: 100,
    providerLatencyMs: 5,
    audioPath,
    sizeBytes,
  };
}

function testWavBuffer(): Buffer {
  const dataSize = 3200;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
