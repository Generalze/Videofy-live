/** @owner masterzee001 */
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenVoicePersonalVoiceProvider,
  createPersonalVoiceRoutingProvider,
  isPersonalVoiceId,
  personalVoiceId,
} from '../openvoice-personal-voice.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
} from '../text-to-speech-provider.js';

const SERVICE = 'http://127.0.0.1:3005';
const AUDIO = new Uint8Array([1, 2, 3, 4]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchImpl: typeof fetch, readEnrollment = async () => AUDIO) {
  return createOpenVoicePersonalVoiceProvider({
    serviceUrl: SERVICE,
    readEnrollment,
    fetchImpl,
    timeoutMs: 200,
  });
}

describe('asset creation', () => {
  it('returns an asset only on a real 201', async () => {
    const p = provider(vi.fn(async () => json(201, { voiceAssetRef: 'ov2_abc' })) as never);

    expect(await p.createAsset({
      voiceProfileId: 'vp1', enrollmentRecordingRef: 'rec_1', enrolledLanguage: 'en',
    })).toEqual({ ok: true, voiceAssetRef: 'ov2_abc' });
  });

  it('refuses when the engine answers without an asset', async () => {
    // A 200 with no reference must not make a profile usable.
    const p = provider(vi.fn(async () => json(200, { ok: true })) as never);

    expect((await p.createAsset({
      voiceProfileId: 'vp1', enrollmentRecordingRef: 'rec_1', enrolledLanguage: 'en',
    })).ok).toBe(false);
  });

  it('refuses when the engine is unreachable', async () => {
    const p = provider(vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never);

    expect(await p.createAsset({
      voiceProfileId: 'vp1', enrollmentRecordingRef: 'rec_1', enrolledLanguage: 'en',
    })).toEqual({ ok: false, reason: 'provider-unavailable' });
  });

  it('refuses when the enrollment cannot be read', async () => {
    const p = provider(vi.fn() as never, async () => null as never);

    expect((await p.createAsset({
      voiceProfileId: 'vp1', enrollmentRecordingRef: 'gone', enrolledLanguage: 'en',
    })).ok).toBe(false);
  });

  it('never sends a filesystem path to the engine', async () => {
    const doFetch = vi.fn(async () => json(201, { voiceAssetRef: 'ov2_abc' }));
    const p = provider(doFetch as never);

    await p.createAsset({
      voiceProfileId: 'vp1', enrollmentRecordingRef: 'rec_1', enrolledLanguage: 'en',
    });

    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(AUDIO);
  });
});

describe('resolution', () => {
  const healthy = vi.fn(async () => json(200, { status: 'ok' }));

  it('returns an opaque personal identity, not the engine asset', async () => {
    const result = await provider(healthy as never).resolve({
      voiceProfileId: 'vp1', voiceAssetRef: 'ov2_secret', targetLanguage: 'es',
    });

    expect(result).toEqual({ ok: true, voiceId: 'personal:vp1' });
    expect(JSON.stringify(result)).not.toContain('ov2_secret');
  });

  it('refuses a language the engine has no base voice for', async () => {
    expect(await provider(healthy as never).resolve({
      voiceProfileId: 'vp1', voiceAssetRef: 'ov2_abc', targetLanguage: 'yo',
    })).toEqual({ ok: false, reason: 'unsupported-target-language' });
  });

  it('reports a missing asset distinctly from an absent engine', async () => {
    expect(await provider(healthy as never).resolve({
      voiceProfileId: 'vp1', voiceAssetRef: '', targetLanguage: 'es',
    })).toEqual({ ok: false, reason: 'asset-missing' });

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await provider(down as never).resolve({
      voiceProfileId: 'vp1', voiceAssetRef: 'ov2_abc', targetLanguage: 'es',
    })).toEqual({ ok: false, reason: 'provider-unavailable' });
  });
});

describe('approval is never overstated', () => {
  it('does not claim production approval', () => {
    const info = provider(vi.fn() as never).info();

    expect(info.approval).not.toBe('production-approved');
    expect(info.note).toMatch(/watermarked/i);
  });
});

// ---------------------------------------------------------------- routing

function ttsInput(overrides: Partial<TextToSpeechProviderInput> = {}): TextToSpeechProviderInput {
  return {
    sessionId: 's1', streamId: 'st1', segmentId: 'seg1', sequence: 1,
    targetLanguage: 'es', translatedText: 'Buenos días.',
    startMs: 0, endMs: 1000,
    voiceId: personalVoiceId('vp1'),
    outputPath: 'C:/tmp/out.wav',
    ...overrides,
  } as TextToSpeechProviderInput;
}

function routing(personalResult: { ok: true; audio: Uint8Array } | { ok: false; reason: string }) {
  const standard: TextToSpeechProvider = {
    name: 'piper',
    generate: vi.fn(async (input) => ({ audioPath: input.outputPath, providerLatencyMs: 5 })),
  };
  const written: Uint8Array[] = [];
  const fallbacks: string[] = [];
  const router = createPersonalVoiceRoutingProvider({
    personal: { synthesize: vi.fn(async () => personalResult) },
    standard,
    assetRefFor: (voiceId) => (voiceId === personalVoiceId('vp1') ? 'ov2_abc' : null),
    fallbackVoiceId: () => 'es_ES-standard',
    writeAudio: async (_path, audio) => void written.push(audio),
    onFallback: (reason) => void fallbacks.push(reason),
  });
  return { router, standard, written, fallbacks };
}

describe('personal synthesis', () => {
  it('speaks through the engine when a personal voice is selected', async () => {
    const { router, standard, written } = routing({ ok: true, audio: AUDIO });

    const result = await router.generate(ttsInput());

    expect(written).toHaveLength(1);
    expect(result.audioPath).toBe('C:/tmp/out.wav');
    expect(standard.generate).not.toHaveBeenCalled();
  });

  it('leaves a standard voice entirely alone', async () => {
    const { router, standard } = routing({ ok: true, audio: AUDIO });

    await router.generate(ttsInput({ voiceId: 'es_ES-standard' }));

    expect(standard.generate).toHaveBeenCalledTimes(1);
  });
});

describe('fallback after resolution succeeded', () => {
  it('regenerates the SAME utterance in the standard voice when the engine dies', async () => {
    // The moment that matters: resolution passed, then synthesis failed. The
    // words were already translated, so the listener is owed them in some
    // voice rather than losing the utterance to an infrastructure problem.
    const { router, standard, fallbacks } = routing({ ok: false, reason: 'provider-unavailable' });

    const result = await router.generate(ttsInput());

    expect(fallbacks).toEqual(['provider-unavailable']);
    expect(standard.generate).toHaveBeenCalledTimes(1);
    const [sent] = (standard.generate as ReturnType<typeof vi.fn>).mock.calls[0] as [
      TextToSpeechProviderInput,
    ];
    expect(sent.translatedText).toBe('Buenos días.');
    expect(sent.voiceId).toBe('es_ES-standard');
    expect(result.audioPath).toBe('C:/tmp/out.wav');
  });

  it('falls back on an HTTP failure', async () => {
    const { router, standard } = routing({ ok: false, reason: 'synthesis-failed-500' });

    await router.generate(ttsInput());

    expect(standard.generate).toHaveBeenCalledTimes(1);
  });

  it('falls back on empty audio rather than delivering silence', async () => {
    const { router, standard } = routing({ ok: false, reason: 'synthesis-empty' });

    await router.generate(ttsInput());

    expect(standard.generate).toHaveBeenCalledTimes(1);
  });

  it('falls back when the personal identity maps to no asset', async () => {
    const { router, standard, fallbacks } = routing({ ok: true, audio: AUDIO });

    await router.generate(ttsInput({ voiceId: personalVoiceId('unknown') }));

    expect(fallbacks).toEqual(['asset-missing']);
    expect(standard.generate).toHaveBeenCalledTimes(1);
  });
});

describe('personalVoiceId', () => {
  it('is recognisable and carries no engine detail', () => {
    expect(isPersonalVoiceId(personalVoiceId('vp1'))).toBe(true);
    expect(isPersonalVoiceId('es_ES-standard')).toBe(false);
    expect(personalVoiceId('vp1')).not.toContain('ov2');
  });
});
