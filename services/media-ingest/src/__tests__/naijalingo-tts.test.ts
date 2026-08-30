/** @author masterzee001 */
/**
 * The Nigerian-language specialist, against its PUBLISHED contract.
 *
 * WHAT CHANGED AND WHY THIS SUITE IS DIFFERENT. The previous version tested a
 * GUESSED contract: no host, an assumed header, and a configured PCM sample
 * rate. The official `naijalingo` SDK (npm 0.1.3) was read on 2026-08-30 and
 * settled three of those four; the fourth -- the PCM rate -- is still
 * unpublished and is now removed as a question rather than answered as a guess.
 *
 * THE THREE FAILURE MODES THESE TESTS ARE SHAPED AROUND, because they are not
 * equally dangerous:
 *
 *   wrong host    looks like a network outage      -- loud, findable
 *   wrong header  looks like a bad key             -- misdirects, costs an hour
 *   wrong rate    LOOKS LIKE NOTHING AT ALL        -- 200, plausible bytes, and
 *                 the audio plays at the wrong pitch in a language the reviewer
 *                 may not speak
 *
 * The third is why the adapter asks for `wav` and reads the RIFF header, and
 * why the header parse is tested at a rate that DIFFERS from the engine's:
 * a test that only ever fed 16 kHz would pass with the resampler deleted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NAIJALINGO_DEFAULT_AUTH_HEADER,
  NAIJALINGO_DEFAULT_BASE_URL,
  NAIJALINGO_DEFAULT_MODEL,
  NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
  NaijaLingoStreamingSynthesisProvider,
  describeNaijaLingoPreflight,
  parseWavPcm,
  preflightNaijaLingo,
  resampleToEngineRate,
} from '../providers/naijalingo/streaming-tts.js';
import type { StreamingSynthesisOptions } from '../streaming-speech-synthesis-provider.js';

const CONFIG = {
  apiKey: 'test-key',
  defaultVoice: 'adeola_yo',
};

/**
 * A real RIFF/WAVE buffer at a stated rate.
 *
 * Built rather than fixtured because the RATE is the variable under test: the
 * whole point of asking for `wav` is that the vendor declares it, so a test
 * that could not vary it would be testing nothing.
 */
function wav(samples: number[], sampleRate: number, options: { channels?: number } = {}): ArrayBuffer {
  const channels = options.channels ?? 1;
  const data = new Int16Array(samples);
  const buffer = new ArrayBuffer(44 + data.byteLength);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, data.byteLength, true);
  new Int16Array(buffer, 44).set(data);
  return buffer;
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

describe('the published contract, not a guess', () => {
  it('defaults to the host the SDK ships, and lets a deployment override it', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request());
    expect(calls[0]?.url).toBe(`${NAIJALINGO_DEFAULT_BASE_URL}/v1/audio/speech`);

    const other = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      baseUrl: 'https://api.example.invalid/',
      fetchImpl: other.fetchImpl,
    }).synthesize(request());
    // Trailing slash trimmed, so a template that ends with one does not produce
    // a double-slash path the vendor 404s on.
    expect(other.calls[0]?.url).toBe('https://api.example.invalid/v1/audio/speech');
  });

  /*
   * THE HEADER SHAPE, and it is a shape rather than a string. The body is
   * OpenAI-flavoured, which invites `Authorization: Bearer` -- the guess the
   * previous revision made. That returns the same 401 as a wrong key, so the
   * wrong header is the most expensive small mistake available here.
   */
  it('sends the RAW key in X-API-Key with NO scheme, and no bearer token', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request());
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(NAIJALINGO_DEFAULT_AUTH_HEADER).toBe('x-api-key');
    expect(headers[NAIJALINGO_DEFAULT_AUTH_HEADER]).toBe('test-key');
    // Not merely "not Bearer": absent. A second credential header would be a
    // second thing the vendor could reject.
    expect(headers['authorization']).toBeUndefined();
    expect(Object.values(headers).join(' ')).not.toMatch(/Bearer/u);
  });

  it('lets a deployment override the header and the scheme together', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
      authHeaderName: 'authorization',
      authScheme: 'Bearer',
    }).synthesize(request());
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer test-key',
    );
  });

  it('names the header when the vendor rejects the credential', async () => {
    // A 401 blamed on "the key" while the header was wrong is an hour lost.
    const fetchImpl = (async () =>
      new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    await expect(
      new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request()),
    ).rejects.toThrow(/x-api-key/u);
  });

  it('asks for wav and the SDK model, and sends lang separately from voice', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(
      request({ targetLanguage: 'yo-NG' }),
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe(NAIJALINGO_DEFAULT_MODEL);
    expect(body['input']).toBe('e kaaro');
    expect(body['response_format']).toBe('wav');
    // A region does not change the language the vendor is asked for.
    expect(body['lang']).toBe('yo');
    expect(body['voice']).toBe('adeola_yo');
  });
});

/*
 * THE VENDOR'S OWN DOCUMENTED TRAP. `voice` and `lang` are adjacent fields
 * holding similar-looking strings, and the SDK throws its own error for this.
 * A template filled in with `yo` looks entirely reasonable.
 */
describe('a voice is a SPEAKER ID, never a language code', () => {
  it('refuses a bare language code as the voice, and says which field it belongs in', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    const provider = new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
      voiceIds: { voice_1: 'yo' },
    });
    await expect(provider.synthesize(request())).rejects.toThrow(/LANGUAGE CODE and not a speaker id/u);
    // Refused HERE. Sending it would fail at the vendor as a 4xx that reads
    // like a bad key or an outage.
    expect(calls).toHaveLength(0);
  });

  it('refuses every language code and language NAME the vendor accepts', async () => {
    for (const wrong of ['ha', 'ig', 'yo', 'pcm', 'Yoruba', 'HAUSA', 'pidgin']) {
      const { fetchImpl } = respondWith(wav([1, 2], 16_000));
      const provider = new NaijaLingoStreamingSynthesisProvider({
        ...CONFIG,
        fetchImpl,
        voiceIds: { voice_1: wrong },
      });
      await expect(provider.synthesize(request()), wrong).rejects.toThrow(/speaker id/u);
    }
  });

  it('refuses a language code configured as the DEFAULT voice, at construction', () => {
    // Constructor rather than request time: a deployment finds out at boot
    // rather than on the first Yoruba sentence of a demo.
    expect(
      () => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, defaultVoice: 'yo' }),
    ).toThrow(/LANGUAGE CODE/u);
  });

  it('accepts the published speaker ids, which is what makes activation one variable', async () => {
    for (const [language, speaker] of Object.entries(NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE)) {
      const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
      await new NaijaLingoStreamingSynthesisProvider({
        ...CONFIG,
        fetchImpl,
        defaultVoiceByLanguage: NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
      }).synthesize(request({ targetLanguage: language }));
      expect(JSON.parse(String(calls[0]?.init.body))['voice'], language).toBe(speaker);
    }
  });

  it('prefers a platform voice mapping over the per-language default', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
      voiceIds: { voice_1: 'adekunle_yo' },
      defaultVoiceByLanguage: { yo: 'adeola_yo' },
    }).synthesize(request());
    expect(JSON.parse(String(calls[0]?.init.body))['voice']).toBe('adekunle_yo');
  });
});

/*
 * THE RATE IS READ, NOT CONFIGURED. This is the whole reason `wav` is the
 * default format, so it is tested at a rate that is NOT the engine's -- a suite
 * that only fed 16 kHz would pass with the resampler deleted.
 */
describe('the WAV header is the authority on the sample rate', () => {
  it('reads the declared rate and resamples from it', () => {
    const decoded = parseWavPcm(wav(new Array(22_050).fill(0), 22_050));
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.samples.length).toBe(22_050);
    // One second in is one second out, at the engine's rate.
    expect(resampleToEngineRate(decoded.samples, decoded.sampleRate).length).toBe(16_000);
  });

  it('end to end: a 24 kHz response reaches the engine as 16 kHz', async () => {
    const chunks: number[] = [];
    const { fetchImpl } = respondWith(wav(new Array(24_000).fill(0), 24_000));
    const result = await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
    }).synthesize(request({ onChunk: (chunk) => chunks.push(chunk.samples.length) }));
    expect(chunks).toEqual([16_000]);
    expect(result.samples).toBe(16_000);
  });

  it('passes the engine rate through untouched', async () => {
    const chunks: number[] = [];
    const { fetchImpl } = respondWith(wav(new Array(16_000).fill(0), 16_000));
    await new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(
      request({ onChunk: (chunk) => chunks.push(chunk.samples.length) }),
    );
    expect(chunks).toEqual([16_000]);
  });

  it('walks the chunks rather than reading fixed offsets', () => {
    // A real encoder inserts LIST or fact chunks between `fmt ` and `data`. A
    // fixed-offset reader would shift onto metadata and play it.
    const inner = wav([1, 2, 3, 4], 22_050);
    const listSize = 10;
    const padded = new Uint8Array(inner.byteLength + 8 + listSize);
    const source = new Uint8Array(inner);
    padded.set(source.slice(0, 36), 0);
    const view = new DataView(padded.buffer);
    for (const [index, char] of [...'LIST'].entries()) view.setUint8(36 + index, char.charCodeAt(0));
    view.setUint32(40, listSize, true);
    padded.set(source.slice(36), 44 + listSize);
    view.setUint32(4, padded.byteLength - 8, true);

    const decoded = parseWavPcm(padded.buffer);
    expect(decoded.sampleRate).toBe(22_050);
    expect([...decoded.samples]).toEqual([1, 2, 3, 4]);
  });

  it('downmixes stereo rather than playing it at double speed', () => {
    const decoded = parseWavPcm(wav([100, 200, 300, 400], 16_000, { channels: 2 }));
    expect(decoded.channels).toBe(2);
    expect([...decoded.samples]).toEqual([150, 350]);
  });

  it('REFUSES to assume a rate when the body is not WAV', async () => {
    // The dangerous case made loud. Guessing here would succeed and play at the
    // wrong pitch; the message names the format and the override.
    const { fetchImpl } = respondWith(new Int16Array(64).fill(7).buffer);
    await expect(
      new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).synthesize(request()),
    ).rejects.toThrow(/RIFF\/WAVE/u);
  });

  it('refuses compressed or non-16-bit WAV rather than reinterpreting it as PCM', () => {
    const compressed = wav([1, 2], 16_000);
    new DataView(compressed).setUint16(20, 3, true); // IEEE float
    expect(() => parseWavPcm(compressed)).toThrow(/not linear PCM/u);

    const eightBit = wav([1, 2], 16_000);
    new DataView(eightBit).setUint16(34, 8, true);
    expect(() => parseWavPcm(eightBit)).toThrow(/8-bit/u);
  });

  /*
   * RAW PCM IS AVAILABLE AND COSTS A MEASUREMENT. The vendor publishes no rate,
   * so this path refuses to start without one -- the one mistake that produces
   * no error anywhere is the one mistake the constructor will not allow.
   */
  it('refuses response_format=pcm without a measured rate, and accepts it with one', () => {
    expect(
      () => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, responseFormat: 'pcm' }),
    ).toThrow(/NAIJALINGO_SAMPLE_RATE/u);
    expect(
      () =>
        new NaijaLingoStreamingSynthesisProvider({
          ...CONFIG,
          responseFormat: 'pcm',
          sampleRate: Number.NaN,
        }),
    ).toThrow(/NAIJALINGO_SAMPLE_RATE/u);
    expect(
      () =>
        new NaijaLingoStreamingSynthesisProvider({
          ...CONFIG,
          responseFormat: 'pcm',
          sampleRate: 22_050,
        }),
    ).not.toThrow();
  });

  it('does NOT require a sample rate for wav, because the header carries it', () => {
    expect(() => new NaijaLingoStreamingSynthesisProvider({ ...CONFIG })).not.toThrow();
  });
});

describe('languages it does not serve', () => {
  it('refuses a language outside its four rather than attempting it', async () => {
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    const provider = new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl });
    await expect(provider.synthesize(request({ targetLanguage: 'fr' }))).rejects.toThrow(
      /does not serve/u,
    );
    // Being asked for French means the ROUTING is wrong; absorbing it would
    // hide the misconfiguration behind a vendor error.
    expect(calls).toHaveLength(0);
  });

  it('serves all four, including Pidgin', async () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm']) {
      const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
      await new NaijaLingoStreamingSynthesisProvider({
        ...CONFIG,
        fetchImpl,
        defaultVoiceByLanguage: NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
      }).synthesize(request({ targetLanguage: language }));
      expect(calls, language).toHaveLength(1);
    }
  });
});

describe('the audio it returns', () => {
  it('reports first-chunk time equal to total time, because nothing streamed', async () => {
    const { fetchImpl } = respondWith(wav([1, 2, 3, 4], 16_000));
    const result = await new NaijaLingoStreamingSynthesisProvider({
      ...CONFIG,
      fetchImpl,
    }).synthesize(request());
    expect(result.timeToFirstChunkMs).toBe(result.totalMs);
  });

  it('reports silence as zero samples rather than success', async () => {
    // The chain above needs this to be able to fall through.
    const { fetchImpl } = respondWith(wav([], 16_000));
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
  it('passes the engine rate through as the same array', () => {
    const samples = new Int16Array([1, 2, 3, 4]);
    expect(resampleToEngineRate(samples, 16_000)).toBe(samples);
  });

  it('averages the samples that collapse together rather than dropping them', () => {
    // Naive decimation aliases, and aliasing on speech sounds like harshness a
    // listener blames on the voice.
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
});

/*
 * THE PREFLIGHT IS HOW "PASTE THE KEY" IS CHECKED. Every way that goes wrong
 * is quiet -- a valid key with no plan, a key whose catalogue misses Yoruba, a
 * header the vendor changed -- and all three end as a fallback that sounds like
 * a working product to anyone who does not speak the language.
 */
describe('the preflight reports honestly', () => {
  const speakers = {
    speakers: [
      { id: 'adeola_yo', language: 'yo' },
      { id: 'adaeze_ig', language: 'IG' },
      { id: 'aisha_ha', language: 'ha' },
      { id: 'ada_pcm', language: 'pcm' },
    ],
  };

  function jsonFetch(byPath: Record<string, { status?: number; body: unknown }>) {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      seen.push(path);
      const entry = byPath[path];
      if (entry === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(entry.body), {
        status: entry.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it('AN ABSENT KEY IS REPORTED AS ABSENT, and no request is attempted', async () => {
    // Not as a failed request. Those need opposite actions, and a log line that
    // confuses them costs an afternoon.
    const { fetchImpl, seen } = jsonFetch({});
    const preflight = await preflightNaijaLingo({ apiKey: '   ', fetchImpl });
    expect(preflight.keyConfigured).toBe(false);
    expect(preflight.reachable).toBe(false);
    expect(seen).toEqual([]);
    expect(preflight.problem).toMatch(/NAIJALINGO_API_KEY is not set/u);
    expect(preflight.languagesWithoutSpeakers).toEqual(['ha', 'ig', 'yo', 'pcm']);
    expect(describeNaijaLingoPreflight(preflight)).toMatch(/absent/u);
    // Says what it COSTS, not merely that a variable is unset.
    expect(describeNaijaLingoPreflight(preflight)).toMatch(/Azure fallback/u);
  });

  it('lists the speaker ids per language when the key works', async () => {
    const { fetchImpl, seen } = jsonFetch({
      '/v1/health': { body: { status: 'ok', engine_ready: true, total_speakers: 240 } },
      '/v1/speakers': { body: speakers },
    });
    const preflight = await preflightNaijaLingo({ apiKey: 'k', fetchImpl });
    expect(seen).toEqual(['/v1/health', '/v1/speakers']);
    expect(preflight.reachable).toBe(true);
    expect(preflight.engineReady).toBe(true);
    expect(preflight.totalSpeakers).toBe(240);
    expect(preflight.speakerIdsByLanguage['yo']).toEqual(['adeola_yo']);
    // Case-folded, so an `IG` from the vendor does not read as a missing `ig`.
    expect(preflight.speakerIdsByLanguage['ig']).toEqual(['adaeze_ig']);
    expect(preflight.languagesWithoutSpeakers).toEqual([]);
    expect(preflight.problem).toBeNull();
    expect(describeNaijaLingoPreflight(preflight)).toMatch(/yo=1/u);
  });

  it('says which routed languages this key can produce NO voice for', async () => {
    // The quiet failure: the key works, the engine is up, and Yoruba silently
    // falls back for every sentence.
    const { fetchImpl } = jsonFetch({
      '/v1/health': { body: { status: 'ok', engine_ready: true, total_speakers: 3 } },
      '/v1/speakers': {
        body: { speakers: speakers.speakers.filter((s) => s.language.toLowerCase() !== 'yo') },
      },
    });
    const preflight = await preflightNaijaLingo({ apiKey: 'k', fetchImpl });
    expect(preflight.languagesWithoutSpeakers).toEqual(['yo']);
    expect(preflight.problem).toMatch(/no speaker for yo/u);
  });

  it('names the HEADER on a 401, because a wrong header and a wrong key look identical', async () => {
    const { fetchImpl } = jsonFetch({ '/v1/health': { status: 401, body: { detail: 'nope' } } });
    const preflight = await preflightNaijaLingo({ apiKey: 'k', fetchImpl });
    expect(preflight.reachable).toBe(false);
    expect(preflight.problem).toMatch(/x-api-key/u);
    expect(describeNaijaLingoPreflight(preflight)).toMatch(/NOT reachable/u);
  });

  it('never throws, and never carries a key into its report', async () => {
    // A preflight that could fail a boot would turn a vendor outage into an
    // outage here -- the exact coupling the fallback exists to avoid.
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const preflight = await preflightNaijaLingo({ apiKey: 'super-secret-value', fetchImpl });
    expect(preflight.reachable).toBe(false);
    expect(JSON.stringify(preflight)).not.toContain('super-secret-value');
    expect(describeNaijaLingoPreflight(preflight)).not.toContain('super-secret-value');
  });
});

describe('cold capacity', () => {
  it('names a cold start rather than reporting a generic failure', async () => {
    // A vendor that scales to zero has not failed, and telling the two apart is
    // the difference between waiting five minutes and opening an incident.
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
    const { fetchImpl, calls } = respondWith(wav([1, 2], 16_000));
    new NaijaLingoStreamingSynthesisProvider({ ...CONFIG, fetchImpl }).warmUp();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
  });
});
