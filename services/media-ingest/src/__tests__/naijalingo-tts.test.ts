/**
 * The Nigerian-language specialist.
 *
 * Half of these tests are about REFUSING TO GUESS. The vendor does not publish
 * its host, its auth header, or its PCM sample rate, and the failure modes of
 * guessing each one are different: a wrong host looks like a network outage, a
 * wrong header looks like a bad key, and a wrong sample rate does not look like
 * anything at all -- it succeeds, and plays at the wrong pitch in a language
 * the reviewer may not speak.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NaijaLingoStreamingSynthesisProvider,
  resampleToEngineRate,
} from '../providers/naijalingo/streaming-tts.js';
import type { StreamingSynthesisOptions } from '../streaming-speech-synthesis-provider.js';

const CONFIG = {
  baseUrl: 'https://api.example.invalid',
  apiKey: 'test-key',
  defaultVoice: 'voice-yo-1',
  sampleRate: 16_000,
};

/** PCM bytes for a run of samples, little-endian. */
function pcm(samples: number[]): ArrayBuffer {
  const array = new Int16Array(samples);
  return array.buffer.slice(0);
}

function respondWith(body: ArrayBuffer, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, requestInit: unknown) => {
    calls.push({ url: String(url), init: requestInit as RequestInit });
    return new Response(body, { status: init.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function request(overrides: Partial<StreamingSynthesisOptions> = {}): StreamingSynthesisOptions {
  return {
    text: 'e kaaro',
    targetLanguage: 'yo',
    voiceId: 'voice_1',
    onChunk: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('refusing to guess', () => {
  it('will not construct without a base URL', () => {
    expect(() => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, baseUrl: '' })).toThrow(
      /NAIJALINGO_BASE_URL/u,
    );
  });

  it('will not construct without a key', () => {
    expect(() => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, apiKey: '   ' })).toThrow(
      /NAIJALINGO_API_KEY/u,
    );
  });

  /*
   * The dangerous one. Every other missing value fails loudly; this one would
   * succeed and quietly play the wrong pitch.
   */
  it('will not construct without a declared sample rate', () => {
    expect(
      () => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, sampleRate: Number.NaN }),
    ).toThrow(/NAIJALINGO_SAMPLE_RATE/u);
    expect(() => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, sampleRate: 0 })).toThrow(
      /NAIJALINGO_SAMPLE_RATE/u,
    );
  });
});

describe('the request it sends', () => {
  it('uses the documented contract and nothing invented', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2, 3, 4]));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request());

    expect(calls[0]?.url).toBe('https://api.example.invalid/v1/audio/speech');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['input']).toBe('e kaaro');
    expect(body['lang']).toBe('yo');
    expect(body['response_format']).toBe('pcm');
    expect(body['voice']).toBe('voice-yo-1');
  });

  it('sends the base subtag for a regional tag', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(
      request({ targetLanguage: 'yo-NG' }),
    );
    expect(JSON.parse(String(calls[0]?.init.body))['lang']).toBe('yo');
  });

  /*
   * X-API-Key with the raw key, taken from the vendor's own SDK. The
   * OpenAI-shaped body invites `authorization: Bearer`, which is what a
   * reasonable guess would have sent and what would have failed every call.
   */
  it('sends the raw key in X-API-Key, not a bearer token', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request());
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['authorization']).toBeUndefined();
  });

  it('lets a deployment override the header and scheme', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
      authHeaderName: 'authorization',
      authScheme: 'Bearer',
    }).synthesize(request());
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
  });

  it('maps a platform voice id when one is configured', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
      voiceIds: { voice_1: 'vendor-voice-9' },
    }).synthesize(request());
    expect(JSON.parse(String(calls[0]?.init.body))['voice']).toBe('vendor-voice-9');
  });
});

describe('languages it does not serve', () => {
  /*
   * Refused, not attempted. Being asked for French means the ROUTING is wrong,
   * and absorbing that would hide the misconfiguration behind a vendor error.
   */
  it('refuses a language outside its four', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    const provider = new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl });
    await expect(provider.synthesize(request({ targetLanguage: 'fr' }))).rejects.toThrow(/does not serve/u);
    expect(calls).toHaveLength(0);
  });

  it('serves all four documented languages', async () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm']) {
      const { fetchImpl, calls } = respondWith(pcm([1, 2]));
      await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(
        request({ targetLanguage: language }),
      );
      expect(calls).toHaveLength(1);
    }
  });
});

describe('the audio it returns', () => {
  it('emits samples and reports them', async () => {
    const chunks: number[] = [];
    const { fetchImpl } = respondWith(pcm([10, 20, 30, 40]));
    const result = await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
    }).synthesize(request({ onChunk: (chunk) => chunks.push(chunk.samples.length) }));

    expect(chunks).toEqual([4]);
    expect(result.samples).toBe(4);
  });

  /* Nothing streamed, so the two numbers are equal and say so honestly. */
  it('reports first-chunk time equal to total time', async () => {
    const { fetchImpl } = respondWith(pcm([1, 2, 3, 4]));
    const result = await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
    }).synthesize(request());
    expect(result.timeToFirstChunkMs).toBe(result.totalMs);
  });

  /* Zero samples is a failure the chain above must be able to fall through on. */
  it('reports silence as zero samples rather than success', async () => {
    const { fetchImpl } = respondWith(new ArrayBuffer(0));
    const result = await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
    }).synthesize(request());
    expect(result.samples).toBe(0);
    expect(result.timeToFirstChunkMs).toBeNull();
  });

  it('surfaces the body of a failed response', async () => {
    const fetchImpl = (async () =>
      new Response('voice unavailable', { status: 422 })) as unknown as typeof fetch;
    await expect(
      new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request()),
    ).rejects.toThrow(/422.*voice unavailable/u);
  });
});

describe('sample rate conversion', () => {
  it('passes 16 kHz through untouched', () => {
    const samples = new Int16Array([1, 2, 3, 4]);
    expect(resampleToEngineRate(samples, 16_000)).toBe(samples);
  });

  it('halves 32 kHz to 16 kHz', () => {
    const input = new Int16Array([0, 100, 0, 100, 0, 100, 0, 100]);
    expect(resampleToEngineRate(input, 32_000)).toHaveLength(4);
  });

  /*
   * Averaging rather than dropping. Naive decimation aliases, and aliasing on
   * speech sounds like harshness a listener blames on the voice.
   */
  it('averages the samples that collapse together', () => {
    const output = resampleToEngineRate(new Int16Array([0, 100, 0, 100]), 32_000);
    expect(output[0]).toBe(50);
    expect(output[1]).toBe(50);
  });

  it('doubles 8 kHz up to 16 kHz', () => {
    expect(resampleToEngineRate(new Int16Array([0, 100, 200]), 8_000)).toHaveLength(6);
  });

  it('handles an empty buffer', () => {
    expect(resampleToEngineRate(new Int16Array(0), 24_000)).toHaveLength(0);
  });

  /*
   * THE REAL CASE. 9jaLingo returns 22050 Hz (measured from a RIFF header on
   * 2026-08-26), so resampling is the normal path for this provider rather than
   * a rarely-taken branch. One second in must be one second out.
   */
  it('converts the rate this vendor actually returns', () => {
    const oneSecondAt22050 = new Int16Array(22_050);
    const converted = resampleToEngineRate(oneSecondAt22050, 22_050);
    expect(converted.length).toBe(16_000);
  });
});

describe('cold capacity', () => {
  /*
   * A vendor that scales to zero is not a vendor that has failed, and telling
   * the two apart is the difference between waiting five minutes and opening an
   * incident.
   */
  it('names a cold start rather than reporting a generic failure', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ detail: 'Inference capacity is starting after an idle period.' }),
        { status: 503 },
      )) as unknown as typeof fetch;

    await expect(
      new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request()),
    ).rejects.toThrow(/cold/iu);
  });

  it('still reports an ordinary 503 as an ordinary failure', async () => {
    const fetchImpl = (async () =>
      new Response('upstream gateway exploded', { status: 503 })) as unknown as typeof fetch;

    await expect(
      new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request()),
    ).rejects.toThrow(/exploded/u);
  });

  it('warms up without throwing when the vendor is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const provider = new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl });
    // Nothing waits on a warm-up, so a failing one must not surface at all.
    expect(() => provider.warmUp()).not.toThrow();
  });

  it('sends a real request when warming up', async () => {
    const { fetchImpl, calls } = respondWith(pcm([1, 2]));
    new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).warmUp();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
  });
});
