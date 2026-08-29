/**
 * Translated voice notes, proved with the platform's own fakes.
 *
 * Every stage is a vendor; every proof here runs with none. What is pinned is
 * the contract the account service relies on: the token gate, the stage name
 * on failure, and real audio bytes on success -- never the source transcript.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import { MockStreamingSynthesisProvider } from '../streaming-speech-synthesis-provider.js';
import {
  MockTranscriptionProvider,
  type TranscriptionProvider,
} from '../transcription-provider.js';
import {
  MockTimestampedTranslationProvider,
  type TimestampedTranslationProvider,
} from '../translation-provider.js';
import {
  registerVoiceNoteTranslationRoute,
  type VoiceNoteTranslationDependencies,
} from '../voice-note-translation-route.js';

const TOKEN = 'test-internal-token';
const AUTH: InternalIngressAuthResolution = {
  mode: 'enforced',
  token: TOKEN,
  fingerprint: 'abcd',
  mustRefuseToStart: false,
  summary: 'enforced (test)',
};

const servers: Server[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(
  overrides: Partial<VoiceNoteTranslationDependencies> = {},
): Promise<{ url: string; stagingDir: string }> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'vn-translate-'));
  tempDirs.push(stagingDir);
  const app = express();
  registerVoiceNoteTranslationRoute(app, {
    auth: AUTH,
    transcription: new MockTranscriptionProvider('en'),
    translation: new MockTimestampedTranslationProvider(['es', 'fr']),
    synthesis: () => new MockStreamingSynthesisProvider([1600, 1600]),
    voiceIdFor: () => 'voice-default',
    stagingDir,
    transcriptionTimeoutMs: 2_000,
    translationTimeoutMs: 2_000,
    synthesisTimeoutMs: 2_000,
    ...overrides,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, stagingDir };
}

function request(url: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${url}/internal/voice-translation`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'X-Videofy-Internal-Token': token }),
    },
    body: JSON.stringify(body),
  });
}

const NOTE = {
  audioBase64: Buffer.from('fake-aac-bytes').toString('base64'),
  mime: 'audio/mp4',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  durationMs: 1500,
};

describe('POST /internal/voice-translation', () => {
  it('refuses without the internal token, and with the wrong one', async () => {
    const { url } = await start();
    expect((await request(url, NOTE, null)).status).toBe(403);
    expect((await request(url, NOTE, 'not-the-token')).status).toBe(403);
  });

  it('returns audio and the translated text on success, never the transcript', async () => {
    const { url, stagingDir } = await start();
    const response = await request(url, NOTE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['translatedText']).toBe('[es] Mock transcript chunk 1');
    expect(body['mime']).toBe('audio/wav');
    expect(body['durationMs']).toBe(200);
    expect(typeof body['servedBy']).toBe('string');
    expect('transcript' in body).toBe(false);
    const wav = Buffer.from(body['audioBase64'] as string, 'base64');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.length).toBe(44 + 3200 * 2);
    // The staged copy of the note does not outlive the request.
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it('names the failing stage and keeps a 200: the caller decides', async () => {
    const failing: TranscriptionProvider = {
      name: 'failing',
      transcribe: async () => {
        throw new Error('recogniser offline');
      },
    };
    const { url } = await start({ transcription: failing });
    const response = await request(url, NOTE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      stage: 'transcribe',
      reason: 'recogniser offline',
    });
  });

  it('reports a translation refusal as the translate stage', async () => {
    const refusing: TimestampedTranslationProvider = {
      name: 'refusing',
      translate: async () => {
        throw new Error('pair unsupported');
      },
    };
    const { url } = await start({ translation: refusing });
    const body = (await (await request(url, NOTE)).json()) as { ok: boolean; stage?: string };
    expect(body.ok).toBe(false);
    expect(body.stage).toBe('translate');
  });

  it('reports a missing synthesiser as the synthesize stage', async () => {
    const { url } = await start({ synthesis: () => null });
    expect(await (await request(url, NOTE)).json()).toEqual({
      ok: false,
      stage: 'synthesize',
      reason: 'unavailable',
    });
  });

  it('rejects a malformed body outright', async () => {
    const { url } = await start();
    expect((await request(url, { ...NOTE, durationMs: 0 })).status).toBe(400);
    expect((await request(url, { ...NOTE, audioBase64: '' })).status).toBe(400);
  });
});
