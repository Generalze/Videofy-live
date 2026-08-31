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
  DEFAULT_UTTERANCE_END_MS,
  DeepgramNovaStreamingProvider,
} from '../providers/deepgram/nova-streaming-stt.js';
import {
  DeepgramFluxStreamingProvider,
  FLUX_RECOMMENDED_FRAME_SAMPLES,
} from '../providers/deepgram/flux-streaming-stt.js';
import {
  pcmBytes,
  type DeepgramSocket,
  type DeepgramSocketHandlers,
} from '../providers/deepgram/transport.js';
import { DeepgramBatchTranscriptionProvider } from '../providers/deepgram/batch-stt.js';
import { GoogleTimestampedTranslationProvider } from '../providers/google/translation.js';
import type { GoogleTranslationConfig } from '../providers/google/translation.js';
import {
  ElevenLabsStreamingSynthesisProvider,
  ElevenLabsTextToSpeechProvider,
  Pcm16Decoder,
} from '../providers/elevenlabs/tts.js';
import type { SynthesisChunk } from '../streaming-speech-synthesis-provider.js';
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
  const provider = new DeepgramNovaStreamingProvider({
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
    // next one, because Flux and Nova-3 are different products on different
    // protocols. Flux identity is asserted in its own suite below.
    expect((await openDeepgram('nova-3')).provider.name).toBe('deepgram:nova-3');
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
  function google(
    status: number,
    payload: unknown,
    overrides: Partial<GoogleTranslationConfig> = {},
  ) {
    const seen: {
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }[] = [];
    const provider = new GoogleTimestampedTranslationProvider({
      projectId: 'proj',
      authorize: async () => ({
        headers: { authorization: 'Bearer tok', 'x-goog-user-project': 'quota-proj' },
        quotaProjectId: 'quota-proj',
      }),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          headers: init.headers as Record<string, string>,
        });
        return new Response(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
          { status },
        );
      }) as unknown as typeof fetch,
      ...overrides,
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

  it('PIN: the quota project reaches the wire as x-goog-user-project', async () => {
    const g = google(200, { translations: [{ translatedText: 'hola' }] });
    await g.provider.translate(input);
    // The whole of C-AI1.1F. Asking ADC for only a token discarded this
    // header, and Google answered 403 -- a permissions error for a caller
    // whose permissions were fine.
    expect(g.seen[0]!.headers['x-goog-user-project']).toBe('quota-proj');
    expect(g.seen[0]!.headers['authorization']).toBe('Bearer tok');
  });

  it('PIN: the resource project and the quota project stay separate', async () => {
    const g = google(200, { translations: [{ translatedText: 'hola' }] }, {
      projectId: 'resource-project',
      quotaProjectId: 'billing-project',
    });
    await g.provider.translate(input);
    // A service account in one project calling a resource in another is
    // ordinary. Collapsing the two would break exactly that case.
    expect(g.seen[0]!.url).toContain('/v3/projects/resource-project/');
    expect(g.seen[0]!.url).not.toContain('billing-project');
    expect(g.seen[0]!.headers['x-goog-user-project']).toBe('billing-project');
  });

  it('PIN: an explicit quota project overrides the credential', async () => {
    const g = google(200, { translations: [{ translatedText: 'hola' }] }, {
      quotaProjectId: 'stated-by-deployment',
    });
    await g.provider.translate(input);
    // A deployment told which project to bill is stating policy; a credential's
    // quota project is whatever `gcloud` last set on somebody's laptop.
    expect(g.seen[0]!.headers['x-goog-user-project']).toBe('stated-by-deployment');
  });

  it('PIN: no quota project sends no header, rather than an empty one', async () => {
    const g = google(200, { translations: [{ translatedText: 'hola' }] }, {
      authorize: async () => ({ headers: { authorization: 'Bearer tok' }, quotaProjectId: null }),
    });
    await g.provider.translate(input);
    // An empty `x-goog-user-project` is not "no quota project", it is a
    // malformed one, and Google rejects it differently -- sending whoever
    // debugs it to look in entirely the wrong place.
    expect(g.seen[0]!.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('PIN: a failure carries Google own words, not just a status code', async () => {
    const g = google(
      403,
      '{"error":{"code":403,"message":"Cloud Translation API has not been used in project 12345 before or it is disabled","status":"PERMISSION_DENIED"}}',
    );
    // "HTTP 403" cost a live validation session. The body names the actual
    // problem every time; the status code names it never.
    await expect(g.provider.translate(input)).rejects.toMatchObject({
      code: 'translation-failed',
    });
    await expect(g.provider.translate(input)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(g.provider.translate(input)).rejects.toThrow(/has not been used in project/);
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
      projectId: 'p',
      authorize: async () => ({ headers: { authorization: 'Bearer tok' }, quotaProjectId: null }),
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
    // The file surface remains correct for uploaded programmes and lip-fit
    // pacing. Live calls use the streaming surface below instead.
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

// --- the Deepgram protocol split ------------------------------------------

describe('Nova and Flux are different protocols, not one API', () => {
  const sockets = () => fakeSocket().factory;

  it('PIN: a Flux model cannot be driven through the Nova adapter', () => {
    // The defect this corrective wave exists for. A generic adapter pointed
    // Flux at /v1 and parsed it with the Nova vocabulary -- a well-tested
    // adapter speaking the wrong protocol, producing no transcripts at all,
    // which on a call looks exactly like a speaker who said nothing.
    expect(
      () => new DeepgramNovaStreamingProvider({ apiKey: 'k', model: 'flux-general-en', sockets: sockets() }),
    ).toThrow(/Listen v2/);
  });

  it('PIN: a Nova model cannot be driven through the Flux adapter', () => {
    expect(
      () => new DeepgramFluxStreamingProvider({ apiKey: 'k', model: 'nova-3', sockets: sockets() }),
    ).toThrow(/not a Flux model/);
  });

  it('PIN: Flux is streaming-only and refuses the batch path', () => {
    expect(
      () => new DeepgramBatchTranscriptionProvider({ apiKey: 'k', model: 'flux-general-en' }),
    ).toThrow(/streaming-only/);
  });
});

async function openFlux(overrides: Record<string, unknown> = {}) {
  const fake = fakeSocket();
  const signals: StreamingTranscriptionSignal[] = [];
  const provider = new DeepgramFluxStreamingProvider({
    apiKey: 'test-key', model: 'flux-general-en', sockets: fake.factory, ...overrides,
  } as never);
  const session = await provider.openStream({
    sessionId: 'cs_1', streamId: 'st_1', onSignal: (s) => signals.push(s), onError: () => {},
  });
  return { fake, signals, session, provider };
}

const turn = (event: string, transcript = '', extra: Record<string, unknown> = {}) => ({
  type: 'TurnInfo', event, transcript, ...extra,
});

describe('a declared source language is honoured, or the session is refused', () => {
  // MEASURED 2026-08-30, on staging credentials from c7-eu-01: Nova refused
  // `yo` with HTTP 400 at connect while Flux OPENED the same session and
  // returned fluent English, and `zz-not-a-language` opened on Flux too. Two
  // adapters failing in opposite directions on identical input is worse than
  // either failure alone, because the safe one hides how unsafe the other is.

  it('PIN: Nova sends the session language on the wire', async () => {
    const r = await openDeepgram();
    expect(new URL(r.fake.url).searchParams.get('language')).toBe('en');
  });

  it('PIN: Flux refuses a language its single-language model cannot serve', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramFluxStreamingProvider({
      apiKey: 'k', model: 'flux-general-en', sockets: fake.factory,
    });
    await expect(
      provider.openStream({
        sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'yo',
        onSignal: () => {}, onError: () => {},
      }),
    ).rejects.toThrow(/cannot transcribe "yo"/);
    // Refused BEFORE the socket: no vendor call, no audio accepted.
    expect(fake.url).toBe('');
  });

  it('PIN: Flux refuses a language that is not a language at all', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramFluxStreamingProvider({
      apiKey: 'k', model: 'flux-general-en', sockets: fake.factory,
    });
    await expect(
      provider.openStream({
        sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'zz-not-a-language',
        onSignal: () => {}, onError: () => {},
      }),
    ).rejects.toThrow(/cannot transcribe/);
  });

  it('PIN: Flux accepts the language its model does serve, region and all', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramFluxStreamingProvider({
      apiKey: 'k', model: 'flux-general-en', sockets: fake.factory,
    });
    await expect(
      provider.openStream({
        sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en-NG',
        onSignal: () => {}, onError: () => {},
      }),
    ).resolves.toBeDefined();
  });

  it('PIN: a session that claims no language is not contradicted', async () => {
    // auto-detect has made no claim the adapter could refuse.
    const fake = fakeSocket();
    const provider = new DeepgramFluxStreamingProvider({
      apiKey: 'k', model: 'flux-general-en', sockets: fake.factory,
    });
    await expect(
      provider.openStream({
        sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'yo',
        sourceLanguageMode: 'auto-detect', onSignal: () => {}, onError: () => {},
      }),
    ).resolves.toBeDefined();
  });

  it('PIN: a multi Flux model carries the SESSION language as language_hint', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramFluxStreamingProvider({
      apiKey: 'k', model: 'flux-general-multi', sockets: fake.factory, languageHint: 'en',
    });
    await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'es',
      onSignal: () => {}, onError: () => {},
    });
    // The session outranks the deployment default; a deployment-wide hint that
    // silently overrode a per-call language is the same defect, quieter.
    expect(new URL(fake.url).searchParams.get('language_hint')).toBe('es');
  });
});

describe('requestEndpointing is wiring, not decoration', () => {
  // MEASURED 2026-08-30: `LiveStreamPipeline.open` sets `requestEndpointing:
  // true` on every live session and NO adapter read it, so Nova was never sent
  // `utterance_end_ms`, never sent `vad_events`, and produced 0 endpoint
  // signals across 38 live samples. The platform's candidate-boundary path was
  // dead in production and looked alive in source.

  it('PIN: a session asking for endpointing gets utterance_end_ms and vad_events', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramNovaStreamingProvider({
      apiKey: 'k', model: 'nova-3', sockets: fake.factory,
    });
    await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en',
      requestEndpointing: true, onSignal: () => {}, onError: () => {},
    });
    const params = new URL(fake.url).searchParams;
    expect(params.get('utterance_end_ms')).toBe(String(DEFAULT_UTTERANCE_END_MS));
    expect(params.get('vad_events')).toBe('true');
  });

  it('PIN: a session that does not ask for it is not given it', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramNovaStreamingProvider({
      apiKey: 'k', model: 'nova-3', sockets: fake.factory,
    });
    await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en',
      onSignal: () => {}, onError: () => {},
    });
    const params = new URL(fake.url).searchParams;
    expect(params.get('utterance_end_ms')).toBeNull();
    expect(params.get('vad_events')).toBeNull();
  });

  it('PIN: an explicit deployment value still wins over the default', async () => {
    const fake = fakeSocket();
    const provider = new DeepgramNovaStreamingProvider({
      apiKey: 'k', model: 'nova-3', sockets: fake.factory, utteranceEndMs: 2500,
    });
    await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en',
      requestEndpointing: true, onSignal: () => {}, onError: () => {},
    });
    expect(new URL(fake.url).searchParams.get('utterance_end_ms')).toBe('2500');
  });

  it('PIN: the endpoint signal the pipeline asked for actually reaches it', async () => {
    const signals: StreamingTranscriptionSignal[] = [];
    const fake = fakeSocket();
    const provider = new DeepgramNovaStreamingProvider({
      apiKey: 'k', model: 'nova-3', sockets: fake.factory,
    });
    await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', sourceLanguage: 'en',
      requestEndpointing: true, onSignal: (s) => signals.push(s), onError: () => {},
    });
    fake.server({ type: 'UtteranceEnd', last_word_end: 1.25 });
    expect(signals.filter((s) => s.kind === 'endpoint')).toHaveLength(1);
  });
});

describe('Flux TurnInfo normalization', () => {
  it('PIN: Flux connects to v2, never v1', async () => {
    const r = await openFlux();
    expect(r.fake.url).toContain('/v2/listen');
    expect(r.fake.url).not.toContain('/v1/listen');
    const url = new URL(r.fake.url);
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('model')).toBe('flux-general-en');
  });

  it('PIN: EndOfTurn is a provider observation emitted as a final signal', async () => {
    const r = await openFlux();
    r.fake.server(turn('EndOfTurn', 'all done', { audio_window_start: 1, audio_window_end: 2.5, end_of_turn_confidence: 0.88 }));
    const signal = r.signals.at(-1)!;
    expect(signal.kind).toBe('final');
    expect(signal.kind === 'final' && signal.text).toBe('all done');
    // Vendor timings survive only as observations; the coordinator still owns
    // whether the Videofy segment is final.
    expect(signal.kind === 'final' && signal.providerStartMs).toBe(1000);
    expect(signal.kind === 'final' && signal.providerEndMs).toBe(2500);
  });

  it('PIN: EagerEndOfTurn is speculative and never a boundary', async () => {
    const r = await openFlux();
    r.fake.server(turn('EagerEndOfTurn', 'maybe done'));
    // A false start here does not waste an API call -- it starts SPEAKING a
    // translation while the person is still correcting themselves, and spoken
    // audio cannot be recalled.
    expect(r.signals.map((s) => s.kind)).toEqual(['partial']);
  });

  it('PIN: eager end-of-turn is off unless explicitly configured', async () => {
    const plain = await openFlux();
    expect(new URL(plain.fake.url).searchParams.get('eager_eot_threshold')).toBeNull();
    const eager = await openFlux({ eagerEotThreshold: 0.6 });
    expect(new URL(eager.fake.url).searchParams.get('eager_eot_threshold')).toBe('0.6');
  });

  it('PIN: StartOfTurn does not open a platform segment', async () => {
    const r = await openFlux();
    r.fake.server(turn('StartOfTurn'));
    // Videofy's VAD owns segment start. Same rule as Nova's SpeechStarted.
    expect(r.signals).toHaveLength(0);
  });

  it('TurnResumed continues the turn as a partial', async () => {
    const r = await openFlux();
    r.fake.server(turn('EagerEndOfTurn', 'half'));
    r.fake.server(turn('TurnResumed', 'half and more'));
    expect(r.signals.map((s) => s.kind)).toEqual(['partial', 'partial']);
    const last = r.signals.at(-1)!;
    expect(last.kind === 'partial' && last.text).toBe('half and more');
  });

  it('PIN: no v2 field escapes the adapter', async () => {
    const r = await openFlux();
    r.fake.server(turn('EndOfTurn', 'x', { turn_index: 4, sequence_id: 9, words: [{ word: 'x', start: 0, end: 1 }] }));
    const keys = Object.keys(r.signals.at(-1)!);
    for (const leaked of ['event', 'turn_index', 'sequence_id', 'words', 'end_of_turn_confidence']) {
      expect(keys).not.toContain(leaked);
    }
  });
});

describe('Flux packetization stays inside the vendor boundary', () => {
  it('PIN: the platform frame size is not reshaped by the vendor', async () => {
    const r = await openFlux();
    // Videofy sends 20 ms frames (320 samples at 16 kHz). Flux prefers 80 ms.
    for (let i = 0; i < 3; i += 1) {
      await r.session.pushAudio({
        samples: new Int16Array(320).fill(i + 1), sampleRate: 16000, channelCount: 1,
        platformTimestampMs: i * 20,
      });
    }
    // 960 samples: not yet a full 1280-sample packet, so nothing has been sent.
    expect(r.fake.audioSent()).toHaveLength(0);
    expect(FLUX_RECOMMENDED_FRAME_SAMPLES).toBe(1280);

    await r.session.pushAudio({
      samples: new Int16Array(320).fill(4), sampleRate: 16000, channelCount: 1, platformTimestampMs: 60,
    });
    // 1280 samples: exactly one vendor-sized packet.
    expect(r.fake.audioSent()).toHaveLength(1);
    expect(r.fake.audioSent()[0]!.byteLength).toBe(1280 * 2);
  });

  it('PIN: packetization preserves sample order across platform frames', async () => {
    const r = await openFlux({ frameSamples: 4 });
    await r.session.pushAudio({
      samples: Int16Array.from([1, 2, 3]), sampleRate: 16000, channelCount: 1, platformTimestampMs: 0,
    });
    await r.session.pushAudio({
      samples: Int16Array.from([4, 5, 6, 7, 8]), sampleRate: 16000, channelCount: 1, platformTimestampMs: 20,
    });
    const decode = (bytes: Uint8Array) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
    };
    // Two whole packets, in order, spanning the boundary between platform frames.
    expect(r.fake.audioSent().map(decode)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
  });

  it('PIN: buffering is bounded by one packet', async () => {
    const r = await openFlux({ frameSamples: 4 });
    for (let i = 0; i < 10; i += 1) {
      await r.session.pushAudio({
        samples: Int16Array.from([1, 2, 3]), sampleRate: 16000, channelCount: 1, platformTimestampMs: i * 20,
      });
      // Never accumulates: whole packets leave as soon as they are complete.
      expect((r.session as unknown as { bufferedSamples: number }).bufferedSamples).toBeLessThan(4);
    }
  });

  it('PIN: finish flushes the trailing part-packet', async () => {
    const r = await openFlux({ frameSamples: 4 });
    await r.session.pushAudio({
      samples: Int16Array.from([9, 9]), sampleRate: 16000, channelCount: 1, platformTimestampMs: 0,
    });
    expect(r.fake.audioSent()).toHaveLength(0);
    await r.session.finish();
    // The last part-packet is the end of somebody's sentence, not padding.
    expect(r.fake.audioSent()).toHaveLength(1);
    expect(r.fake.audioSent()[0]!.byteLength).toBe(4);
  });
});

// --- ElevenLabs streaming surface ------------------------------------------

describe('ElevenLabs streaming synthesis', () => {
  function streaming(chunks: Uint8Array[], status = 200) {
    const seen: { url: string }[] = [];
    const provider = new ElevenLabsStreamingSynthesisProvider({
      apiKey: 'k', modelId: 'eleven_flash_v2_5',
      voiceIds: { 'videofy-es': 'vendor-voice-1' }, defaultVoiceId: 'vendor-default',
      fetchImpl: (async (url: string) => {
        seen.push({ url: String(url) });
        if (status !== 200) return new Response('bad', { status });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { provider, seen };
  }

  async function run(provider: ElevenLabsStreamingSynthesisProvider, signal?: AbortSignal) {
    const got: SynthesisChunk[] = [];
    const errors: Error[] = [];
    const result = await provider.synthesize({
      text: 'hola mundo', targetLanguage: 'es', voiceId: 'videofy-es',
      onChunk: (chunk) => got.push(chunk),
      onError: (error) => errors.push(error),
      ...(signal === undefined ? {} : { signal }),
    });
    return { got, errors, result };
  }

  it('PIN: a sample split across two chunks survives the boundary', async () => {
    // 0x0102 and 0x0304, little-endian, cut between the two bytes of the first.
    const e = streaming([Uint8Array.from([0x02]), Uint8Array.from([0x01, 0x04, 0x03])]);
    const r = await run(e.provider);
    // Dropping the odd byte would pair the low half of each sample with the
    // high half of the next, and the rest of the sentence would decode as
    // loud noise rather than speech.
    expect(r.got.flatMap((c) => Array.from(c.samples))).toEqual([0x0102, 0x0304]);
    expect(r.result.samples).toBe(2);
  });

  it('PIN: decoding is little-endian by declaration, not by host luck', () => {
    const decoder = new Pcm16Decoder();
    expect(Array.from(decoder.push(Uint8Array.from([0x00, 0x01])))).toEqual([256]);
    expect(decoder.hasPartialSample).toBe(false);
    decoder.push(Uint8Array.from([0x07]));
    expect(decoder.hasPartialSample).toBe(true);
  });

  it('PIN: a caller abort stops synthesis and reports it, without throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const e = streaming([Uint8Array.from([1, 0, 2, 0])]);
    // A superseded sentence must stop costing money and bandwidth at once.
    const r = await run(e.provider, controller.signal);
    expect(r.result.aborted).toBe(true);
    expect(r.got).toHaveLength(0);
  });

  it('PIN: zero bytes is an error, not silent silence', async () => {
    const e = streaming([]);
    await expect(run(e.provider)).rejects.toMatchObject({ code: 'tts-failed' });
  });

  it('PIN: a vendor error is an error rather than an empty sentence', async () => {
    const e = streaming([], 502);
    await expect(run(e.provider)).rejects.toMatchObject({ code: 'tts-failed' });
  });

  it('PIN: chunks carry audio and nothing that could name it', async () => {
    const e = streaming([Uint8Array.from([1, 0, 2, 0])]);
    const r = await run(e.provider);
    // A synthesis adapter that could set a segment id, generation or sequence
    // would be a vendor deciding what Videofy calls its own audio.
    expect(Object.keys(r.got[0]!)).toEqual(['samples']);
  });

  it('uses the streaming endpoint, the engine format, and the mapped voice', async () => {
    const e = streaming([Uint8Array.from([1, 0])]);
    await run(e.provider);
    expect(e.seen[0]!.url).toContain('/stream');
    expect(e.seen[0]!.url).toContain('output_format=pcm_16000');
    expect(e.seen[0]!.url).toContain('vendor-voice-1');
    expect(e.provider.name).toBe('elevenlabs-streaming:eleven_flash_v2_5');
  });
});
