/** @author masterzee001 */
/**
 * C-AI1.1F pins for the Azure comparator. Offline, against an injected fetch:
 * these fail for reasons about our adapter, never about Azure's uptime.
 */
import { describe, expect, it } from 'vitest';
import {
  AZURE_ENGINE_OUTPUT_FORMAT,
  AzureStreamingSynthesisProvider,
  buildSsml,
  escapeSsmlText,
  type AzureStreamingTtsConfig,
} from '../providers/azure/streaming-tts.js';
import type { SynthesisChunk } from '../streaming-speech-synthesis-provider.js';

function azure(chunks: Uint8Array[], status = 200, overrides: Partial<AzureStreamingTtsConfig> = {}) {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const provider = new AzureStreamingSynthesisProvider({
    apiKey: 'k',
    region: 'westeurope',
    voiceIds: { 'videofy-es': 'es-ES-ElviraNeural' },
    defaultVoiceId: 'en-US-JennyNeural',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      if (status !== 200) return new Response('bad request: header too long', { status });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    ...overrides,
  });
  return { provider, seen };
}

async function run(provider: AzureStreamingSynthesisProvider, text = 'buenas tardes', signal?: AbortSignal) {
  const got: SynthesisChunk[] = [];
  const result = await provider.synthesize({
    text,
    targetLanguage: 'es-ES',
    voiceId: 'videofy-es',
    onChunk: (chunk) => got.push(chunk),
    onError: () => {},
    ...(signal === undefined ? {} : { signal }),
  });
  return { got, result };
}

describe('Azure speaks the engine format directly', () => {
  it('PIN: the documented streaming raw PCM16/16k format is requested', async () => {
    const a = azure([Uint8Array.from([1, 0, 2, 0])]);
    await run(a.provider);
    // The whole reason Azure is a drop-in comparator rather than a project:
    // no resample, no transcode, no container to strip.
    expect(a.seen[0]!.headers['x-microsoft-outputformat']).toBe(AZURE_ENGINE_OUTPUT_FORMAT);
    expect(AZURE_ENGINE_OUTPUT_FORMAT).toBe('raw-16khz-16bit-mono-pcm');
  });

  it('PIN: every header the documentation marks required is sent', async () => {
    const a = azure([Uint8Array.from([1, 0])]);
    await run(a.provider);
    const headers = a.seen[0]!.headers;
    expect(headers['ocp-apim-subscription-key']).toBe('k');
    expect(headers['content-type']).toBe('application/ssml+xml');
    expect(headers['x-microsoft-outputformat']).toBe(AZURE_ENGINE_OUTPUT_FORMAT);
    // Documented as required. Omitting it returns 400 complaining about
    // headers, which reads like an entirely different problem.
    expect(headers['user-agent']).toBeTruthy();
  });

  it('PIN: the region selects the host, and the platform voice is mapped', async () => {
    const a = azure([Uint8Array.from([1, 0])]);
    await run(a.provider);
    expect(a.seen[0]!.url).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
    // Videofy's voice id never reaches the vendor; the mapping is ours.
    expect(a.seen[0]!.body).toContain('es-ES-ElviraNeural');
    expect(a.seen[0]!.body).not.toContain('videofy-es');
  });

  it('PIN: a sample split across two chunks survives the boundary', async () => {
    const a = azure([Uint8Array.from([0x02]), Uint8Array.from([0x01, 0x04, 0x03])]);
    const r = await run(a.provider);
    // The same physical hazard as ElevenLabs, solved by the same decoder
    // rather than by a second copy that would drift.
    expect(r.got.flatMap((c) => Array.from(c.samples))).toEqual([0x0102, 0x0304]);
  });
});

describe('the body is XML, and translated text is arbitrary', () => {
  it('PIN: ampersands and angle brackets are escaped, not injected', () => {
    // "Marks & Spencer" is an ordinary thing to say, and unescaped it either
    // breaks the request or is interpreted as markup.
    expect(escapeSsmlText('Marks & Spencer <b>')).toBe('Marks &amp; Spencer &lt;b&gt;');
    const ssml = buildSsml("it's <urgent> & loud", 'es-ES-ElviraNeural', 'es-ES');
    expect(ssml).toContain('&amp;');
    expect(ssml).toContain('&lt;urgent&gt;');
    expect(ssml).toContain('&apos;');
    // The structural tags survive; only the text is escaped.
    expect(ssml.startsWith("<speak version='1.0'")).toBe(true);
    expect(ssml).toContain("name='es-ES-ElviraNeural'");
  });

  it('PIN: a quote in the voice or language cannot break out of an attribute', () => {
    const ssml = buildSsml('hello', "evil' onload='x", 'es-ES');
    expect(ssml).not.toContain("name='evil' onload='x'");
    expect(ssml).toContain('&apos;');
  });

  it('translated text reaches the vendor intact after escaping', async () => {
    const a = azure([Uint8Array.from([1, 0])]);
    await run(a.provider, 'salud & fuerza');
    expect(a.seen[0]!.body).toContain('salud &amp; fuerza');
  });
});

describe('failures and cancellation', () => {
  it('PIN: a vendor error carries its own words', async () => {
    const a = azure([], 400);
    await expect(run(a.provider)).rejects.toThrow(/header too long/);
    await expect(run(a.provider)).rejects.toMatchObject({ code: 'tts-failed' });
  });

  it('PIN: zero bytes is an error, not silent silence', async () => {
    const a = azure([]);
    await expect(run(a.provider)).rejects.toMatchObject({ code: 'tts-failed' });
  });

  it('PIN: a caller abort stops synthesis and reports it without throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const a = azure([Uint8Array.from([1, 0, 2, 0])]);
    const r = await run(a.provider, 'hola', controller.signal);
    expect(r.result.aborted).toBe(true);
    expect(r.got).toHaveLength(0);
  });

  it('PIN: chunks carry audio and nothing that could name it', async () => {
    const a = azure([Uint8Array.from([1, 0, 2, 0])]);
    const r = await run(a.provider);
    expect(Object.keys(r.got[0]!)).toEqual(['samples']);
    expect(a.provider.name).toBe('azure-speech:tts-westeurope');
  });
});
