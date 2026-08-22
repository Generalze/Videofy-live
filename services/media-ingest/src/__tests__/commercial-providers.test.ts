/** @author masterzee001 */
/**
 * C-AI1.1C contract-conformance pins.
 *
 * Deterministic and offline. Every adapter is driven through an injected fake
 * transport, so these run in CI, cost nothing, and fail for reasons about our
 * code rather than about a vendor's uptime. Live confirmation is the separate
 * credential-gated smoke test.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeepgramStreamingTranscriptionProvider,
  pcmBytes,
  type DeepgramSocket,
  type DeepgramSocketHandlers,
} from '../providers/deepgram/streaming-stt.js';
import { DeepgramBatchTranscriptionProvider } from '../providers/deepgram/batch-stt.js';
import { GoogleTimestampedTranslationProvider } from '../providers/google/translation.js';
import { ElevenLabsTextToSpeechProvider } from '../providers/elevenlabs/tts.js';
import type { StreamingTranscriptionSignal } from '../streaming-transcription-provider.js';

const dir = mkdtempSync(join(tmpdir(), 'c-ai1c-'));

// --- Deepgram streaming ----------------------------------------------------

function fakeSocket() {
  const sent: (string | Uint8Array)[] = [];
  let handlers: DeepgramSocketHandlers | null = null;
  let url = '';
  let headers: Record<string, string> = {};
  const socket: DeepgramSocket = {
    send: (data) => sent.push(data),
    close: () => {},
    readyState: 1,
  };
  return {
    sent,
    get url() { return url; },
    get headers() { return headers; },
    factory: (u: string, h: Record<string, string>, cb: DeepgramSocketHandlers) => {
      url = u; headers = h; handlers = cb;
      queueMicrotask(() => cb.onOpen());
      return socket;
    },
    server: (message: unknown) => handlers?.onMessage(JSON.stringify(message)),
    jsonSent: () => sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d)),
    audioSent: () => sent.filter((d): d is Uint8Array => typeof d !== 'string'),
  };
}

async function openDeepgram(model = 'nova-3') {
  const fake = fakeSocket();
  const signals: StreamingTranscriptionSignal[] = [];
  const provider = new DeepgramStreamingTranscriptionProvider({
    apiKey: 'test-key', model, sockets: fake.factory, endpointingMs: 300, utteranceEndMs: 1000,
  });
  const session = await provider.openStream({
    sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en',
    onSignal: (s) => signals.push(s), onError: () => {},
  });
  return { fake, signals, session, provider };
}

describe('Deepgram streaming: normalization', () => {
  it('PIN: cumulative text across multiple is_final fragments', async () => {
    // The vendor's own documentation warns: "Do not use speech_final: true alone
    // to capture full transcripts. Long utterances may have multiple
    // is_final: true responses before speech_final: true." A naive adapter would
    // emit the LAST FRAGMENT as though it were the whole sentence.
    const r = await openDeepgram();
    r.fake.server({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'the quick' }] } });
    r.fake.server({ type: 'Results', is_final: true, speech_final: false, channel: { alternatives: [{ transcript: 'the quick brown' }] } });
    r.fake.server({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'fox' }] } });
    r.fake.server({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'fox jumped' }] } });

    const final = r.signals.filter((s) => s.kind === 'final');
    expect(final).toHaveLength(1);
    expect(final[0]!.kind === 'final' && final[0]!.text).toBe('the quick brown fox jumped');
  });

  it('PIN: a stable fragment mid-utterance is still a partial to the platform', async () => {
    const r = await openDeepgram();
    r.fake.server({ type: 'Results', is_final: true, speech_final: false, channel: { alternatives: [{ transcript: 'half' }] } });
    // is_final finalizes the FRAGMENT, not the utterance. Emitting a platform
    // final here would translate and speak half a sentence.
    expect(r.signals.map((s) => s.kind)).toEqual(['partial']);
  });

  it('PIN: the utterance resets after a final', async () => {
    const r = await openDeepgram();
    r.fake.server({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'one' }] } });
    r.fake.server({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'two' }] } });
    const finals = r.signals.filter((s) => s.kind === 'final');
    // Without a reset the second utterance would carry the first one's words.
    expect(finals.map((s) => s.kind === 'final' && s.text)).toEqual(['one', 'two']);
  });

  it('PIN: UtteranceEnd is an endpoint; SpeechStarted is ignored', async () => {
    const r = await openDeepgram();
    r.fake.server({ type: 'SpeechStarted' });
    // Videofy's own VAD decides when a segment opens. Acting on this would let
    // the vendor start a platform segment.
    expect(r.signals).toHaveLength(0);
    r.fake.server({ type: 'UtteranceEnd' });
    expect(r.signals.map((s) => s.kind)).toEqual(['endpoint']);
  });

  it('PIN: the request asks for linear16 at the platform format', async () => {
    const r = await openDeepgram();
    const url = new URL(r.fake.url);
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(r.fake.headers['Authorization']).toBe('Token test-key');
  });

  it('PIN: the model is part of the provider identity', async () => {
    // A benchmark recorded against "deepgram" would be uncomparable with the
    // next one, because Flux and Nova-3 are different products.
    expect((await openDeepgram('nova-3')).provider.name).toBe('deepgram:nova-3');
    expect((await openDeepgram('flux-general-en')).provider.name).toBe('deepgram:flux-general-en');
  });

  it('PIN: audio is little-endian regardless of host architecture', async () => {
    const r = await openDeepgram();
    await r.session.pushAudio({
      samples: Int16Array.from([1, -2]), sampleRate: 16000, channelCount: 1, platformTimestampMs: 0,
    });
    const bytes = r.fake.audioSent().at(-1)!;
    // 1 -> 01 00, -2 -> fe ff. Reading .buffer directly would inherit host
    // endianness and silently send byte-swapped audio on a big-endian machine.
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xfe, 0xff]);
    expect(Array.from(pcmBytes(Int16Array.from([256])))).toEqual([0x00, 0x01]);
  });

  it('PIN: a discontinuity is declared rather than hidden', async () => {
    const r = await openDeepgram();
    await r.session.pushAudio({
      samples: Int16Array.from([1]), sampleRate: 16000, channelCount: 1,
      platformTimestampMs: 0, discontinuity: true,
    });
    // Without this the model transcribes across the gap and produces a fluent,
    // confident sentence joining two unrelated halves.
    expect(r.fake.jsonSent()).toContainEqual({ type: 'Finalize' });
  });

  it('finish flushes and close is idempotent', async () => {
    const r = await openDeepgram();
    await r.session.finish();
    expect(r.fake.jsonSent()).toContainEqual({ type: 'Finalize' });
    await r.session.close('done');
    await r.session.close('again');
    expect(r.session.isClosed).toBe(true);
    expect(r.fake.jsonSent().filter((m) => m.type === 'CloseStream')).toHaveLength(1);
  });

  it('PIN: no vendor field escapes the adapter', async () => {
    const r = await openDeepgram();
    r.fake.server({ type: 'Results', is_final: true, speech_final: true, start: 1.5, duration: 0.5,
      channel: { alternatives: [{ transcript: 'x', confidence: 0.9 }] } });
    const signal = r.signals.at(-1)!;
    const keys = Object.keys(signal);
    // `is_final`, `speech_final`, `channel`, `alternatives` are Deepgram's
    // vocabulary and must end here.
    for (const leaked of ['is_final', 'speech_final', 'channel', 'alternatives']) {
      expect(keys).not.toContain(leaked);
    }
    // Vendor timings survive only as clearly-labelled observations.
    expect(signal.kind === 'final' && signal.providerStartMs).toBe(1500);
    expect(signal.kind === 'final' && signal.providerEndMs).toBe(2000);
  });
});

// --- Deepgram batch --------------------------------------------------------

describe('Deepgram batch', () => {
  const audioPath = join(dir, 'audio.wav');
  writeFileSync(audioPath, 'RIFFfake');

  function batch(status: number, payload: unknown) {
    const seen: { url: string; init: RequestInit }[] = [];
    const provider = new DeepgramBatchTranscriptionProvider({
      apiKey: 'k', model: 'nova-3',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify(payload), { status });
      }) as unknown as typeof fetch,
    });
    return { provider, seen };
  }

  it('prefers utterance segmentation over one wall of text', async () => {
    const b = batch(200, {
      metadata: { duration: 3 },
      results: {
        channels: [{ detected_language: 'en', alternatives: [{ transcript: 'a b', confidence: 0.8 }] }],
        utterances: [
          { transcript: 'a', start: 0, end: 1 },
          { transcript: '  ', start: 1, end: 1.2 },
          { transcript: 'b', start: 1.5, end: 3 },
        ],
      },
    });
    const result = await b.provider.transcribe({
      sessionId: 'cs_1', streamId: 'st_1', audioPath, sourceLanguage: 'en',
      chunk: {} as never,
    });
    // One segment for the whole chunk would make downstream timing wrong for
    // everything after the first sentence.
    expect(result.segments.map((s) => [s.text, s.startMs, s.endMs])).toEqual([
      ['a', 0, 1000],
      ['b', 1500, 3000],
    ]);
    expect(result.detectedLanguage).toBe('en');
  });

  it('PIN: a declared source language is not overridden by detection', async () => {
    const b = batch(200, { results: { channels: [{ alternatives: [{ transcript: 'x' }] }] } });
    await b.provider.transcribe({
      sessionId: 'cs_1', streamId: 'st_1', audioPath, sourceLanguage: 'en',
      sourceLanguageMode: 'manual', chunk: {} as never,
    });
    const url = new URL(b.seen[0]!.url);
    expect(url.searchParams.get('language')).toBe('en');
    // The session already knows. Letting the vendor guess adds one more thing
    // able to disagree with session policy.
    expect(url.searchParams.get('detect_language')).toBeNull();
  });

  it('a vendor error becomes a platform error, not a crash', async () => {
    const b = batch(500, { err: 'nope' });
    // Asserted on the CODE rather than `toBeInstanceOf`. Callers branch on the
    // code, and instanceof across module graphs is fragile enough that it
    // failed here for reasons about module identity rather than about the
    // error -- a test that fails for the wrong reason teaches the wrong lesson.
    await expect(
      b.provider.transcribe({ sessionId: 'c', streamId: 's', audioPath, chunk: {} as never }),
    ).rejects.toMatchObject({ name: 'MediaIngestError', code: 'transcription-failed' });
  });
});

// --- Google translation ----------------------------------------------------

describe('Google translation', () => {
  function google(status: number, payload: unknown) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const provider = new GoogleTimestampedTranslationProvider({
      projectId: 'proj', getAccessToken: async () => 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(payload), { status });
      }) as unknown as typeof fetch,
    });
    return { provider, seen };
  }

  const input = {
    sessionId: 'cs_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 0,
    sourceLanguage: 'en', targetLanguage: 'es', sourceText: 'hello', startMs: 0, endMs: 500,
  };

  it('sends the documented v3 shape and reads translatedText', async () => {
    const g = google(200, { translations: [{ translatedText: 'hola' }] });
    const result = await g.provider.translate(input);
    expect(result.translatedText).toBe('hola');
    expect(g.seen[0]!.url).toContain('/v3/projects/proj/locations/global:translateText');
    expect(g.seen[0]!.body).toMatchObject({
      contents: ['hello'], sourceLanguageCode: 'en', targetLanguageCode: 'es', mimeType: 'text/plain',
    });
  });

  it('PIN: a 400 becomes unsupported-language so the composite can reroute', async () => {
    const g = google(400, { error: 'unsupported' });
    // The existing composite learns unsupported PAIRS from this exact code. A
    // generic failure would retry the same doomed pair forever.
    await expect(g.provider.translate(input)).rejects.toMatchObject({ code: 'unsupported-language' });
  });

  it('PIN: the health check does not spend money', async () => {
    let called = 0;
    const provider = new GoogleTimestampedTranslationProvider({
      projectId: 'p', getAccessToken: async () => 'tok',
      fetchImpl: (async () => { called += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe('ready');
    // A probe that translates on every check is one that gets disabled, and
    // then nothing is checked at all.
    expect(called).toBe(0);
  });
});

// --- ElevenLabs ------------------------------------------------------------

describe('ElevenLabs TTS', () => {
  function eleven(chunks: string[], status = 200) {
    const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: 'k', modelId: 'eleven_flash_v2_5',
      voiceIds: { 'videofy-es': 'vendor-voice-1' }, defaultVoiceId: 'vendor-default',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
        if (status !== 200) return new Response('bad', { status });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { provider, seen };
  }

  const input = {
    sessionId: 'cs_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 0,
    targetLanguage: 'es', translatedText: 'hola mundo', startMs: 0, endMs: 900,
    voiceId: 'videofy-es', outputPath: join(dir, 'out.pcm'),
  };

  it('streams chunks to disk and records time to first chunk', async () => {
    const e = eleven(['aa', 'bb', 'cc']);
    const result = await e.provider.generate(input);
    expect(readFileSync(result.audioPath, 'utf8')).toBe('aabbcc');
    const metrics = e.provider.metrics.at(-1)!;
    expect(metrics.chunks).toBe(3);
    // Recorded so C-AI1.2 can measure what progressive DELIVERY would be worth;
    // today delivery still waits for the complete file.
    expect(metrics.timeToFirstChunkMs).not.toBeNull();
  });

  it('PIN: requests pcm_16000, the engine format, and the streaming endpoint', async () => {
    const e = eleven(['x']);
    await e.provider.generate(input);
    expect(e.seen[0]!.url).toContain('/stream');
    expect(e.seen[0]!.url).toContain('output_format=pcm_16000');
    // The platform's voice id is mapped here; the vendor never sees ours.
    expect(e.seen[0]!.url).toContain('vendor-voice-1');
    expect(e.seen[0]!.headers['xi-api-key']).toBe('k');
    expect(e.seen[0]!.body['model_id']).toBe('eleven_flash_v2_5');
  });

  it('PIN: the deprecated latency knob is not sent', async () => {
    const e = eleven(['x']);
    await e.provider.generate(input);
    // Documented as deprecated. Shipping it borrows a migration from the future.
    expect(Object.keys(e.seen[0]!.body)).not.toContain('optimize_streaming_latency');
  });

  it('PIN: zero bytes is an error, not silent silence', async () => {
    const e = eleven([]);
    // A zero-byte file would be served as perfectly valid silence, and a
    // listener would hear nothing with nobody knowing why.
    await expect(e.provider.generate(input)).rejects.toMatchObject({
      name: 'MediaIngestError',
      code: 'tts-failed',
    });
  });

  it('the model is part of the provider identity', () => {
    const e = eleven(['x']);
    expect(e.provider.name).toBe('elevenlabs:eleven_flash_v2_5');
  });
});
