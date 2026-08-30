#!/usr/bin/env node
/** @author masterzee001 */
/**
 * C-AI1.2 -- benchmark the configured commercial providers and PROPOSE evidence.
 *
 * WHAT THIS IS. Real traffic, N samples per (provider, capability, language
 * route), run FROM THE HOST THAT HOLDS THE KEYS, measuring per-sample latency
 * and success, and printing (a) a human table and (b) a JSON block of
 * `LiveObservation` records ready to be pasted into
 * `services/ai-registry/src/commercial-providers.ts`.
 *
 * WHAT THIS IS NOT, AND MUST NEVER BECOME. It does not write the registry.
 * Proposing is this file's job; a human-reviewed edit is the other half, and
 * keeping the halves apart is the only thing that stops a benchmark harness
 * from certifying its own vendors on a bad night. `stageEvidenceComplaints()`
 * is the gate; this is only the measurement.
 *
 * WHY IT RUNS ON THE BOX. The vendor keys live in `/etc/videofy/media-ingest.env`
 * at 0640 root:videofy and there is no reason for them to exist anywhere else,
 * least of all in a developer's shell history. The script reads that file
 * itself, reports which NAMES are present, and never prints or returns a value.
 *
 *     sudo node scripts/certify-providers.mjs --samples 5 --speech /tmp/speech-en.wav
 *
 * FOUR HONESTY RULES, each of which exists because the opposite is easy:
 *
 *   1. A MISSING KEY IS A SKIP, NOT A FAILURE AND NOT A PASS. The provider
 *      keeps whatever stage it earned and the table says why.
 *   2. A 429 IS EVIDENCE ABOUT THE PLAN, NOT ABOUT THE PROVIDER. The run stops
 *      immediately for that check and NO latency observation is proposed: a
 *      distribution measured half inside a rate limiter describes the limiter.
 *   3. A COLD START IS REPORTED AS A COLD START. 9jaLingo scales to zero, so
 *      the first request after an idle period can answer 503 or take seconds.
 *      That sample is recorded separately and excluded from the warm
 *      distribution rather than averaged into it or quietly dropped.
 *   4. EVERY NUMBER COMES FROM A RUN THAT HAPPENED. There is no synthetic
 *      fallback anywhere in this file. If a check cannot run, it says so, and
 *      the absence of a number is the result.
 *
 * THE SPEECH FIXTURE IS SYNTHETIC AND THE OBSERVATIONS SAY SO. A recogniser
 * given a tone correctly returns nothing, so the fixture has to be speech; it
 * is a 16 kHz mono WAV of a known English sentence. Synthetic speech is CLEAN
 * speech, so a transcription latency measured on it is a floor rather than a
 * representative sample of a noisy room -- and the proposed summary states
 * that, rather than leaving a later reader to assume otherwise.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// --- arguments -------------------------------------------------------------

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const SAMPLES = Math.max(1, Number.parseInt(argValue('--samples', '5'), 10) || 5);
const ENV_PATH = argValue('--env', '/etc/videofy/media-ingest.env');
const DIST_ROOT = argValue(
  '--dist',
  '/srv/videofy/app/services/media-ingest/dist/services/media-ingest/src',
);
const SPEECH_WAV = argValue('--speech', '/tmp/videofy-certify/speech-en.wav');
const ONLY = argValue('--only', '');
const GAP_MS = Math.max(0, Number.parseInt(argValue('--gap-ms', '750'), 10) || 0);
const ENVIRONMENT_LABEL = argValue('--environment', 'staging (c7-eu-01)');
/**
 * How long to wait for scale-to-zero capacity to come up before giving up.
 *
 * The vendor's own 503 says "retry in about five minutes", so a budget shorter
 * than that would record "9jaLingo does not work" when what happened is
 * "9jaLingo was asleep and nobody waited". Eight minutes by default.
 */
const WARM_BUDGET_MS = Math.max(
  0,
  Number.parseInt(argValue('--warm-budget-ms', '480000'), 10) || 0,
);

const selected = ONLY.trim() === '' ? null : new Set(ONLY.split(',').map((part) => part.trim()));
const wanted = (id) => selected === null || selected.has(id);

const work = mkdtempSync(join(tmpdir(), 'certify-'));

// --- environment: NAMES leave this scope, values never do -------------------

/**
 * Load the service env file into `process.env` without overriding a real one.
 *
 * The same file systemd hands the service, so what is measured is what
 * production would be configured from -- rather than a parallel set of
 * credentials nobody deploys, which is how a benchmark ends up describing a
 * configuration that does not exist.
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return { loaded: false };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(
      `Cannot read ${path} (${error?.code ?? 'error'}). This script must run on the host that ` +
        'holds the keys, with permission to read the service env file -- try sudo.',
    );
    process.exit(2);
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
  return { loaded: true };
}

/** A configured value, or null. No caller prints one. */
const env = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/** Presence by NAME. The only credential fact allowed into any output. */
const present = (name) => env(name) !== null;

// --- results ---------------------------------------------------------------

/**
 * One benchmarked route.
 *
 * `outcome` is deliberately five-valued. `skipped`, `rate-limited` and `failed`
 * are three different sentences about a provider, and a harness with one
 * "not ok" bucket loses the difference between "we hold no key", "the plan
 * throttled us" and "the adapter is broken" -- three problems answered by three
 * different people.
 */
const results = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Median, reported beside the mean because one slow sample moves a mean. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function stats(values) {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    minMs: Math.min(...values),
    medianMs: median(values),
    meanMs: Math.round(sum / values.length),
    maxMs: Math.max(...values),
  };
}

/** Rate limiting, however the vendor spells it. */
function isRateLimited(error) {
  const text = String(error?.message ?? error ?? '');
  return /\b429\b/u.test(text) || /rate.?limit/iu.test(text) || /too many requests/iu.test(text);
}

/** Asleep rather than broken. 9jaLingo scales to zero between requests. */
function isColdStart(error) {
  const text = String(error?.message ?? error ?? '');
  return /\b(502|503|504)\b/u.test(text) || /service unavailable/iu.test(text);
}

/**
 * Run one check N times.
 *
 * `runSample` returns `{ latencyMs, detail }` or throws. The loop stops on the
 * FIRST rate limit, because every sample after one measures the limiter and not
 * the vendor.
 */
async function benchmark(spec) {
  const { id, label, capability, providerId, modelId, languages, runSample } = spec;
  const coldStartTolerated = spec.coldStartTolerated === true;
  if (!wanted(id)) return;

  const warm = [];
  const details = [];
  const coldSamples = [];
  let failures = 0;
  let lastError = null;

  for (let i = 0; i < SAMPLES; i += 1) {
    try {
      const sample = await runSample(i);
      warm.push(sample.latencyMs);
      if (sample.detail !== undefined) details.push(sample.detail);
    } catch (error) {
      lastError = error;
      if (isRateLimited(error)) {
        results.push({
          id,
          label,
          capability,
          providerId,
          modelId,
          languages,
          outcome: 'rate-limited',
          attempted: i + 1,
          note:
            `the vendor answered 429 on sample ${i + 1} of ${SAMPLES}. That is evidence about the ` +
            'PLAN, not about the provider, so no latency observation is proposed.',
        });
        return;
      }
      if (coldStartTolerated && isColdStart(error) && coldSamples.length === 0) {
        // Recorded, then retried once after a wait. Excluded from the warm
        // distribution on purpose: the first request to a scaled-to-zero
        // service measures a container start, which is a real fact about the
        // vendor and a DIFFERENT fact from steady-state latency.
        coldSamples.push(String(error?.message ?? error).slice(0, 160));
        await sleep(8000);
        i -= 1;
        continue;
      }
      failures += 1;
    }
    if (i < SAMPLES - 1) await sleep(GAP_MS);
  }

  if (warm.length === 0) {
    results.push({
      id,
      label,
      capability,
      providerId,
      modelId,
      languages,
      outcome: 'failed',
      attempted: SAMPLES,
      coldSamples,
      note: String(lastError?.message ?? lastError ?? 'no sample succeeded').slice(0, 240),
    });
    return;
  }

  results.push({
    id,
    label,
    capability,
    providerId,
    modelId,
    languages,
    outcome: failures === 0 ? 'ok' : 'partial',
    attempted: SAMPLES,
    succeeded: warm.length,
    failures,
    coldSamples,
    latency: stats(warm),
    details,
    ...(lastError === null
      ? {}
      : { lastError: String(lastError?.message ?? lastError).slice(0, 200) }),
  });
}

function skip(id, label, capability, providerId, reason) {
  if (!wanted(id)) return;
  results.push({ id, label, capability, providerId, outcome: 'skipped', note: reason });
}

// --- the speech fixture ----------------------------------------------------

/** Minimal RIFF read. Returns 16-bit samples and the rate the file DECLARES. */
function readWavPcm16(path) {
  const buffer = readFileSync(path);
  const dataIndex = buffer.indexOf('data', 12, 'ascii');
  if (dataIndex < 0) throw new Error('no data chunk in WAV');
  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const start = dataIndex + 8;
  const length = buffer.readUInt32LE(dataIndex + 4);
  const samples = new Int16Array(Math.floor(length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(start + i * 2);
  return { samples, rate, channels };
}

// --- Deepgram streaming: the LIVE path staging and production both use ------

/**
 * Nova-3 over Listen v1, THROUGH THE REAL ADAPTER.
 *
 * The measured metric is TIME TO FIRST NON-EMPTY TRANSCRIPT, from the moment
 * the first audio frame is pushed. Audio is fed at REAL TIME in 100 ms frames,
 * because feeding a stream faster than real time measures how quickly a vendor
 * drains a buffer -- which is not a thing any caller experiences.
 *
 * A socket that opens and then says nothing is a FAIL here, never a pass. That
 * defect was found once already in the smoke harness and is not re-earned.
 */
async function deepgramStreaming(speech) {
  const id = 'deepgram:nova-3:streaming';
  const model = env('DEEPGRAM_MODEL') ?? 'nova-3';
  const label = `Deepgram ${model} streaming STT (en)`;
  if (!present('DEEPGRAM_API_KEY')) {
    return skip(id, label, 'transcription', 'deepgram', 'DEEPGRAM_API_KEY is not set');
  }
  if (speech === null) {
    return skip(id, label, 'transcription', 'deepgram', 'no usable speech fixture (--speech)');
  }

  let DeepgramNovaStreamingProvider;
  let createDeepgramSocketFactory;
  try {
    ({ DeepgramNovaStreamingProvider } = await import(
      `${DIST_ROOT}/providers/deepgram/nova-streaming-stt.js`
    ));
    ({ createDeepgramSocketFactory } = await import(
      `${DIST_ROOT}/providers/deepgram/socket-factory.js`
    ));
  } catch (error) {
    return skip(
      id,
      label,
      'transcription',
      'deepgram',
      `built adapter not importable: ${String(error?.message ?? error).slice(0, 140)}`,
    );
  }

  const provider = new DeepgramNovaStreamingProvider({
    apiKey: env('DEEPGRAM_API_KEY'),
    model,
    sockets: createDeepgramSocketFactory(),
  });

  await benchmark({
    id,
    label,
    capability: 'transcription',
    providerId: 'deepgram',
    modelId: model,
    languages: ['en'],
    runSample: async (index) => {
      let audioStartedAt = 0;
      let firstTextMs = null;
      let finalText = '';
      let socketError = null;
      let resolveFirst = () => {};
      const firstText = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const connectStartedAt = Date.now();
      const session = await provider.openStream({
        sessionId: `certify-${index}`,
        streamId: `certify-${index}`,
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        requestEndpointing: true,
        onSignal: (signal) => {
          const text = (signal.text ?? '').trim();
          if (text !== '' && firstTextMs === null && audioStartedAt > 0) {
            firstTextMs = Date.now() - audioStartedAt;
            resolveFirst();
          }
          if (signal.kind === 'final' && text !== '') finalText = `${finalText} ${text}`.trim();
        },
        onError: (error) => {
          socketError = error;
          resolveFirst();
        },
      });
      const connectMs = Date.now() - connectStartedAt;

      const FRAME = 1600; // 100 ms at 16 kHz
      audioStartedAt = Date.now();
      try {
        for (let offset = 0; offset < speech.samples.length; offset += FRAME) {
          if (socketError !== null) break;
          const end = Math.min(offset + FRAME, speech.samples.length);
          await session.pushAudio({
            samples: speech.samples.subarray(offset, end),
            sampleRate: 16000,
            channelCount: 1,
            platformTimestampMs: (offset / 16000) * 1000,
          });
          // Real time. The vendor sees the pace a speaker actually produces.
          const shouldBeAt = audioStartedAt + (end / 16000) * 1000;
          const wait = shouldBeAt - Date.now();
          if (wait > 0) await sleep(wait);
        }
        await session.finish();
        await Promise.race([firstText, sleep(8000)]);
      } finally {
        await session.close('certification sample complete');
      }

      if (socketError !== null) throw socketError;
      if (firstTextMs === null) {
        throw new Error(
          'the socket opened and no transcript ever arrived: a PROTOCOL failure, not a slow sample',
        );
      }
      return {
        latencyMs: firstTextMs,
        detail: { connectMs, firstTranscriptMs: firstTextMs, finalChars: finalText.length },
      };
    },
  });
}

// --- Deepgram batch: the uploaded-programme path ----------------------------

async function deepgramBatch(speech) {
  const id = 'deepgram:nova-3:batch';
  const model = env('DEEPGRAM_MODEL') ?? 'nova-3';
  const label = `Deepgram ${model} batch STT (en)`;
  if (!present('DEEPGRAM_API_KEY')) {
    return skip(id, label, 'transcription', 'deepgram', 'DEEPGRAM_API_KEY is not set');
  }
  if (speech === null) {
    return skip(id, label, 'transcription', 'deepgram', 'no usable speech fixture (--speech)');
  }

  let DeepgramBatchTranscriptionProvider;
  try {
    ({ DeepgramBatchTranscriptionProvider } = await import(
      `${DIST_ROOT}/providers/deepgram/batch-stt.js`
    ));
  } catch (error) {
    return skip(
      id,
      label,
      'transcription',
      'deepgram',
      `built adapter not importable: ${String(error?.message ?? error).slice(0, 140)}`,
    );
  }

  const provider = new DeepgramBatchTranscriptionProvider({
    apiKey: env('DEEPGRAM_API_KEY'),
    model,
  });
  const durationMs = Math.round((speech.samples.length / 16000) * 1000);

  await benchmark({
    id,
    label,
    capability: 'transcription',
    providerId: 'deepgram',
    modelId: model,
    languages: ['en'],
    runSample: async (index) => {
      const started = Date.now();
      const result = await provider.transcribe({
        sessionId: `certify-${index}`,
        streamId: `certify-${index}`,
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        audioPath: SPEECH_WAV,
        chunk: {
          chunkId: `certify-${index}`,
          index,
          filename: 'speech-en.wav',
          startMs: 0,
          endMs: durationMs,
          durationMs,
          status: 'completed',
        },
      });
      const latencyMs = Date.now() - started;
      const text = (result.segments ?? [])
        .map((segment) => segment.text)
        .join(' ')
        .trim();
      // A 200 with an empty transcript is a FAILED sample. The vendor answered;
      // the recogniser did not, and folding that into a latency figure would
      // record the speed of returning nothing.
      if (text === '') throw new Error('HTTP 200 with an empty transcript');
      return { latencyMs, detail: { chars: text.length, segments: result.segments.length } };
    },
  });
}

// --- opus-mt: LOCAL, so measured THROUGH media-ingest -----------------------

/**
 * The translation route is not a vendor and has no key.
 *
 * It runs behind media-ingest, so the honest place to measure it is the seam
 * the product actually calls -- `POST /internal/text-translation` -- rather
 * than a Python process this script starts, which would measure a cold model
 * load the running service never pays twice.
 *
 * THE ROUTE SWALLOWS PROVIDER ERRORS BY DESIGN: a message must never lose words
 * to a vendor, so a failed sentence comes back as the SOURCE text with a 200.
 * `HTTP 200` is therefore not evidence here, and this check additionally
 * requires a `providerName` and output that differs from the input.
 */
async function opusMtTranslation() {
  const id = 'opus-mt:translation';
  const label = 'opus-mt translation via media-ingest (en->es)';
  const internalToken = env('INTERNAL_WEBRTC_TOKEN');
  if (internalToken === null) {
    return skip(id, label, 'translation', 'opus-mt', 'INTERNAL_WEBRTC_TOKEN is not set');
  }
  const host = env('INGEST_HOST') ?? '127.0.0.1';
  const port = env('INGEST_PORT') ?? '3002';
  const base = argValue('--ingest', `http://${host}:${port}`);

  const SENTENCES = [
    'The quarterly briefing will begin in five minutes.',
    'Please make sure your microphone is muted.',
    'The speaker will take questions at the end.',
    'We are recording this session for the archive.',
    'Thank you all for joining us today.',
  ];

  await benchmark({
    id,
    label,
    capability: 'translation',
    providerId: 'opus-mt',
    modelId: 'opus-mt',
    languages: ['en', 'es'],
    runSample: async (index) => {
      const sourceText = SENTENCES[index % SENTENCES.length];
      const started = Date.now();
      const response = await fetch(`${base}/internal/text-translation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Videofy-Internal-Token': internalToken,
        },
        body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'es', sourceText }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`media-ingest answered HTTP ${response.status}`);
      const latencyMs = Date.now() - started;
      const payload = await response.json();
      const translated = String(payload?.translatedText ?? '').trim();
      if (payload?.providerName === null || payload?.providerName === undefined) {
        throw new Error('no providerName: the route fell through and returned the source text');
      }
      if (translated === '' || translated === sourceText) {
        throw new Error('output equals the input: nothing was translated');
      }
      return {
        latencyMs,
        detail: { providerName: payload.providerName, chars: translated.length },
      };
    },
  });
}

// --- ElevenLabs TTS ---------------------------------------------------------

async function elevenLabsTts() {
  const id = 'elevenlabs:tts';
  const model = env('ELEVENLABS_MODEL') ?? 'eleven_flash_v2_5';
  const label = `ElevenLabs ${model} streaming TTS (es)`;
  if (!present('ELEVENLABS_API_KEY')) {
    return skip(id, label, 'tts', 'elevenlabs', 'ELEVENLABS_API_KEY is not set');
  }
  const defaultVoice = env('ELEVENLABS_DEFAULT_VOICE_ID');
  if (defaultVoice === null) {
    return skip(
      id,
      label,
      'tts',
      'elevenlabs',
      'ELEVENLABS_DEFAULT_VOICE_ID is not set (voice ids are account-specific)',
    );
  }

  let ElevenLabsStreamingSynthesisProvider;
  try {
    ({ ElevenLabsStreamingSynthesisProvider } = await import(
      `${DIST_ROOT}/providers/elevenlabs/tts.js`
    ));
  } catch (error) {
    return skip(
      id,
      label,
      'tts',
      'elevenlabs',
      `built adapter not importable: ${String(error?.message ?? error).slice(0, 140)}`,
    );
  }

  const provider = new ElevenLabsStreamingSynthesisProvider({
    apiKey: env('ELEVENLABS_API_KEY'),
    modelId: model,
    voiceIds: {},
    defaultVoiceId: defaultVoice,
  });

  const LINES = [
    'Buenos dias, la reunion comenzara en breve.',
    'Por favor, silencie su microfono.',
    'El ponente respondera preguntas al final.',
    'Estamos grabando esta sesion para el archivo.',
    'Gracias a todos por acompanarnos hoy.',
  ];

  await benchmark({
    id,
    label,
    capability: 'tts',
    providerId: 'elevenlabs',
    modelId: model,
    languages: ['es'],
    runSample: async (index) => {
      let firstChunkMs = null;
      let chunks = 0;
      let synthesisError = null;
      const started = Date.now();
      const result = await provider.synthesize({
        text: LINES[index % LINES.length],
        targetLanguage: 'es',
        voiceId: 'certify-es',
        onChunk: () => {
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          chunks += 1;
        },
        onError: (error) => {
          synthesisError = error;
        },
      });
      if (synthesisError !== null) throw synthesisError;
      if (result === undefined || result === null || result.samples === 0) {
        throw new Error('no audio samples returned');
      }
      if (firstChunkMs === null) throw new Error('audio was reported but no chunk was delivered');
      return {
        latencyMs: firstChunkMs,
        detail: {
          firstChunkMs,
          totalMs: Date.now() - started,
          chunks,
          samples: result.samples,
          audioSeconds: Number((result.samples / 16000).toFixed(2)),
        },
      };
    },
  });
}

// --- Azure TTS --------------------------------------------------------------

async function azureTts() {
  const id = 'azure:tts';
  const label = 'Azure cognitiveservices-v1 streaming TTS (en-US)';
  if (!present('AZURE_SPEECH_KEY') || !present('AZURE_SPEECH_REGION')) {
    return skip(id, label, 'tts', 'azure', 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not both set');
  }
  const voice = env('AZURE_DEFAULT_VOICE_ID');
  if (voice === null) {
    return skip(
      id,
      label,
      'tts',
      'azure',
      'AZURE_DEFAULT_VOICE_ID is not set (a voice absent from the region answers 400 with no body)',
    );
  }

  let AzureStreamingSynthesisProvider;
  try {
    ({ AzureStreamingSynthesisProvider } = await import(
      `${DIST_ROOT}/providers/azure/streaming-tts.js`
    ));
  } catch (error) {
    return skip(
      id,
      label,
      'tts',
      'azure',
      `built adapter not importable: ${String(error?.message ?? error).slice(0, 140)}`,
    );
  }

  const provider = new AzureStreamingSynthesisProvider({
    apiKey: env('AZURE_SPEECH_KEY'),
    region: env('AZURE_SPEECH_REGION'),
    voiceIds: {},
    defaultVoiceId: voice,
  });

  const LINES = [
    'Good afternoon, the briefing will begin shortly.',
    'Please make sure your microphone is muted.',
    'The speaker will take questions at the end.',
    'We are recording this session for the archive.',
    'Thank you all for joining us today.',
  ];

  await benchmark({
    id,
    label,
    capability: 'tts',
    providerId: 'azure',
    modelId: 'cognitiveservices-v1',
    languages: ['en-US'],
    runSample: async (index) => {
      let firstChunkMs = null;
      let chunks = 0;
      let synthesisError = null;
      const started = Date.now();
      const result = await provider.synthesize({
        text: LINES[index % LINES.length],
        targetLanguage: 'en-US',
        voiceId: 'certify-en',
        onChunk: () => {
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          chunks += 1;
        },
        onError: (error) => {
          synthesisError = error;
        },
      });
      if (synthesisError !== null) throw synthesisError;
      if (result === undefined || result === null || result.samples === 0) {
        throw new Error('no audio samples returned');
      }
      if (firstChunkMs === null) throw new Error('audio was reported but no chunk was delivered');
      return {
        latencyMs: firstChunkMs,
        detail: {
          firstChunkMs,
          totalMs: Date.now() - started,
          chunks,
          samples: result.samples,
          audioSeconds: Number((result.samples / 16000).toFixed(2)),
        },
      };
    },
  });
}

// --- 9jaLingo TTS: ha, ig and yo measured SEPARATELY ------------------------

/**
 * THREE CHECKS, NOT ONE. Hausa, Igbo and Yoruba are three language routes, and
 * the registry certifies per route; one run against one of them would license a
 * claim about the other two that nobody measured. That is the exact shape of
 * error this vendor exists to prevent.
 *
 * The speaker id comes from the vendor's own `/v1/speakers` FOR THIS KEY. A
 * configured default can name a speaker the key may not use, and the vendor's
 * error for that reads exactly like a bad key.
 */
/** The speaker id this key may use for a language, or null. Never invented. */
function speakerFor(configured, speakersByLanguage, language) {
  return configured[language] ?? speakersByLanguage[language]?.[0] ?? null;
}

/**
 * Ask the platform for a copy, and report whether it served one.
 *
 * THIS IS THE READINESS TEST, and `/v1/health` is not. A synthesis request is
 * what actually schedules capacity; the health document only describes what the
 * scheduler currently believes, and on 2026-08-30 it went on saying
 * `engine_ready: false` with `desired_copy_count: 0` while this endpoint
 * answered 200 with real WAV audio. The request the product makes is the only
 * readiness signal that cannot be wrong about itself.
 */
async function warmPing(base, headerName, headerValue, modelId, speaker) {
  if (speaker === null) return { ok: false, problem: 'no speaker id to ping with' };
  try {
    const response = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { [headerName]: headerValue, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        input: 'Bawo ni.',
        voice: speaker,
        lang: 'yo',
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (response.ok && body.byteLength > 0) return { ok: true, problem: null };
    return { ok: false, problem: `speech endpoint answered HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, problem: String(error?.message ?? error).slice(0, 90) };
  }
}

async function naijaLingoTts() {
  const languages = ['ha', 'ig', 'yo'];
  const modelId = env('NAIJALINGO_MODEL') ?? '9jalingo-tts-1';
  const labelFor = (language) => `9jaLingo ${modelId} TTS (${language})`;

  if (!present('NAIJALINGO_API_KEY')) {
    for (const language of languages) {
      skip(
        `naijalingo:tts:${language}`,
        labelFor(language),
        'tts',
        'naijalingo',
        'NAIJALINGO_API_KEY is not set',
      );
    }
    return;
  }

  let NaijaLingoStreamingSynthesisProvider;
  try {
    ({ NaijaLingoStreamingSynthesisProvider } = await import(
      `${DIST_ROOT}/providers/naijalingo/streaming-tts.js`
    ));
  } catch (error) {
    for (const language of languages) {
      skip(
        `naijalingo:tts:${language}`,
        labelFor(language),
        'tts',
        'naijalingo',
        `built adapter not importable: ${String(error?.message ?? error).slice(0, 140)}`,
      );
    }
    return;
  }

  const base = (env('NAIJALINGO_BASE_URL') ?? 'https://api.9jalingo.org').replace(/\/+$/u, '');
  const headerName = env('NAIJALINGO_AUTH_HEADER') ?? 'x-api-key';
  const scheme = env('NAIJALINGO_AUTH_SCHEME');
  const rawKey = env('NAIJALINGO_API_KEY');
  const headerValue = scheme === null ? rawKey : `${scheme} ${rawKey}`;

  // Speaker ids THIS key may use, asked of the vendor. Never invented here.
  const speakersByLanguage = {};
  let speakersProblem = null;
  try {
    const response = await fetch(`${base}/v1/speakers`, {
      headers: { [headerName]: headerValue },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      speakersProblem = `/v1/speakers answered HTTP ${response.status}`;
    } else {
      const payload = await response.json();
      const list = Array.isArray(payload) ? payload : (payload?.speakers ?? payload?.data ?? []);
      for (const entry of list) {
        const speakerId =
          typeof entry === 'string' ? entry : (entry?.id ?? entry?.speaker_id ?? entry?.name);
        if (typeof speakerId !== 'string') continue;
        const language =
          (typeof entry === 'object' && entry !== null
            ? (entry.lang ?? entry.language ?? null)
            : null) ?? speakerId.split('_').pop();
        if (typeof language !== 'string') continue;
        (speakersByLanguage[language] ??= []).push(speakerId);
      }
    }
  } catch (error) {
    speakersProblem = `/v1/speakers unreachable: ${String(error?.message ?? error).slice(0, 100)}`;
  }

  const configured = Object.fromEntries(
    (env('NAIJALINGO_VOICE_BY_LANGUAGE') ?? '')
      .split(',')
      .map((pair) => pair.split('='))
      .filter((parts) => parts.length === 2)
      .map(([language, speaker]) => [language.trim(), speaker.trim()]),
  );

  const LINES = {
    ha: 'Sannu da zuwa, taron zai fara nan da minti biyar.',
    ig: 'Nno, nzuko ahu ga-amalite na nkeji ise.',
    yo: 'Ekaabo, ipade yoo bere ni iseju marun.',
  };

  /*
   * WAKE IT UP FIRST, AND TIME HOW LONG THAT TAKES.
   *
   * This vendor runs on SageMaker capacity that scales to zero, and its own 503
   * says to retry in about five minutes. Benchmarking straight into that would
   * record "9jaLingo does not work", which is false: what happened is that
   * nobody waited. So the cold start is measured as its own fact -- it is a real
   * property of this vendor and a product decision depends on it -- and the
   * latency distribution is then measured on WARM capacity, with the two never
   * averaged together.
   *
   * THE WAKE GATE IS A SUCCESSFUL SYNTHESIS, NOT `/v1/health`. Measured on
   * 2026-08-30: health reported `status: starting`, `engine_ready: false`,
   * `current_copy_count: 0` AND `desired_copy_count: 0` while the speech
   * endpoint answered 200 with real WAV audio. An earlier revision of this loop
   * polled the readiness flag and reported the provider cold for ten minutes
   * while it was in fact serving -- a harness that would have kept a working
   * vendor uncertified on the strength of a field that never flips. The only
   * honest readiness test is the request the product actually makes.
   */
  const warmStartedAt = Date.now();
  let warmedMs = null;
  let warmProblem = null;
  process.stdout.write('  waking 9jaLingo (scale-to-zero capacity)');
  while (Date.now() - warmStartedAt < WARM_BUDGET_MS) {
    const ping = await warmPing(
      base,
      headerName,
      headerValue,
      modelId,
      speakerFor(configured, speakersByLanguage, 'yo'),
    );
    if (ping.ok) {
      warmedMs = Date.now() - warmStartedAt;
      break;
    }
    warmProblem = ping.problem;
    process.stdout.write('.');
    await sleep(20_000);
  }
  console.log(
    warmedMs === null
      ? ` still cold after ${Math.round((Date.now() - warmStartedAt) / 1000)} s` +
          (warmProblem === null ? '' : ` (${warmProblem})`)
      : ` serving after ${warmedMs} ms`,
  );

  if (warmedMs === null) {
    for (const language of languages) {
      results.push({
        id: `naijalingo:tts:${language}`,
        label: labelFor(language),
        capability: 'tts',
        providerId: 'naijalingo',
        modelId,
        languages: [language],
        outcome: 'failed',
        attempted: 0,
        note:
          `the vendor's capacity never reported ready within the ${Math.round(WARM_BUDGET_MS / 1000)} s ` +
          'budget. That is a COLD START, not a broken adapter, and no latency observation is ' +
          'proposed: the provider was never exercised warm.',
      });
    }
    return;
  }

  for (const language of languages) {
    const id = `naijalingo:tts:${language}`;
    const speaker = speakerFor(configured, speakersByLanguage, language);
    if (speaker === null) {
      skip(
        id,
        labelFor(language),
        'tts',
        'naijalingo',
        `no speaker id for '${language}': ${speakersProblem ?? '/v1/speakers listed none'}, and ` +
          'NAIJALINGO_VOICE_BY_LANGUAGE names none',
      );
      continue;
    }

    const provider = new NaijaLingoStreamingSynthesisProvider({
      apiKey: rawKey,
      ...(env('NAIJALINGO_BASE_URL') === null ? {} : { baseUrl: env('NAIJALINGO_BASE_URL') }),
      ...(env('NAIJALINGO_AUTH_HEADER') === null
        ? {}
        : { authHeaderName: env('NAIJALINGO_AUTH_HEADER') }),
      ...(scheme === null ? {} : { authScheme: scheme }),
      ...(env('NAIJALINGO_MODEL') === null ? {} : { model: env('NAIJALINGO_MODEL') }),
      defaultVoice: speaker,
      defaultVoiceByLanguage: { [language]: speaker },
    });

    await benchmark({
      id,
      label: labelFor(language),
      capability: 'tts',
      providerId: 'naijalingo',
      modelId,
      languages: [language],
      // Scales to zero: the first request may be paying for a container start.
      coldStartTolerated: true,
      runSample: async () => {
        let chunks = 0;
        let synthesisError = null;
        const started = Date.now();
        const result = await provider.synthesize({
          text: LINES[language],
          targetLanguage: language,
          voiceId: 'certify-nl',
          onChunk: () => {
            chunks += 1;
          },
          onError: (error) => {
            synthesisError = error;
          },
        });
        if (synthesisError !== null) throw synthesisError;
        if (result === undefined || result === null || result.samples === 0) {
          throw new Error('no audio samples returned');
        }
        const totalMs = Date.now() - started;
        return {
          latencyMs: totalMs,
          detail: {
            speakerId: speaker,
            totalMs,
            chunks,
            samples: result.samples,
            audioSeconds: Number((result.samples / 16000).toFixed(2)),
            // The adapter collects the whole response before emitting, so
            // time-to-first-chunk EQUALS total time. Stated rather than
            // reported as a streaming latency it is not.
            firstChunkEqualsTotal: true,
          },
        };
      },
    });
  }

  // The cold start travels WITH the warm figures, on every route it applies to.
  // Reported apart from the latency stats and never folded into them: a reader
  // who sees only the warm median would plan for a vendor that is always up,
  // and this vendor is not.
  for (const result of results) {
    if (result.providerId === 'naijalingo' && result.latency !== undefined) {
      result.coldStartMs = warmedMs;
    }
  }
}

// --- proposed observations --------------------------------------------------

/**
 * Turn results into `LiveObservation` records A HUMAN THEN REVIEWS.
 *
 * Only `ok` and `partial` runs produce one. A skip, a rate limit and a failure
 * produce a line in the table and NOTHING for the registry, because the
 * registry records what was measured and those three measured nothing about how
 * the provider behaves.
 */
function proposeObservations(fixtureNote) {
  const today = new Date().toISOString().slice(0, 10);
  const proposals = [];
  for (const result of results) {
    if (result.outcome !== 'ok' && result.outcome !== 'partial') continue;
    const latency = result.latency;
    const cold = result.coldSamples?.length ?? 0;
    // The fixture note belongs to TRANSCRIPTION observations and nowhere else.
    // Attached to a TTS record it would describe audio that record never saw,
    // which is the kind of borrowed sentence that makes a registry unreadable.
    const note = result.capability === 'transcription' ? ` ${fixtureNote}` : '';
    const summary =
      `${result.label}: ${result.succeeded}/${result.attempted} samples succeeded` +
      (result.failures > 0 ? ` (${result.failures} failed)` : '') +
      `. Latency min ${latency.minMs} ms, median ${latency.medianMs} ms, mean ${latency.meanMs} ms, ` +
      `max ${latency.maxMs} ms over ${latency.n} runs` +
      (cold > 0 ? `; ${cold} cold-start sample(s) excluded and reported separately` : '') +
      `.${note}` +
      (typeof result.coldStartMs === 'number'
        ? ` Capacity scales to zero: this run first had to WAKE it, which took ${Math.round(
            result.coldStartMs / 1000,
          )} s, and the figures above are warm-path only.`
        : '');
    proposals.push({
      providerId: result.providerId,
      observation: {
        observedAt: today,
        environment: ENVIRONMENT_LABEL,
        capability: result.capability,
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        ...(result.languages === undefined ? {} : { languages: result.languages }),
        sampleCount: latency.n,
        summary,
      },
    });
  }
  return proposals;
}

// --- main -------------------------------------------------------------------

async function main() {
  const loaded = loadEnvFile(ENV_PATH);
  console.log('C-AI1.2 provider certification benchmark');
  console.log(
    `  env file        ${ENV_PATH} ${
      loaded.loaded ? '(read)' : '(ABSENT -- using the ambient environment only)'
    }`,
  );
  console.log(`  samples/check   ${SAMPLES}`);
  console.log(`  adapters from   ${DIST_ROOT}`);
  console.log(`  speech fixture  ${SPEECH_WAV}`);
  console.log(`  environment     ${ENVIRONMENT_LABEL}`);
  console.log('');
  console.log('  configuration presence (NAMES only, never values):');
  for (const name of [
    'DEEPGRAM_API_KEY',
    'DEEPGRAM_MODEL',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_DEFAULT_VOICE_ID',
    'AZURE_SPEECH_KEY',
    'AZURE_SPEECH_REGION',
    'AZURE_DEFAULT_VOICE_ID',
    'NAIJALINGO_API_KEY',
    'GOOGLE_TRANSLATE_PROJECT_ID',
    'INTERNAL_WEBRTC_TOKEN',
  ]) {
    console.log(`    ${present(name) ? 'present' : 'ABSENT '}  ${name}`);
  }
  console.log('');

  let speech = null;
  if (existsSync(SPEECH_WAV)) {
    try {
      const candidate = readWavPcm16(SPEECH_WAV);
      if (candidate.rate !== 16000 || candidate.channels !== 1) {
        console.log(
          `  fixture is ${candidate.rate} Hz / ${candidate.channels} ch. This script does not ` +
            'resample -- resampling here would put an audio-quality claim in the harness -- so the ' +
            'transcription checks will skip. Supply 16 kHz mono.',
        );
      } else {
        speech = candidate;
      }
    } catch (error) {
      console.log(`  fixture unreadable: ${String(error?.message ?? error).slice(0, 140)}`);
    }
  } else {
    console.log('  fixture not found; the transcription checks will skip.');
  }

  const fixtureNote =
    speech === null
      ? 'No speech fixture was available for this run.'
      : `Speech fixture: ${(speech.samples.length / 16000).toFixed(2)} s of synthetic 16 kHz mono ` +
        'English. Synthetic speech is CLEAN speech, so a transcription figure measured on it is a ' +
        'floor and not a sample of a noisy room.';

  await deepgramStreaming(speech);
  await deepgramBatch(speech);
  await opusMtTranslation();
  await elevenLabsTts();
  await azureTts();
  await naijaLingoTts();

  console.log('');
  console.log('RESULTS');
  console.log('-'.repeat(112));
  for (const result of results) {
    const latency = result.latency;
    const timing =
      latency === null || latency === undefined
        ? ''
        : `min ${latency.minMs} / med ${latency.medianMs} / mean ${latency.meanMs} / max ${latency.maxMs} ms (n=${latency.n})`;
    console.log(`  ${result.outcome.toUpperCase().padEnd(13)}${result.label.padEnd(46)}${timing}`);
    if (result.note !== undefined) console.log(`                ${result.note}`);
    if ((result.coldSamples?.length ?? 0) > 0) {
      console.log(
        `                cold start observed (${result.coldSamples.length}): ${result.coldSamples.join(' | ')}`,
      );
    }
    if (result.lastError !== undefined) {
      console.log(`                last error: ${result.lastError}`);
    }
    if (result.details !== undefined && result.details.length > 0) {
      console.log(`                first sample: ${JSON.stringify(result.details[0])}`);
    }
  }
  console.log('-'.repeat(112));

  const proposals = proposeObservations(fixtureNote);
  console.log('');
  console.log('PROPOSED LiveObservation RECORDS -- review, then edit the registry BY HAND.');
  console.log('This script never writes services/ai-registry/src/commercial-providers.ts.');
  console.log('BEGIN_PROPOSED_OBSERVATIONS');
  console.log(JSON.stringify({ proposals, results }, null, 2));
  console.log('END_PROPOSED_OBSERVATIONS');

  const out = join(work, 'proposals.json');
  writeFileSync(out, JSON.stringify({ proposals, results }, null, 2));
  console.log('');
  console.log(`(also written to ${out})`);
}

await main();
