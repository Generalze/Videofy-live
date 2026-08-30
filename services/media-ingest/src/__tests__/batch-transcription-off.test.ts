/** @author masterzee001 */
/**
 * Batch transcription, switched off — and the live path untouched by it.
 *
 * CTO ruling 30 Aug 2026: batch (uploaded media) and live (streaming)
 * transcription are SEPARATE CAPABILITIES. The selector used to offer only
 * `mock` or `faster-whisper`, so a deployment wanting live Deepgram and no
 * batch path had to stage a local model purely to satisfy a boot check.
 * `off` says the true thing instead.
 *
 * The distinction these tests defend is between REFUSING and INVENTING. A
 * mock transcriber answers with fabricated words carrying every success signal
 * a real one has, so nothing downstream can tell, and a viewer reads invented
 * speech attributed to a real person. That is why `mock` is refused in
 * production and `off` throws.
 */
import { describe, expect, it } from 'vitest';
import { createTranscriptionProvider } from '../transcription-provider.js';
import { MediaIngestError } from '../ingest-error.js';

const FASTER_WHISPER = {
  pythonPath: 'python3',
  modelSize: 'small',
  device: 'cpu' as const,
  computeType: 'int8',
  beamSize: 1,
  modelCacheDir: '/tmp/models',
  allowModelDownload: false,
};

function provider(name: 'off' | 'mock' | 'faster-whisper') {
  // faster-whisper settings are never reached on the paths under test; the
  // cast keeps this fixture from having to track a config shape it does not
  // exercise.
  return createTranscriptionProvider({
    providerName: name,
    sourceLanguage: 'en',
    timeoutMs: 30_000,
    fasterWhisper: FASTER_WHISPER as never,
  });
}

describe('TRANSCRIPTION_PROVIDER=off', () => {
  it('mounts a provider rather than refusing to build one, so the service can start', () => {
    expect(() => provider('off')).not.toThrow();
    expect(provider('off').name).toBe('off');
  });

  it('refuses honestly, and never returns a transcript', async () => {
    const result = provider('off').transcribe({
      audioPath: '/tmp/whatever.wav',
      sourceLanguage: 'en',
      chunk: { chunkId: 'c1', startMs: 0, endMs: 1000 } as never,
    } as never);

    await expect(result).rejects.toBeInstanceOf(MediaIngestError);
    await expect(result).rejects.toMatchObject({
      code: 'transcription-unavailable',
      statusCode: 503,
    });
  });

  it('says the capability is unavailable, not that the upload was bad', async () => {
    // The person uploaded a perfectly good file. Blaming it would send them
    // away re-encoding audio to fix a decision the deployment made.
    await expect(
      provider('off').transcribe({ audioPath: '/tmp/a.wav', sourceLanguage: 'en' } as never),
    ).rejects.toThrow(/not available on this deployment/i);
  });

  it('does not fall back to the mock provider', async () => {
    // The failure mode this whole switch exists to prevent: a deployment that
    // asked for no transcription and got invented words anyway.
    const off = provider('off');
    expect(off.name).not.toBe('mock');
    await expect(
      off.transcribe({ audioPath: '/tmp/a.wav', sourceLanguage: 'en' } as never),
    ).rejects.toThrow();
  });

  it('leaves the mock provider exactly as it was', () => {
    // faster-whisper is deliberately not built here: it validates its model
    // cache at construction, so building one would test this machine's disk
    // rather than the selector.
    expect(provider('mock').name).toBe('mock');
  });
});
