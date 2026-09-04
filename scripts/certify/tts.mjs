#!/usr/bin/env node
/** @author masterzee001 */
/**
 * LANE B -- certify the two general TTS vendors by DRIVING them.
 *
 * WHAT THIS MEASURES, and why each part is here rather than reasoned about:
 *
 *   1. GENERAL TTS AS PRIMARY. Each vendor is exercised through the SHIPPED
 *      provider class out of `dist`, not through a re-implementation of its
 *      HTTP call. A harness that writes its own request proves the vendor
 *      answers; it does not prove the code we deploy can talk to it, and the
 *      difference is where integration defects live.
 *
 *   2. FALLBACK BEHAVIOUR IS DRIVEN, NEVER DESCRIBED. The chain is made to
 *      fail on purpose -- a real request to a real vendor with a voice id that
 *      vendor will refuse -- and what the shipped
 *      `createFallbackSpeechSynthesisProvider` then does is recorded from its
 *      own observation callback. Three directions are driven: primary refuses,
 *      primary healthy, and everybody refuses. The third matters most, because
 *      the wrong answer there is silence reported as success.
 *
 *   3. NON-EMPTY AND PLAYABLE, DECODED. Bytes are decoded to samples and
 *      reported as duration, sample rate, channels and peak amplitude. A
 *      well-formed header over silence is a FAILURE and is spelt as one,
 *      because that is exactly what a broken vendor returns with a 200 and
 *      plausible latency. Container formats additionally go through ffprobe
 *      and a real ffmpeg decode, so "playable" means a decoder played it, not
 *      that the first four bytes said RIFF.
 *
 *   4. WHAT WAS ACTUALLY EXERCISED, NOT WHAT WAS CONFIGURED. The resolved
 *      model id and the resolved vendor voice id are captured after the
 *      provider's own mapping has run, and cross-checked against the vendor's
 *      catalogue endpoints. A configured voice the region does not host is a
 *      400 with an empty body; a configured voice that silently became the
 *      default is worse, because it succeeds.
 *
 * FOUR HONESTY RULES, inherited from scripts/certify-providers.mjs because the
 * opposite of each is easy and has happened:
 *
 *   - A MISSING CREDENTIAL IS A SKIP. Not a pass, not a failure. The vendor
 *     keeps whatever standing it already had and the table says why.
 *   - A 429 IS EVIDENCE ABOUT THE PLAN, NOT THE PROVIDER. The check stops and
 *     NO latency distribution is emitted: a distribution measured half inside
 *     a rate limiter describes the limiter.
 *   - EVERY NUMBER COMES FROM A RUN THAT HAPPENED. There is no synthetic
 *     fallback in this file. A check that cannot run says so, and the absence
 *     of a number is the result.
 *   - A STATUS CODE CERTIFIES NOTHING. Success requires decoded, audible,
 *     plausibly-long audio. HTTP 200 is not in the verdict.
 *
 * THE NIGERIAN PATH IS MEASURED AND RECORDED AS DEGRADED, ALWAYS. Azure is the
 * named fallback for ha/ig/yo/pcm (`NIGERIAN_TTS_ROUTE_ORDER`). This harness
 * drives that route with a specialist that refuses, so the fallback genuinely
 * runs -- and then records the result as quality-refused, never as a pass. The
 * founder's 2026-08-26 listening test found both general vendors return
 * confident, wrong Yoruba, Hausa and Igbo. Nothing measurable here can
 * overturn a listening test, so this file is forbidden from trying: the audio
 * check answers "did sound come out", the quality field answers "is it
 * acceptable", and only the second one decides anything.
 *
 * IT WRITES NO REGISTRY RECORD. Lane F owns the route registry. This proposes
 * evidence as JSON; a human moves it. Keeping the halves apart is the only
 * thing that stops a benchmark from certifying its own vendors on a good night.
 *
 * RUN IT ON THE BOX THAT HOLDS THE KEYS:
 *
 *     sudo node scripts/certify/tts.mjs --samples 5 --out /tmp/tts-evidence.json
 *
 * Credential NAMES are reported; values are never read into a printed string,
 * never logged, and never written to the evidence file.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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
const OUT_PATH = argValue('--out', '');
const ONLY = argValue('--only', '');
const GAP_MS = Math.max(0, Number.parseInt(argValue('--gap-ms', '600'), 10) || 0);
const ENVIRONMENT_LABEL = argValue('--environment', 'staging (c7-eu-01)');
const GENERAL_LANGUAGES = argValue('--languages', 'en,es,fr')
  .split(',')
  .map((part) => part.trim())
  .filter((part) => part !== '');

const selected = ONLY.trim() === '' ? null : new Set(ONLY.split(',').map((part) => part.trim()));
const wanted = (id) => selected === null || selected.has(id);

const work = mkdtempSync(join(tmpdir(), 'certify-tts-'));

// --- environment: NAMES leave this scope, values never do -------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return { loaded: false, names: [] };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(
      `Cannot read ${path} (${error?.code ?? 'error'}). Run this on the host that holds the ` +
        'vendor keys, with permission to read the service env file -- try sudo.',
    );
    process.exit(2);
  }
  const names = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) continue;
    names.push(name);
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
  return { loaded: true, names };
}

const envFile = loadEnvFile(ENV_PATH);

/** Present means set AND non-empty. `FOO=` is absent; that distinction has bitten. */
function present(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A configuration value -- a region, a model id, a voice id.
 *
 * NOT for credentials. Nothing this returns is ever a secret, and no caller of
 * this function may be pointed at one.
 */
function setting(name, fallback = null) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

// --- the shipped code under test -------------------------------------------

async function loadShipped() {
  const from = (relative) => pathToFileURL(join(DIST_ROOT, relative)).href;
  const [eleven, azure, fallback, nigerian] = await Promise.all([
    import(from('providers/elevenlabs/tts.js')),
    import(from('providers/azure/streaming-tts.js')),
    import(from('fallback-speech-synthesis-provider.js')),
    import(from('nigerian-synthesis-route.js')),
  ]);
  return {
    ElevenLabsStreamingSynthesisProvider: eleven.ElevenLabsStreamingSynthesisProvider,
    ElevenLabsTextToSpeechProvider: eleven.ElevenLabsTextToSpeechProvider,
    AzureStreamingSynthesisProvider: azure.AzureStreamingSynthesisProvider,
    AZURE_ENGINE_OUTPUT_FORMAT: azure.AZURE_ENGINE_OUTPUT_FORMAT,
    createFallbackSpeechSynthesisProvider: fallback.createFallbackSpeechSynthesisProvider,
    createNigerianSynthesisRoute: nigerian.createNigerianSynthesisRoute,
  };
}

// --- the corpus ------------------------------------------------------------

/**
 * One sentence per language, fixed, and REPORTED with the evidence.
 *
 * Fixed because a distribution measured on different text per run is not a
 * distribution; reported because "we tested Yoruba" is not a claim anybody can
 * check without knowing what was said. Each is an ordinary conference
 * announcement of comparable length, so per-language latency is comparable.
 */
const CORPUS = {
  en: {
    locale: 'en-US',
    text: 'The conference will begin in five minutes. Please take your seats.',
  },
  es: {
    locale: 'es-ES',
    text: 'La conferencia comenzará en cinco minutos. Por favor, tomen asiento.',
  },
  fr: {
    locale: 'fr-FR',
    text: 'La conférence commencera dans cinq minutes. Veuillez prendre place.',
  },
  de: {
    locale: 'de-DE',
    text: 'Die Konferenz beginnt in fünf Minuten. Bitte nehmen Sie Platz.',
  },
  /*
   * DIACRITICS INTACT, deliberately. Yoruba tone marks and Igbo dots are not
   * decoration -- stripping them changes the word, and a vendor fed unmarked
   * text has been handed a different sentence to mispronounce. Testing the
   * stripped form would measure our own corpus damage rather than the vendor's.
   */
  yo: {
    locale: 'yo-NG',
    text: 'Àpérò náà yóò bẹ̀rẹ̀ ní ìṣẹ́jú márùn-ún. Ẹ jọ̀ọ́ ẹ jókòó.',
  },
  ig: {
    locale: 'ig-NG',
    text: 'Ọgbakọ ahụ ga-amalite na nkeji ise. Biko nọdụ ala.',
  },
  ha: {
    locale: 'ha-NG',
    text: 'Taron zai fara cikin minti biyar. Don Allah ku zauna.',
  },
  pcm: {
    locale: 'en-NG',
    text: 'The meeting go start for five minutes. Abeg make una sit down.',
  },
};

const NIGERIAN_LANGUAGES = ['ha', 'ig', 'yo', 'pcm'];

/**
 * Azure's containered output format, used only for the complete-audio probe.
 *
 * The shipped provider hardcodes the RAW variant, so this format is never what
 * production requests -- it exists here to answer "can this vendor hand back a
 * file a decoder will open", which the raw stream cannot answer.
 */
const AZURE_WAV_FORMAT = 'riff-16khz-16bit-mono-pcm';

// --- audio: decoded, not assumed -------------------------------------------

const SAMPLE_RATE = 16_000;

/**
 * What the samples actually contain.
 *
 * `peakAmplitude` and `voicedRatio` are the two numbers that separate "audio"
 * from "a correctly formatted absence of audio". Peak alone is not enough -- a
 * single click at the top of an otherwise silent buffer passes it -- so the
 * fraction of 20 ms frames carrying energy is measured too.
 */
function analysePcm16(samples, sampleRate = SAMPLE_RATE) {
  const count = samples.length;
  if (count === 0) {
    return {
      sampleCount: 0,
      sampleRate,
      channels: 1,
      durationSeconds: 0,
      peakAmplitude: 0,
      rms: 0,
      voicedRatio: 0,
      longestSilenceSeconds: 0,
    };
  }
  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
    sumSquares += samples[index] * samples[index];
  }
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  let voicedFrames = 0;
  let frames = 0;
  let silentRun = 0;
  let longestSilentRun = 0;
  for (let start = 0; start + frame <= count; start += frame) {
    let frameSquares = 0;
    for (let index = start; index < start + frame; index += 1) {
      frameSquares += samples[index] * samples[index];
    }
    const frameRms = Math.sqrt(frameSquares / frame) / 32_768;
    frames += 1;
    if (frameRms > 0.01) {
      voicedFrames += 1;
      silentRun = 0;
    } else {
      silentRun += 1;
      if (silentRun > longestSilentRun) longestSilentRun = silentRun;
    }
  }
  return {
    sampleCount: count,
    sampleRate,
    channels: 1,
    durationSeconds: Number((count / sampleRate).toFixed(3)),
    peakAmplitude: Number((peak / 32_768).toFixed(4)),
    rms: Number((Math.sqrt(sumSquares / count) / 32_768).toFixed(4)),
    voicedRatio: frames === 0 ? 0 : Number((voicedFrames / frames).toFixed(3)),
    longestSilenceSeconds: Number(((longestSilentRun * frame) / sampleRate).toFixed(3)),
  };
}

/**
 * The line between audio and a convincing absence of it.
 *
 * Deliberately generous on the loud side and strict on the quiet side. A quiet
 * but real sentence should pass; a header wrapped around digital silence, or
 * around a fifth of a second of nothing, must not. The thresholds are stated
 * here rather than buried at three call sites, so a later reader can argue with
 * one number instead of hunting for it.
 */
const AUDIBILITY = {
  minPeakAmplitude: 0.01,
  minVoicedRatio: 0.15,
  minDurationSeconds: 0.3,
};

function audibilityVerdict(analysis, text) {
  const reasons = [];
  if (analysis.sampleCount === 0) reasons.push('no samples were produced at all');
  if (analysis.peakAmplitude < AUDIBILITY.minPeakAmplitude) {
    reasons.push(
      `peak amplitude ${analysis.peakAmplitude} is below ${AUDIBILITY.minPeakAmplitude} -- ` +
        'a well-formed container over silence',
    );
  }
  if (analysis.voicedRatio < AUDIBILITY.minVoicedRatio) {
    reasons.push(
      `only ${(analysis.voicedRatio * 100).toFixed(1)}% of 20 ms frames carry energy ` +
        `(floor ${AUDIBILITY.minVoicedRatio * 100}%)`,
    );
  }
  if (analysis.durationSeconds < AUDIBILITY.minDurationSeconds) {
    reasons.push(
      `${analysis.durationSeconds}s is shorter than the ${AUDIBILITY.minDurationSeconds}s floor`,
    );
  }
  /*
   * A PLAUSIBILITY SIGNAL, NOT A VERDICT. Ordinary speech runs roughly 10-20
   * characters a second. A wildly different rate means the vendor spoke
   * something other than the sentence -- a truncation, an error message read
   * aloud, a language it substituted. It is reported, and it decides nothing,
   * because this harness cannot hear.
   */
  const charactersPerSecond =
    analysis.durationSeconds > 0
      ? Number((text.length / analysis.durationSeconds).toFixed(1))
      : null;
  return { audible: reasons.length === 0, reasons, charactersPerSecond };
}

// --- containers: ffprobe, then a real decode -------------------------------

function ffprobeStream(path) {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels:format=format_name,duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    return { probed: false, error: (probe.stderr ?? '').trim().slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(probe.stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
      probed: true,
      codecName: stream.codec_name ?? null,
      sampleRate: stream.sample_rate === undefined ? null : Number(stream.sample_rate),
      channels: stream.channels ?? null,
      formatName: parsed.format?.format_name ?? null,
      declaredDurationSeconds:
        parsed.format?.duration === undefined ? null : Number(parsed.format.duration),
    };
  } catch (error) {
    return { probed: false, error: error instanceof Error ? error.message : 'unparseable' };
  }
}

/**
 * Decode a container to samples with ffmpeg and analyse THOSE.
 *
 * The point is not the numbers, which a header could have claimed. The point is
 * that a decoder consumed the bytes and produced audio -- which is what
 * "playable" means, and which no amount of header inspection establishes.
 */
function decodeContainer(path) {
  const probe = ffprobeStream(path);
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  if (decoded.status !== 0) {
    return {
      probe,
      decoded: false,
      error: Buffer.from(decoded.stderr ?? []).toString('utf8').trim().slice(0, 300),
      analysis: null,
    };
  }
  const buffer = Buffer.from(decoded.stdout);
  const usable = buffer.length - (buffer.length % 2);
  const samples = new Int16Array(usable / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2);
  }
  return { probe, decoded: true, error: null, analysis: analysePcm16(samples) };
}

// --- statistics ------------------------------------------------------------

function distribution(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: at(0.5),
    /*
     * NOT ROUNDED TO AN INTEGER. This same helper summarises milliseconds and
     * seconds, and rounding turned every audio duration into a flat "4" --
     * a mean that agreed with itself across four languages and told nobody
     * anything. Three decimals is exact enough for both units.
     */
    mean: Number((sum / sorted.length).toFixed(3)),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 429 says something about the plan, not the provider. Recognised by shape. */
function isRateLimited(message) {
  return /\b429\b|too many requests|rate.?limit/iu.test(message);
}

// --- results ---------------------------------------------------------------

const results = [];

function record(entry) {
  results.push(entry);
  const status = String(entry.status).toUpperCase().padEnd(24);
  const latency = entry.latency?.timeToFirstChunkMs
    ? `${entry.latency.timeToFirstChunkMs.median}/${entry.latency.totalMs?.median ?? '?'}ms`
    : typeof entry.totalMs === 'number'
      ? `${entry.totalMs}ms`
      : '--';
  console.log(`  ${status} ${entry.id.padEnd(40)} ${latency.padEnd(14)} ${entry.headline}`);
}

/**
 * Run one streaming provider N times and decide, FROM THE AUDIO, whether it
 * worked.
 *
 * The result is `pass` only when every sample produced audible audio. A
 * partially audible run is `mixed`, never rounded up: "four of five sentences
 * came out" is a different product from "it works", and the rounding is how a
 * flaky vendor gets certified.
 */
async function measureStreaming({ id, provider, text, targetLanguage, voiceId, samples, meta }) {
  const ttfb = [];
  const total = [];
  const analyses = [];
  const failures = [];
  let rateLimited = false;

  for (let index = 0; index < samples; index += 1) {
    const chunks = [];
    let errored = null;
    let result = null;
    try {
      result = await provider.synthesize({
        text,
        targetLanguage,
        voiceId,
        onChunk: (chunk) => chunks.push(chunk.samples),
        onError: (error) => {
          errored = error;
        },
      });
    } catch (error) {
      errored = error instanceof Error ? error : new Error(String(error));
    }
    if (errored !== null) {
      const message = errored.message ?? String(errored);
      failures.push(message.slice(0, 300));
      if (isRateLimited(message)) {
        rateLimited = true;
        break;
      }
      if (GAP_MS > 0) await sleep(GAP_MS);
      continue;
    }
    const flat = new Int16Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      flat.set(chunk, offset);
      offset += chunk.length;
    }
    const analysis = analysePcm16(flat);
    analyses.push({ ...analysis, verdict: audibilityVerdict(analysis, text) });
    if (result?.timeToFirstChunkMs !== null && result?.timeToFirstChunkMs !== undefined) {
      ttfb.push(result.timeToFirstChunkMs);
    }
    if (typeof result?.totalMs === 'number') total.push(result.totalMs);
    if (GAP_MS > 0 && index < samples - 1) await sleep(GAP_MS);
  }

  const audible = analyses.filter((analysis) => analysis.verdict.audible);
  const attempted = analyses.length + failures.length;
  const status = rateLimited
    ? 'rate-limited'
    : attempted === 0
      ? 'not-run'
      : audible.length === attempted
        ? 'pass'
        : audible.length === 0
          ? 'fail'
          : 'mixed';

  const meanDuration =
    analyses.length === 0
      ? null
      : (analyses.reduce((sum, entry) => sum + entry.durationSeconds, 0) / analyses.length).toFixed(2);

  const headline = rateLimited
    ? 'stopped at a 429; no distribution proposed (it would describe the limiter)'
    : status === 'pass'
      ? `${audible.length}/${attempted} audible, mean ${meanDuration}s of speech`
      : status === 'fail'
        ? (failures[0] ?? analyses[0]?.verdict.reasons.join('; ') ?? 'no audible audio')
        : `${audible.length}/${attempted} audible`;

  return {
    id,
    kind: 'streaming',
    status,
    headline,
    samplesRequested: samples,
    samplesAttempted: attempted,
    samplesAudible: audible.length,
    successRate: attempted === 0 ? null : Number((audible.length / attempted).toFixed(3)),
    text,
    textLength: text.length,
    targetLanguage,
    latency: rateLimited
      ? null
      : { timeToFirstChunkMs: distribution(ttfb), totalMs: distribution(total) },
    audio:
      analyses.length === 0
        ? null
        : {
            sampleRate: analyses[0].sampleRate,
            channels: analyses[0].channels,
            durationSeconds: distribution(analyses.map((entry) => entry.durationSeconds)),
            peakAmplitude: {
              min: Math.min(...analyses.map((entry) => entry.peakAmplitude)),
              max: Math.max(...analyses.map((entry) => entry.peakAmplitude)),
            },
            voicedRatio: {
              min: Math.min(...analyses.map((entry) => entry.voicedRatio)),
              max: Math.max(...analyses.map((entry) => entry.voicedRatio)),
            },
            charactersPerSecond: distribution(
              analyses
                .map((entry) => entry.verdict.charactersPerSecond)
                .filter((value) => value !== null),
            ),
            silenceRejections: analyses
              .filter((entry) => !entry.verdict.audible)
              .flatMap((entry) => entry.verdict.reasons),
          },
    failures,
    ...meta,
  };
}

// --- vendor catalogues: what was exercised, checked against what exists -----

async function elevenLabsCatalogue(modelId, voiceId) {
  const headers = { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' };
  const out = { modelId, voiceId, model: null, voice: null, errors: [] };
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/models', { headers });
    if (response.ok) {
      const models = await response.json();
      const match = Array.isArray(models)
        ? models.find((entry) => entry.model_id === modelId)
        : null;
      out.model =
        match === null || match === undefined
          ? { found: false }
          : {
              found: true,
              name: match.name ?? null,
              canDoTextToSpeech: match.can_do_text_to_speech ?? null,
              languages: (match.languages ?? []).map((language) => language.language_id),
            };
    } else {
      out.errors.push(`models: HTTP ${response.status}`);
    }
  } catch (error) {
    out.errors.push(`models: ${error instanceof Error ? error.message : 'failed'}`);
  }
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`,
      { headers },
    );
    if (response.ok) {
      const voice = await response.json();
      out.voice = {
        found: true,
        name: voice.name ?? null,
        category: voice.category ?? null,
        labels: voice.labels ?? null,
      };
    } else {
      out.voice = { found: false, status: response.status };
    }
  } catch (error) {
    out.errors.push(`voice: ${error instanceof Error ? error.message : 'failed'}`);
  }
  return out;
}

async function azureVoiceCatalogue(region) {
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  try {
    const response = await fetch(url, {
      headers: { 'ocp-apim-subscription-key': process.env.AZURE_SPEECH_KEY ?? '' },
    });
    if (!response.ok) return { region, listed: false, error: `HTTP ${response.status}` };
    const voices = await response.json();
    const locales = new Set(voices.map((voice) => voice.Locale));
    const nigerian = /^(yo|ig|ha)-|^en-NG$/u;
    return {
      region,
      listed: true,
      voiceCount: voices.length,
      localeCount: locales.size,
      shortNames: new Set(voices.map((voice) => voice.ShortName)),
      nigerianLocales: [...locales].filter((locale) => nigerian.test(locale)),
      nigerianVoices: voices
        .filter((voice) => nigerian.test(voice.Locale))
        .map((voice) => ({
          shortName: voice.ShortName,
          locale: voice.Locale,
          gender: voice.Gender,
          voiceType: voice.VoiceType,
        })),
    };
  } catch (error) {
    return { region, listed: false, error: error instanceof Error ? error.message : 'failed' };
  }
}

// --- fallback: driven, not described ---------------------------------------

/**
 * A provider that refuses the way an outage does.
 *
 * Used ONLY where the vendor cannot be made to refuse on demand -- the
 * Nigerian specialist, which this lane does not own and must not disturb. For
 * the general chain, refusal is driven with a REAL request carrying a voice id
 * the vendor rejects, because a stub proves the chain's arithmetic while a
 * rejection proves the chain against the vendor's actual error shape.
 */
function refusingProvider(name, message) {
  return {
    name,
    async synthesize() {
      throw new Error(message);
    },
  };
}

/** Run one chain once and report what the chain's OWN observer saw. */
async function driveChain({ id, chain, observed, text, targetLanguage, voiceId, expectation }) {
  const chunks = [];
  const reported = [];
  let threw = null;
  let result = null;
  try {
    result = await chain.synthesize({
      text,
      targetLanguage,
      voiceId,
      onChunk: (chunk) => chunks.push(chunk.samples),
      onError: (error) => reported.push((error?.message ?? String(error)).slice(0, 300)),
    });
  } catch (error) {
    threw = error instanceof Error ? error.message.slice(0, 300) : String(error);
  }
  const flat = new Int16Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    flat.set(chunk, offset);
    offset += chunk.length;
  }
  const analysis = analysePcm16(flat);
  const verdict = audibilityVerdict(analysis, text);
  const observation = observed.value;
  return {
    id,
    kind: 'fallback-drive',
    chainName: chain.name,
    expectation,
    servedBy: observation?.servedBy ?? null,
    fellThrough: observation?.fellThrough ?? [],
    reportedToCaller: reported,
    threw,
    samples: result?.samples ?? 0,
    audio: analysis,
    audible: verdict.audible,
    audibilityReasons: verdict.reasons,
    timeToFirstChunkMs: observation?.timeToFirstChunkMs ?? null,
    totalMs: observation?.totalMs ?? null,
  };
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log('Lane B -- TTS provider certification (ElevenLabs + Azure)');
  console.log(`  environment       ${ENVIRONMENT_LABEL}`);
  console.log(`  env file          ${ENV_PATH} ${envFile.loaded ? '(loaded)' : '(ABSENT)'}`);
  console.log(`  dist under test   ${DIST_ROOT}`);
  console.log(`  samples per check ${SAMPLES}`);
  console.log(`  languages         ${GENERAL_LANGUAGES.join(', ')}`);
  console.log('');

  const shipped = await loadShipped();

  const elevenLabsConfigured =
    present('ELEVENLABS_API_KEY') && present('ELEVENLABS_DEFAULT_VOICE_ID');
  const azureConfigured =
    present('AZURE_SPEECH_KEY') &&
    present('AZURE_SPEECH_REGION') &&
    present('AZURE_DEFAULT_VOICE_ID');

  const WATCHED_NAMES = [
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_MODEL',
    'ELEVENLABS_DEFAULT_VOICE_ID',
    'ELEVENLABS_VOICE_IDS',
    'AZURE_SPEECH_KEY',
    'AZURE_SPEECH_REGION',
    'AZURE_DEFAULT_VOICE_ID',
    'AZURE_VOICE_IDS',
    'NAIJALINGO_API_KEY',
  ];

  console.log('Credential and configuration NAMES (values never reach output):');
  for (const name of WATCHED_NAMES) {
    console.log(`  ${present(name) ? 'present' : 'ABSENT '}  ${name}`);
  }
  console.log('');

  /*
   * THE IDS ACTUALLY EXERCISED, resolved the way the shipped wiring resolves
   * them -- including the default that applies when the voice map is empty,
   * which is the case that silently discards a speaker's voice choice and is
   * therefore the one worth printing.
   */
  const elevenModelId = setting('ELEVENLABS_MODEL', 'eleven_flash_v2_5');
  const elevenVoiceId = setting('ELEVENLABS_DEFAULT_VOICE_ID');
  const azureRegion = setting('AZURE_SPEECH_REGION');
  const azureVoiceId = setting('AZURE_DEFAULT_VOICE_ID');
  const elevenVoiceMapConfigured = present('ELEVENLABS_VOICE_IDS');
  const azureVoiceMapConfigured = present('AZURE_VOICE_IDS');

  const catalogue = { elevenlabs: null, azure: null };

  // ---------------------------------------------------------------- ElevenLabs
  if (!elevenLabsConfigured) {
    record({
      id: 'elevenlabs/*',
      kind: 'skip',
      status: 'skipped',
      headline: 'ELEVENLABS_API_KEY or ELEVENLABS_DEFAULT_VOICE_ID is absent -- not a failure',
    });
  } else if (wanted('elevenlabs')) {
    catalogue.elevenlabs = await elevenLabsCatalogue(elevenModelId, elevenVoiceId);
    console.log('ElevenLabs catalogue (what the vendor says exists):');
    console.log(
      `  model  ${elevenModelId}  ${catalogue.elevenlabs.model?.found ? 'exists' : 'NOT FOUND'}`,
    );
    console.log(
      `  voice  ${elevenVoiceId}  ${
        catalogue.elevenlabs.voice?.found
          ? `exists ("${catalogue.elevenlabs.voice.name}", ${catalogue.elevenlabs.voice.category})`
          : 'NOT FOUND'
      }`,
    );
    console.log('');

    const eleven = new shipped.ElevenLabsStreamingSynthesisProvider({
      apiKey: process.env.ELEVENLABS_API_KEY,
      modelId: elevenModelId,
      voiceIds: {},
      defaultVoiceId: elevenVoiceId,
    });

    console.log('ElevenLabs -- general TTS as primary (shipped streaming provider):');
    for (const language of GENERAL_LANGUAGES) {
      const entry = CORPUS[language];
      if (entry === undefined) continue;
      record(
        await measureStreaming({
          id: `elevenlabs/streaming/${language}`,
          provider: eleven,
          text: entry.text,
          targetLanguage: language,
          voiceId: 'certification-voice',
          samples: SAMPLES,
          meta: {
            vendor: 'elevenlabs',
            providerName: eleven.name,
            modelIdExercised: elevenModelId,
            voiceIdExercised: elevenVoiceId,
            voiceMapConfigured: elevenVoiceMapConfigured,
            outputFormat: 'pcm_16000 (raw, no container)',
            surface: 'streaming',
          },
        }),
      );
    }
    console.log('');
  }

  // --------------------------------------------------------------------- Azure
  let azureProvider = null;
  if (!azureConfigured) {
    record({
      id: 'azure/*',
      kind: 'skip',
      status: 'skipped',
      headline: 'AZURE_SPEECH_KEY, AZURE_SPEECH_REGION or AZURE_DEFAULT_VOICE_ID is absent',
    });
  } else if (wanted('azure') || wanted('nigerian') || wanted('fallback')) {
    catalogue.azure = await azureVoiceCatalogue(azureRegion);
    console.log(`Azure catalogue (region ${azureRegion}):`);
    if (catalogue.azure.listed) {
      console.log(
        `  ${catalogue.azure.voiceCount} voices across ${catalogue.azure.localeCount} locales`,
      );
      console.log(
        `  configured voice ${azureVoiceId} ${
          catalogue.azure.shortNames.has(azureVoiceId)
            ? 'IS hosted in this region'
            : 'is NOT hosted in this region'
        }`,
      );
      console.log(
        `  Nigerian locales hosted: ${
          catalogue.azure.nigerianLocales.length === 0
            ? 'NONE'
            : catalogue.azure.nigerianLocales.join(', ')
        }`,
      );
    } else {
      console.log(`  voice list unavailable: ${catalogue.azure.error}`);
    }
    console.log('');

    azureProvider = new shipped.AzureStreamingSynthesisProvider({
      apiKey: process.env.AZURE_SPEECH_KEY,
      region: azureRegion,
      voiceIds: {},
      defaultVoiceId: azureVoiceId,
    });

    if (wanted('azure')) {
      console.log('Azure -- general TTS as primary (shipped streaming provider):');
      for (const language of GENERAL_LANGUAGES) {
        const entry = CORPUS[language];
        if (entry === undefined) continue;
        /*
         * BOTH TAG FORMS, because the pipeline's target language is a bare code
         * on some paths and a locale on others, and Azure's SSML `xml:lang` is
         * not indifferent to which. Guessing which one production sends would
         * make this evidence about a configuration nobody deploys.
         */
        for (const tag of [language, entry.locale]) {
          record(
            await measureStreaming({
              id: `azure/streaming/${tag}`,
              provider: azureProvider,
              text: entry.text,
              targetLanguage: tag,
              voiceId: 'certification-voice',
              samples: SAMPLES,
              meta: {
                vendor: 'azure',
                providerName: azureProvider.name,
                modelIdExercised: `azure-speech-neural-tts (${azureRegion})`,
                voiceIdExercised: azureVoiceId,
                voiceMapConfigured: azureVoiceMapConfigured,
                outputFormat: shipped.AZURE_ENGINE_OUTPUT_FORMAT,
                surface: 'streaming',
                ssmlLanguageTag: tag,
              },
            }),
          );
        }
      }
      console.log('');
    }
  }

  // ------------------------------------------------ complete-audio capability
  if (wanted('complete')) {
    console.log('Complete-audio capability (written, ffprobed, then really decoded):');

    if (elevenLabsConfigured) {
      /*
       * NOT THE SHIPPED PATH, AND LABELLED SO. `ElevenLabsTextToSpeechProvider`
       * -- the complete-file surface -- hardcodes `output_format=pcm_16000`, so
       * the file it writes is HEADERLESS PCM whatever extension it is given. To
       * learn whether the vendor can produce a container at all, the request is
       * made directly here, and the evidence records it as a capability probe
       * rather than a measurement of our code.
       */
      const started = Date.now();
      try {
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
            elevenVoiceId,
          )}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': process.env.ELEVENLABS_API_KEY,
              'content-type': 'application/json',
              accept: 'audio/mpeg',
            },
            body: JSON.stringify({ text: CORPUS.en.text, model_id: elevenModelId }),
          },
        );
        if (!response.ok) {
          record({
            id: 'elevenlabs/complete/mp3',
            kind: 'container',
            vendor: 'elevenlabs',
            status: 'fail',
            headline: `vendor returned ${response.status} on the non-streaming endpoint`,
          });
        } else {
          const path = join(work, 'elevenlabs-complete.mp3');
          writeFileSync(path, Buffer.from(await response.arrayBuffer()));
          const totalMs = Date.now() - started;
          const decoded = decodeContainer(path);
          const verdict =
            decoded.analysis === null
              ? { audible: false, reasons: ['ffmpeg could not decode the file'] }
              : audibilityVerdict(decoded.analysis, CORPUS.en.text);
          record({
            id: 'elevenlabs/complete/mp3',
            kind: 'container',
            vendor: 'elevenlabs',
            status: decoded.decoded && verdict.audible ? 'pass' : 'fail',
            headline: decoded.decoded
              ? verdict.audible
                ? `${decoded.probe.codecName} ${decoded.probe.sampleRate}Hz x${decoded.probe.channels}, ` +
                  `${decoded.analysis.durationSeconds}s, peak ${decoded.analysis.peakAmplitude}`
                : verdict.reasons.join('; ')
              : `undecodable: ${decoded.error}`,
            surface: 'complete (direct vendor probe -- NOT the shipped provider)',
            modelIdExercised: elevenModelId,
            voiceIdExercised: elevenVoiceId,
            outputFormat: 'mp3_44100_128',
            totalMs,
            probe: decoded.probe,
            audio: decoded.analysis,
            audibilityReasons: verdict.reasons,
          });
        }
      } catch (error) {
        record({
          id: 'elevenlabs/complete/mp3',
          kind: 'container',
          vendor: 'elevenlabs',
          status: 'fail',
          headline: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
        });
      }

      /*
       * AND the shipped complete-file surface, so the evidence records what OUR
       * code produces rather than what the vendor could produce.
       */
      const shippedPath = join(work, 'elevenlabs-shipped-complete.bin');
      const completeProvider = new shipped.ElevenLabsTextToSpeechProvider({
        apiKey: process.env.ELEVENLABS_API_KEY,
        modelId: elevenModelId,
        voiceIds: {},
        defaultVoiceId: elevenVoiceId,
        mode: 'complete',
      });
      try {
        const generated = await completeProvider.generate({
          translatedText: CORPUS.en.text,
          voiceId: 'certification-voice',
          outputPath: shippedPath,
          targetLanguage: 'en',
        });
        const bytes = readFileSync(shippedPath);
        const header = bytes.subarray(0, 4).toString('ascii').replace(/[^\x20-\x7e]/gu, '.');
        const probe = ffprobeStream(shippedPath);
        const usable = bytes.length - (bytes.length % 2);
        const samples = new Int16Array(usable / 2);
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = bytes.readInt16LE(index * 2);
        }
        const analysis = analysePcm16(samples);
        const verdict = audibilityVerdict(analysis, CORPUS.en.text);
        record({
          id: 'elevenlabs/complete/shipped-surface',
          kind: 'container',
          vendor: 'elevenlabs',
          status: verdict.audible ? 'pass' : 'fail',
          headline:
            `${bytes.length} bytes of HEADERLESS pcm_16000 (first four "${header}"); ` +
            `ffprobe ${probe.probed ? 'read it' : 'CANNOT read it'}; ` +
            `${analysis.durationSeconds}s, peak ${analysis.peakAmplitude}`,
          surface: 'complete (shipped ElevenLabsTextToSpeechProvider, mode: complete)',
          modelIdExercised: elevenModelId,
          voiceIdExercised: elevenVoiceId,
          outputFormat: 'pcm_16000 (hardcoded in the provider; no container is written)',
          totalMs: generated.providerLatencyMs,
          probe,
          audio: analysis,
          audibilityReasons: verdict.reasons,
        });
      } catch (error) {
        record({
          id: 'elevenlabs/complete/shipped-surface',
          kind: 'container',
          vendor: 'elevenlabs',
          status: 'fail',
          headline: error instanceof Error ? error.message.slice(0, 200) : 'generate failed',
        });
      }
    }

    if (azureConfigured) {
      /*
       * Azure's WAV output format, requested directly. The shipped provider
       * hardcodes the raw variant, so this is again a vendor capability probe
       * and is labelled as one.
       */
      const started = Date.now();
      try {
        const ssml =
          `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='${azureVoiceId}'>` +
          `${CORPUS.en.text}</voice></speak>`;
        const response = await fetch(
          `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
          {
            method: 'POST',
            headers: {
              'ocp-apim-subscription-key': process.env.AZURE_SPEECH_KEY,
              'content-type': 'application/ssml+xml',
              'x-microsoft-outputformat': AZURE_WAV_FORMAT,
              'user-agent': 'videofy-live-certification',
            },
            body: ssml,
          },
        );
        if (!response.ok) {
          record({
            id: 'azure/complete/riff-wav',
            kind: 'container',
            vendor: 'azure',
            status: 'fail',
            headline: `vendor returned ${response.status}`,
          });
        } else {
          const path = join(work, 'azure-complete.wav');
          writeFileSync(path, Buffer.from(await response.arrayBuffer()));
          const totalMs = Date.now() - started;
          const decoded = decodeContainer(path);
          const verdict =
            decoded.analysis === null
              ? { audible: false, reasons: ['ffmpeg could not decode the file'] }
              : audibilityVerdict(decoded.analysis, CORPUS.en.text);
          record({
            id: 'azure/complete/riff-wav',
            kind: 'container',
            vendor: 'azure',
            status: decoded.decoded && verdict.audible ? 'pass' : 'fail',
            headline: decoded.decoded
              ? verdict.audible
                ? `${decoded.probe.codecName} ${decoded.probe.sampleRate}Hz x${decoded.probe.channels}, ` +
                  `${decoded.analysis.durationSeconds}s, peak ${decoded.analysis.peakAmplitude}`
                : verdict.reasons.join('; ')
              : `undecodable: ${decoded.error}`,
            surface: 'complete (direct vendor probe -- NOT the shipped provider)',
            modelIdExercised: `azure-speech-neural-tts (${azureRegion})`,
            voiceIdExercised: azureVoiceId,
            outputFormat: AZURE_WAV_FORMAT,
            totalMs,
            probe: decoded.probe,
            audio: decoded.analysis,
            audibilityReasons: verdict.reasons,
          });
        }
      } catch (error) {
        record({
          id: 'azure/complete/riff-wav',
          kind: 'container',
          vendor: 'azure',
          status: 'fail',
          headline: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
        });
      }
    }
    console.log('');
  }

  // --------------------------------- identity: WHICH model and voice answered
  /*
   * A 200 does not prove the vendor used the model and voice we named. It could
   * have ignored both and substituted a default -- which is precisely the
   * failure that leaves a configured voice quietly unused and every speaker
   * sounding the same.
   *
   * The vendor catalogue is the direct answer, and on this deployment it is not
   * available: the ElevenLabs key is scoped to synthesis and answers 401 to
   * `/v1/models` and `/v1/voices/{id}`. So identity is established the other
   * way round, by NEGATIVE CONTROL: a request naming a model or voice that does
   * not exist must be REFUSED. A vendor that refuses an unknown id is a vendor
   * that reads the id, and a vendor that reads the id used the one we sent.
   * A vendor that answers 200 to nonsense has been ignoring the field all
   * along, and every identity claim about it is worthless.
   */
  if (wanted('identity')) {
    console.log('Identity -- driven negative controls (does the vendor READ the id we send?):');

    if (elevenLabsConfigured) {
      record({
        id: 'elevenlabs/identity/catalogue-readable',
        kind: 'identity',
        vendor: 'elevenlabs',
        status:
          catalogue.elevenlabs?.model?.found === true && catalogue.elevenlabs?.voice?.found === true
            ? 'pass'
            : 'not-authorised',
        headline:
          `/v1/models and /v1/voices answered ${
            catalogue.elevenlabs?.voice?.status ?? catalogue.elevenlabs?.errors?.[0] ?? 'unknown'
          } -- the key is scoped to synthesis, so ids cannot be cross-checked against the catalogue`,
        modelIdExercised: elevenModelId,
        voiceIdExercised: elevenVoiceId,
        catalogueErrors: catalogue.elevenlabs?.errors ?? [],
      });

      for (const probe of [
        {
          id: 'elevenlabs/identity/model-honoured',
          voice: elevenVoiceId,
          model: 'videofy0certification0nonexistent0model',
          claim: 'an unknown model_id must be refused',
        },
        {
          id: 'elevenlabs/identity/voice-honoured',
          voice: 'videofy0certification0nonexistent',
          model: elevenModelId,
          claim: 'an unknown voice_id must be refused',
        },
      ]) {
        try {
          const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
              probe.voice,
            )}/stream?output_format=pcm_16000`,
            {
              method: 'POST',
              headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'content-type': 'application/json',
                accept: 'audio/pcm',
              },
              body: JSON.stringify({ text: CORPUS.en.text, model_id: probe.model }),
            },
          );
          const body = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 200);
          record({
            id: probe.id,
            kind: 'identity',
            vendor: 'elevenlabs',
            status: response.ok ? 'fail' : 'pass',
            headline: response.ok
              ? 'vendor answered 200 to an id that does not exist -- it is IGNORING the field, ' +
                'and no identity claim about this vendor holds'
              : `refused with ${response.status}: ${body}`,
            claim: probe.claim,
            httpStatus: response.status,
          });
        } catch (error) {
          record({
            id: probe.id,
            kind: 'identity',
            vendor: 'elevenlabs',
            status: 'not-run',
            headline: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
          });
        }
        if (GAP_MS > 0) await sleep(GAP_MS);
      }
    }

    if (azureConfigured) {
      record({
        id: 'azure/identity/voice-hosted-in-region',
        kind: 'identity',
        vendor: 'azure',
        status: catalogue.azure?.listed
          ? catalogue.azure.shortNames.has(azureVoiceId)
            ? 'pass'
            : 'fail'
          : 'not-run',
        headline: catalogue.azure?.listed
          ? `${azureVoiceId} ${
              catalogue.azure.shortNames.has(azureVoiceId) ? 'is' : 'is NOT'
            } among the ${catalogue.azure.voiceCount} voices ${azureRegion} hosts`
          : `voice list unavailable: ${catalogue.azure?.error ?? 'unknown'}`,
        voiceIdExercised: azureVoiceId,
        region: azureRegion,
      });

      try {
        const response = await fetch(
          `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
          {
            method: 'POST',
            headers: {
              'ocp-apim-subscription-key': process.env.AZURE_SPEECH_KEY,
              'content-type': 'application/ssml+xml',
              'x-microsoft-outputformat': AZURE_WAV_FORMAT,
              'user-agent': 'videofy-live-certification',
            },
            body:
              "<speak version='1.0' xml:lang='en-US'>" +
              "<voice xml:lang='en-US' name='xx-XX-NoSuchVoiceNeural'>" +
              `${CORPUS.en.text}</voice></speak>`,
          },
        );
        const body = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 200);
        record({
          id: 'azure/identity/voice-honoured',
          kind: 'identity',
          vendor: 'azure',
          status: response.ok ? 'fail' : 'pass',
          headline: response.ok
            ? 'vendor answered 200 to a voice that does not exist -- it is IGNORING the name'
            : `refused with ${response.status}` +
              (body === ''
                ? ' and an EMPTY body (Azure sends no reason for a rejected voice)'
                : `: ${body}`),
          claim: 'an unknown voice ShortName must be refused',
          httpStatus: response.status,
        });
      } catch (error) {
        record({
          id: 'azure/identity/voice-honoured',
          kind: 'identity',
          vendor: 'azure',
          status: 'not-run',
          headline: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
        });
      }
    }
    console.log('');
  }

  // ------------------------------------------------------- fallback behaviour
  if (wanted('fallback') && elevenLabsConfigured && azureConfigured && azureProvider !== null) {
    console.log('Fallback behaviour -- DRIVEN, with real vendor refusals:');

    /*
     * A REAL refusal: the shipped provider pointed at an id the vendor does not
     * have. The request goes out, the vendor answers 4xx, and the chain meets
     * the same error shape it would meet in an outage.
     */
    const brokenEleven = new shipped.ElevenLabsStreamingSynthesisProvider({
      apiKey: process.env.ELEVENLABS_API_KEY,
      modelId: elevenModelId,
      voiceIds: {},
      defaultVoiceId: 'videofy0certification0nonexistent',
    });
    const brokenAzure = new shipped.AzureStreamingSynthesisProvider({
      apiKey: process.env.AZURE_SPEECH_KEY,
      region: azureRegion,
      voiceIds: {},
      defaultVoiceId: 'xx-XX-NoSuchVoiceNeural',
    });
    const healthyEleven = new shipped.ElevenLabsStreamingSynthesisProvider({
      apiKey: process.env.ELEVENLABS_API_KEY,
      modelId: elevenModelId,
      voiceIds: {},
      defaultVoiceId: elevenVoiceId,
    });

    const drives = [
      {
        id: 'chain/primary-refuses',
        providers: [brokenEleven, azureProvider],
        expectation: 'ElevenLabs refuses; Azure speaks; the caller is told nothing went wrong',
      },
      {
        id: 'chain/primary-healthy',
        providers: [healthyEleven, brokenAzure],
        expectation: 'ElevenLabs speaks; Azure is never called; no fall-through recorded',
      },
      {
        id: 'chain/all-refuse',
        providers: [brokenEleven, brokenAzure],
        expectation: 'nobody speaks; the caller IS told; zero samples, never silence-as-success',
      },
    ];

    for (const drive of drives) {
      const observed = { value: null };
      const chain = shipped.createFallbackSpeechSynthesisProvider({
        providers: drive.providers,
        onObservation: (observation) => {
          observed.value = observation;
        },
      });
      const outcome = await driveChain({
        id: drive.id,
        chain,
        observed,
        text: CORPUS.en.text,
        targetLanguage: 'en-US',
        voiceId: 'certification-voice',
        expectation: drive.expectation,
      });
      const held =
        drive.id === 'chain/all-refuse'
          ? outcome.servedBy === null &&
            outcome.samples === 0 &&
            outcome.reportedToCaller.length > 0
          : drive.id === 'chain/primary-healthy'
            ? outcome.audible && outcome.fellThrough.length === 0
            : outcome.audible && outcome.fellThrough.length === 1;
      record({
        ...outcome,
        status: held ? 'pass' : 'fail',
        headline:
          `servedBy=${outcome.servedBy ?? 'NOBODY'} ` +
          `fellThrough=[${outcome.fellThrough.join(', ')}] ` +
          `samples=${outcome.samples} reportedToCaller=${outcome.reportedToCaller.length}`,
      });
      if (GAP_MS > 0) await sleep(GAP_MS);
    }
    console.log('');
  }

  // --------------------------- Azure as the Nigerian fallback (always DEGRADED)
  if (wanted('nigerian') && azureConfigured && azureProvider !== null) {
    console.log('Azure as the Nigerian fallback -- driven through the shipped route.');
    console.log('  Every row here is DEGRADED by prior founder review, whatever the numbers say.');

    for (const language of NIGERIAN_LANGUAGES) {
      const entry = CORPUS[language];
      const observedOutcomes = [];
      const route = shipped.createNigerianSynthesisRoute({
        specialist: refusingProvider(
          'naijalingo-streaming:certification-refusal',
          'specialist unavailable (driven refusal, not a vendor outage)',
        ),
        fallback: azureProvider,
        onOutcome: (outcome) => observedOutcomes.push(outcome),
      });

      const chunks = [];
      const reported = [];
      let threw = null;
      let result = null;
      const started = Date.now();
      try {
        result = await route.provider.synthesize({
          text: entry.text,
          targetLanguage: entry.locale,
          voiceId: 'certification-voice',
          onChunk: (chunk) => chunks.push(chunk.samples),
          onError: (error) => reported.push((error?.message ?? String(error)).slice(0, 300)),
        });
      } catch (error) {
        threw = error instanceof Error ? error.message.slice(0, 300) : String(error);
      }
      const flat = new Int16Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        flat.set(chunk, offset);
        offset += chunk.length;
      }
      const analysis = analysePcm16(flat);
      const verdict = audibilityVerdict(analysis, entry.text);
      const outcome = observedOutcomes[observedOutcomes.length - 1] ?? null;
      const state = route.state();

      record({
        id: `azure/nigerian-degraded/${language}`,
        kind: 'nigerian-degraded',
        vendor: 'azure',
        /*
         * `degraded-produced-audio` is NOT a pass and must never be read as
         * one. It says the fallback path is wired and makes sound. Whether the
         * sound is acceptable Yoruba was answered on 2026-08-26, by ear, and
         * the answer was no.
         */
        status: verdict.audible ? 'degraded-produced-audio' : 'fail',
        headline:
          `rendering=${outcome?.rendering ?? 'none'} servedBy=${outcome?.servedBy ?? 'NOBODY'} ` +
          `${analysis.durationSeconds}s peak=${analysis.peakAmplitude} ` +
          '-- quality REFUSED by prior founder review',
        language,
        ssmlLanguageTag: entry.locale,
        text: entry.text,
        voiceIdExercised: azureVoiceId,
        modelIdExercised: `azure-speech-neural-tts (${azureRegion})`,
        rendering: outcome?.rendering ?? null,
        servedBy: outcome?.servedBy ?? null,
        fellThrough: outcome?.fellThrough ?? [],
        degradationReason: outcome?.degradation?.reason ?? null,
        routeMarkedDegraded: state.degraded,
        resultCarriedDegradationFlag: result?.degraded !== undefined && result?.degraded !== null,
        totalMs: Date.now() - started,
        audio: analysis,
        audible: verdict.audible,
        audibilityReasons: verdict.reasons,
        charactersPerSecond: verdict.charactersPerSecond,
        reportedToCaller: reported,
        threw,
        qualityStatus: 'refused-by-founder-review-2026-08-26',
        qualityNote:
          'Technically produces audio; quality refused by prior founder review. Azure mispronounces ' +
          'Yoruba, Hausa and Igbo while returning 200. This row is evidence of AVAILABILITY only.',
      });
      if (GAP_MS > 0) await sleep(GAP_MS);
    }

    /*
     * AND the end of the chain: specialist refuses, nothing behind it. The
     * honest answer is a reported failure, not a substituted voice.
     */
    const noFallbackOutcomes = [];
    const bare = shipped.createNigerianSynthesisRoute({
      specialist: refusingProvider(
        'naijalingo-streaming:certification-refusal',
        'specialist unavailable (driven refusal)',
      ),
      fallback: null,
      onOutcome: (outcome) => noFallbackOutcomes.push(outcome),
    });
    const reported = [];
    let samples = 0;
    try {
      const result = await bare.provider.synthesize({
        text: CORPUS.yo.text,
        targetLanguage: 'yo-NG',
        voiceId: 'certification-voice',
        onChunk: (chunk) => {
          samples += chunk.samples.length;
        },
        onError: (error) => reported.push((error?.message ?? String(error)).slice(0, 200)),
      });
      samples = result.samples ?? samples;
    } catch (error) {
      reported.push(error instanceof Error ? error.message.slice(0, 200) : String(error));
    }
    const last = noFallbackOutcomes[noFallbackOutcomes.length - 1] ?? null;
    record({
      id: 'nigerian/no-fallback-configured',
      kind: 'nigerian-degraded',
      status:
        last?.rendering === 'failed' && samples === 0 && reported.length > 0 ? 'pass' : 'fail',
      headline:
        `rendering=${last?.rendering ?? 'none'} samples=${samples} ` +
        `reportedToCaller=${reported.length} -- silence is reported, not served`,
      rendering: last?.rendering ?? null,
      servedBy: last?.servedBy ?? null,
      reportedToCaller: reported,
      chainName: bare.provider.name,
    });
    console.log('');
  }

  // --- the evidence file ---------------------------------------------------

  const summary = {
    lane: 'B -- TTS provider certification (ElevenLabs + Azure)',
    environment: ENVIRONMENT_LABEL,
    recordedAt: new Date().toISOString(),
    distRoot: DIST_ROOT,
    distCommit: (() => {
      try {
        return execFileSync('git', ['-C', DIST_ROOT, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    })(),
    samplesPerCheck: SAMPLES,
    audibilityThresholds: AUDIBILITY,
    configurationNamesPresent: WATCHED_NAMES.filter((name) => present(name)),
    configurationNamesAbsent: WATCHED_NAMES.filter((name) => !present(name)),
    idsExercised: {
      elevenlabs: {
        modelId: elevenModelId,
        voiceId: elevenVoiceId,
        voiceMapConfigured: elevenVoiceMapConfigured,
      },
      azure: {
        region: azureRegion,
        voiceShortName: azureVoiceId,
        voiceMapConfigured: azureVoiceMapConfigured,
      },
    },
    catalogue: {
      elevenlabs: catalogue.elevenlabs,
      azure:
        catalogue.azure === null
          ? null
          : {
              ...catalogue.azure,
              // A Set does not survive JSON; the useful answer is the one fact.
              shortNames: undefined,
              configuredVoiceHostedInRegion:
                catalogue.azure.shortNames === undefined
                  ? null
                  : catalogue.azure.shortNames.has(azureVoiceId),
            },
    },
    corpus: CORPUS,
    results,
    /*
     * SAID OUT LOUD IN THE ARTEFACT, not only in the console, because the JSON
     * is what gets pasted into a review and the scrollback is what gets lost.
     */
    doesNotEstablish: [
      'that any output is intelligible, correctly pronounced, or even in the requested language ' +
        '-- this harness cannot hear, and no measurement here overrides a listening test',
      'anything about a language not in `corpus`, or a direction not driven',
      'anything about production credentials: these are STAGING credentials',
      'any registry decision -- Lane F owns TranslationRouteRecord and no record is written here',
    ],
  };

  if (OUT_PATH !== '') {
    writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Evidence written to ${OUT_PATH}`);
  } else {
    console.log('--- EVIDENCE JSON ---');
    console.log(JSON.stringify(summary, null, 2));
  }

  const count = (status) => results.filter((entry) => entry.status === status).length;
  console.log('');
  console.log(
    `${results.length} checks: ${count('pass')} pass, ` +
      `${count('degraded-produced-audio')} degraded, ${count('mixed')} mixed, ` +
      `${count('fail')} fail, ${count('rate-limited')} rate-limited, ` +
      `${count('skipped') + count('not-run')} skipped.`,
  );
  /*
   * Exit 0 even with failures. This is a MEASUREMENT, and a vendor that is
   * genuinely broken is a true result -- a non-zero exit would put the harness
   * in a position to be silenced by a retry loop rather than read.
   */
}

main().catch((error) => {
  console.error(`certification harness failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
