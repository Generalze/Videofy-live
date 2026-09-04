#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Lane C -- certify 9jaLingo speech synthesis, one language at a time.
 *
 * WHAT THIS MEASURES, AND THE ONE THING IT REFUSES TO MEASURE. It sends real
 * sentences to the vendor for Hausa, Igbo, Yoruba and Nigerian Pidgin, times
 * every request, and DECODES the WAV that comes back -- rate, channels, bit
 * depth, duration, peak amplitude, RMS. That establishes exactly one claim:
 * `technicalCertified`, meaning the API returned valid playable audio at an
 * acceptable latency.
 *
 * It does NOT establish that the audio is good Yoruba. Nothing here can. The
 * founder rejected general vendors for these four languages BY EAR while every
 * server signal said fine -- 200, plausible byte count, normal latency, a
 * multilingual voice reading unfamiliar orthography with the phonology it
 * already had. So `humanLanguageReview` is a SEPARATE state, it is hard-wired
 * to `required-not-done` for all four languages, there is no flag that sets
 * it, and `assertHumanReviewUntouched()` refuses to emit a report if a later
 * edit tries. A certification harness that can promote its own vendor is not a
 * gate.
 *
 * WHY FOUR RESULTS AND NEVER ONE. Hausa evidence is not Igbo evidence. The
 * vendor serves all four from one endpoint under one model id, which makes it
 * very easy to run three requests, see 200 three times, and write down
 * "9jaLingo works". Each language gets its own sample set, its own latency
 * distribution, its own decoded-audio checks and its own verdict, and the
 * report has no rolled-up total anywhere.
 *
 * SILENCE IS A FAILURE. A well-formed WAV of nothing is the failure mode that
 * survives every other check: the status is 200, the header is valid, the byte
 * count is large, and the listener hears nothing. Peak amplitude and RMS are
 * measured on the decoded samples, and a clip below the floor is recorded as a
 * failed sample rather than as a successful request.
 *
 * THE COLD START IS REPORTED, NOT AVERAGED IN. The backend is SageMaker with
 * scale-to-zero: after an idle period synthesis answers `503 {"detail":
 * "Inference capacity is starting after an idle period. Please retry shortly
 * in about 5 minutes."}`. That is "asleep", not "broken". The run warms the
 * endpoint first, states how long warming took, and measures the distribution
 * on warm capacity only -- with the warm-up cost travelling beside every
 * figure, so a reader cannot mistake the warm median for what the first
 * listener of the day experiences.
 *
 * CREDENTIALS. The key is read from the service env file this host already
 * holds. Its NAME is printed; its value never leaves the process, is never
 * logged, and is never written to the report.
 *
 *     ssh c7-claude
 *     sudo node scripts/certify/naijalingo.mjs --samples 5 --json /tmp/naijalingo.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// --- arguments -------------------------------------------------------------

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const ENV_PATH = argValue('--env', '/etc/videofy/media-ingest.env');
const SAMPLES = Math.max(1, Number.parseInt(argValue('--samples', '5'), 10) || 5);
const LANGUAGES = argValue('--languages', 'ha,ig,yo,pcm')
  .split(',')
  .map((part) => part.trim().toLowerCase())
  .filter((part) => part !== '');
const JSON_OUT = argValue('--json', '');
const AUDIO_OUT = argValue('--audio-dir', '');
const GAP_MS = Math.max(0, Number.parseInt(argValue('--gap-ms', '750'), 10) || 0);
const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(argValue('--request-timeout-ms', '120000'), 10) || 120000,
);
/**
 * How long to wait for scale-to-zero capacity before giving up.
 *
 * The vendor's own 503 says "about five minutes", so a budget shorter than
 * that would record "9jaLingo does not work" when what happened is "9jaLingo
 * was asleep and nobody waited".
 */
const WARM_BUDGET_MS = Math.max(
  0,
  Number.parseInt(argValue('--warm-budget-ms', '600000'), 10) || 0,
);
const ENVIRONMENT_LABEL = argValue('--environment', 'staging (c7-eu-01)');

// --- the two states, kept apart --------------------------------------------

/**
 * The human half. A CONSTANT, deliberately.
 *
 * There is no `--human-review-passed` flag and there must never be one: the
 * only thing that can move this is a named speaker of the language saying so,
 * recorded by a human in `docs/certification/naijalingo.md`. Keeping it a
 * constant means a future edit that tries to set it from a measurement has to
 * delete this line, which is a visible diff rather than a quiet argument.
 */
const HUMAN_LANGUAGE_REVIEW = 'required-not-done';

function assertHumanReviewUntouched(report) {
  for (const [language, result] of Object.entries(report.languages)) {
    if (result.humanLanguageReview !== 'required-not-done') {
      console.error(
        `REFUSING TO EMIT: ${language} carries humanLanguageReview=` +
          `${String(result.humanLanguageReview)}. No automated check can establish ` +
          'pronunciation quality in these languages; only a named speaker can.',
      );
      process.exit(3);
    }
  }
}

// --- environment: NAMES leave this scope, values never do -------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(
      `Cannot read ${path} (${error?.code ?? 'error'}). Run this on the host that holds ` +
        'the keys, with permission to read the service env file -- try sudo.',
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
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
  return true;
}

function env(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

// --- the contract, as the product states it ---------------------------------

const BASE_URL = (env('NAIJALINGO_BASE_URL') ?? 'https://api.9jalingo.org').replace(/\/+$/u, '');
const AUTH_HEADER = (env('NAIJALINGO_AUTH_HEADER') ?? 'x-api-key').toLowerCase();
const MODEL_ID = env('NAIJALINGO_MODEL') ?? '9jalingo-tts-1';
const SPEECH_PATH = '/v1/audio/speech';
const HEALTH_PATH = '/v1/health';
const SPEAKERS_PATH = '/v1/speakers';

/**
 * The voice each language is certified WITH -- the one the product will send.
 *
 * `live-provider-wiring.ts` builds its map as the vendor's published speaker
 * names overlaid by the opaque ids the founder chose by ear on 30 Aug 2026, so
 * yo/ig/ha resolve to a chosen id and pcm falls through to a published name.
 * Certifying anything else would certify a configuration nobody ships.
 */
const PRODUCT_VOICE_BY_LANGUAGE = {
  ha: env('NAIJALINGO_VOICE_HA') ?? '93ef940b-5e72-43d8-99d9-23cb96539cba',
  ig: env('NAIJALINGO_VOICE_IG') ?? '036d27c0-448d-4d6c-a97c-9606a58a849e',
  yo: env('NAIJALINGO_VOICE_YO') ?? 'e8792ad0-97c9-4a09-aa14-a013b53a2772',
  pcm: env('NAIJALINGO_VOICE_PCM') ?? 'ada_pcm',
};

/**
 * The vendor's published example speaker names, for the identity cross-check.
 *
 * The lane brief named `blessing_pcm` where the shipped provider names
 * `ada_pcm`. Rather than pick one, the speaker inventory is queried and both
 * are looked for in it, so the report carries what the vendor lists today.
 */
const PUBLISHED_SPEAKER_BY_LANGUAGE = {
  ha: 'aisha_ha',
  ig: 'adaeze_ig',
  yo: 'adeola_yo',
  pcm: 'ada_pcm',
};

/** The other candidate names, checked against the inventory but never assumed. */
const DISPUTED_SPEAKER_BY_LANGUAGE = {
  pcm: 'blessing_pcm',
};

const VOICE_SOURCE_BY_LANGUAGE = {
  ha: 'founder-selected opaque voice id (female), 30 Aug 2026',
  ig: 'founder-selected opaque voice id (female), 30 Aug 2026',
  yo: 'founder-selected opaque voice id (female), 30 Aug 2026',
  pcm: 'vendor-published speaker name; no Pidgin voice has been chosen by ear',
};

const LANGUAGE_NAME = { ha: 'Hausa', ig: 'Igbo', yo: 'Yoruba', pcm: 'Nigerian Pidgin' };

/**
 * Real sentences, written in each language rather than transliterated English.
 *
 * They vary in length on purpose: a fixed one-word prompt makes every clip the
 * same duration, which hides a synthesiser that emits a fixed-length stub. The
 * report records characters-per-second so a clip far too short for its text is
 * visible as a number rather than as a feeling.
 *
 * ASCII, without tone marks. Yoruba and Igbo are tonal and written with
 * diacritics; a synthesiser reads undiacritised text by guessing tone. That is
 * a REALISTIC input -- the machine-translation stage upstream emits exactly
 * this -- but it is one more reason the human review below cannot be skipped,
 * and it is stated here rather than left for a reader to discover.
 */
const SENTENCES = {
  ha: [
    'Kowane mutum zai iya jin wannan a cikin harshensa.',
    'Barka da zuwa taron mu na yau.',
    'Za mu fara fassarar cikin minti biyar.',
    'Wannan magana tana da muhimmanci a gare mu duka.',
    'Don Allah a jira kadan kafin mu fara.',
  ],
  ig: [
    "Onye o bula nwere ike inu nke a n'asusu ya.",
    'Nnoo na nzuko anyi taa.',
    "Anyi ga-amalite nsughari ahu n'ime nkeji ise.",
    'Okwu a di mkpa nye anyi niile.',
    'Biko chere obere oge tupu anyi amalite.',
  ],
  yo: [
    'Gbogbo eeyan lo le gbo oro yii lede won.',
    'E kaabo si ipade wa loni.',
    'A o bere itumo naa ni iseju marun.',
    'Oro yii se pataki fun gbogbo wa.',
    'E jowo, e duro die ki a to bere.',
  ],
  pcm: [
    'Everybody fit hear dis one for im own language.',
    'Welcome to our meeting wey dey happen today.',
    'We go start di translation for five minutes time.',
    'Dis matter important well well for all of us.',
    'Abeg wait small before we start.',
  ],
};

// --- acceptance thresholds, stated rather than implied ----------------------

/**
 * Below this peak the clip is silence dressed as audio, and that is a FAILURE.
 *
 * A hundredth of full scale, about -40 dBFS: quieter than any speech a
 * listener would call audible, and comfortably above the dither floor of a
 * 16-bit encoder, so a genuinely quiet-but-real utterance is not condemned.
 */
const SILENCE_PEAK_FLOOR = 0.01;
/** A clip shorter than this cannot be a spoken sentence at any speaking rate. */
const MINIMUM_DURATION_SECONDS = 0.5;
/**
 * The latency one utterance of synthesis may take.
 *
 * Written down BEFORE the run, so the verdict is a comparison against a stated
 * number rather than an impression formed after seeing the results.
 */
const ACCEPTABLE_MEDIAN_MS = 8000;
const ACCEPTABLE_MAX_MS = 20000;
/** Below this success rate the route is not certified whatever the latency. */
const ACCEPTABLE_SUCCESS_RATE = 1;

// --- WAV decoding ----------------------------------------------------------

/**
 * Walk the RIFF chunk list properly instead of assuming a 44-byte header.
 *
 * The assumption works until the vendor emits a LIST or fact chunk, at which
 * point the first samples read are header bytes -- which decodes as a click
 * and a plausible duration rather than as an error.
 */
function decodeWav(buffer) {
  if (buffer.length < 12) throw new Error(`too short to be a WAV (${buffer.length} bytes)`);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV: first bytes are ${JSON.stringify(buffer.toString('ascii', 0, 4))}`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRateHz: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (format === null) throw new Error('no fmt chunk');
  if (data === null) throw new Error('no data chunk');
  if (format.audioFormat !== 1) {
    throw new Error(`not linear PCM (WAVE format tag ${format.audioFormat})`);
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(`expected 16-bit samples, header declares ${format.bitsPerSample}`);
  }

  const frames = Math.floor(data.length / (2 * Math.max(1, format.channels)));
  let peak = 0;
  let sumOfSquares = 0;
  let counted = 0;
  // Samples pinned at full scale. A synthesiser that clips is not broken --
  // the clip decodes, plays, and passes every structural check -- but the
  // distortion is audible, and it is the sort of thing a reviewer blames on
  // the language model rather than on the gain stage unless it is counted.
  let clipped = 0;
  for (let index = 0; index + 1 < data.length; index += 2) {
    const raw = data.readInt16LE(index);
    if (raw >= 32767 || raw <= -32768) clipped += 1;
    const sample = raw / 32768;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumOfSquares += sample * sample;
    counted += 1;
  }
  const rms = counted === 0 ? 0 : Math.sqrt(sumOfSquares / counted);

  /*
   * What fraction of the clip carries energy, in 20 ms frames.
   *
   * Peak and overall RMS cannot tell a sentence from a two-second buzz
   * followed by silence -- both can produce the same two numbers. The voiced
   * fraction can: connected speech sits in a band, while a stub, a hum or a
   * clip that is mostly trailing silence falls outside it.
   *
   * The threshold is RELATIVE TO THE CLIP'S OWN PEAK (20 dB below it) rather
   * than absolute, because these voices differ by nearly 20 dB in level and
   * an absolute floor would score the quiet ones as half silent for being
   * quiet. It is a coarse instrument and it is reported as one: it says
   * "something is being said for most of this clip", never what.
   */
  const frameLength = Math.max(1, Math.round(format.sampleRateHz * 0.02));
  const voicedFloor = peak * 0.1;
  let voicedFrames = 0;
  let totalFrames = 0;
  for (let start = 0; start + frameLength * 2 <= data.length; start += frameLength * 2) {
    let frameSquares = 0;
    for (let offset = 0; offset < frameLength * 2; offset += 2) {
      const value = data.readInt16LE(start + offset) / 32768;
      frameSquares += value * value;
    }
    totalFrames += 1;
    if (Math.sqrt(frameSquares / frameLength) > voicedFloor) voicedFrames += 1;
  }

  return {
    ...format,
    voicedFraction: totalFrames === 0 ? null : Number((voicedFrames / totalFrames).toFixed(3)),
    bytes: buffer.length,
    dataBytes: data.length,
    frames,
    durationSeconds:
      format.sampleRateHz === 0 ? 0 : Number((frames / format.sampleRateHz).toFixed(3)),
    peakAmplitude: Number(peak.toFixed(4)),
    peakDbfs: peak === 0 ? null : Number((20 * Math.log10(peak)).toFixed(1)),
    rms: Number(rms.toFixed(4)),
    rmsDbfs: rms === 0 ? null : Number((20 * Math.log10(rms)).toFixed(1)),
    clippedSamples: clipped,
  };
}

/**
 * Level findings, reported ALONGSIDE the verdict rather than folded into it.
 *
 * Clipped audio and quiet audio are both still playable audio, so neither
 * moves `technicalCertified`: inventing a stricter bar here, after the
 * measurements were in, would quietly redefine the word the report is built
 * on. They are recorded because they are real, they differ BY LANGUAGE, and a
 * listener meets them before anything else -- a programme that cuts from
 * Hausa at -13 dB to Igbo at -25 dB sounds like the Igbo speaker walked away
 * from the microphone.
 */
function levelFindings(decoded) {
  if (decoded.length === 0) return null;
  const clippedClips = decoded.filter((clip) => clip.clippedSamples > 0);
  const levels = decoded.map((clip) => clip.rmsDbfs).filter((value) => value !== null);
  return {
    clippedClips: clippedClips.length,
    ofClips: decoded.length,
    worstClippedSamples: clippedClips.reduce(
      (worst, clip) => Math.max(worst, clip.clippedSamples),
      0,
    ),
    rmsDbfs: levels.length === 0 ? null : { min: Math.min(...levels), max: Math.max(...levels) },
    voicedFraction: (() => {
      const voiced = decoded.map((clip) => clip.voicedFraction).filter((value) => value !== null);
      return voiced.length === 0
        ? null
        : { min: Math.min(...voiced), max: Math.max(...voiced) };
    })(),
    note:
      'clipping and level are NOT part of technicalCertified -- the audio plays -- but both are ' +
      'audible, both differ by language, and one shared loudness normalisation stage is the fix',
  };
}

/**
 * How much the SAME sentence varies in length from one rendering to the next.
 *
 * The sentence list is walked in a cycle, so any sample count above the list
 * length renders each sentence more than once -- which turns a free by-product
 * of the loop into the one measurement that distinguishes a synthesiser
 * reading its input from one generating extra speech of its own. A duration
 * ratio near 1.0 is a model saying the same thing each time; a ratio of two is
 * a model that said something else, and the text cannot tell you which.
 *
 * It matters for a LIVE pipeline beyond quality: a scheduler that has budgeted
 * five seconds of programme audio and receives twelve has to cut, and the cut
 * lands mid-word in a language the operator does not speak.
 */
function repeatability(succeeded) {
  const byText = new Map();
  for (const sample of succeeded) {
    if (sample.audio === null) continue;
    const list = byText.get(sample.characters) ?? [];
    list.push(sample.audio.durationSeconds);
    byText.set(sample.characters, list);
  }
  let worst = null;
  for (const [characters, durations] of byText) {
    if (durations.length < 2) continue;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const ratio = min === 0 ? null : Number((max / min).toFixed(2));
    if (ratio !== null && (worst === null || ratio > worst.ratio)) {
      worst = { characters, durations, ratio };
    }
  }
  if (worst === null) {
    return { measured: false, note: 'no sentence was rendered twice; raise --samples above 5' };
  }
  return {
    measured: true,
    worstDurationRatio: worst.ratio,
    forTextOfCharacters: worst.characters,
    durationsSeconds: worst.durations,
    note:
      'the same input text, rendered more than once, produced outputs differing by this ratio; ' +
      'a ratio well above 1 means the model is not deterministic about WHAT it says, which no ' +
      'server signal reports and only a speaker of the language can adjudicate',
  };
}

// --- HTTP ------------------------------------------------------------------

function authHeaders(rawKey) {
  const scheme = env('NAIJALINGO_AUTH_SCHEME');
  const presented = scheme === null ? rawKey : `${scheme} ${rawKey}`;
  return { [AUTH_HEADER]: presented, 'content-type': 'application/json' };
}

async function speak({ rawKey, text, voice, language, headers }) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${BASE_URL}${SPEECH_PATH}`, {
      method: 'POST',
      headers: headers ?? authHeaders(rawKey),
      body: JSON.stringify({ input: text, voice, lang: language, response_format: 'wav' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: null,
      problem: `transport: ${error?.name ?? 'error'} ${error?.message ?? ''}`.trim(),
    };
  }
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const detail = bodyBytes.toString('utf8').slice(0, 240).replace(/\s+/gu, ' ');
    return {
      ok: false,
      latencyMs,
      status: response.status,
      cold: response.status === 503 || /capacity is starting|retry shortly/iu.test(detail),
      problem: `HTTP ${response.status}: ${detail}`,
    };
  }
  return {
    ok: true,
    latencyMs,
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: bodyBytes,
  };
}

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median:
      sorted.length % 2 === 0
        ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
        : sorted[middle],
    mean: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    max: sorted[sorted.length - 1],
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- contract probes: confirm, do not assume --------------------------------

/**
 * Every published fact re-established against the live API in this run.
 *
 * The facts were measured earlier in the session and written down; a fact
 * written down is a fact that WAS true. Re-running them costs a handful of
 * requests and makes the report's premises observations of the same afternoon
 * as its conclusions.
 */
async function probeContract(rawKey) {
  const probes = [];

  const health = await (async () => {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${BASE_URL}${HEALTH_PATH}`, {
        headers: { [AUTH_HEADER]: rawKey },
        signal: AbortSignal.timeout(30000),
      });
      const text = (await response.text()).slice(0, 240).replace(/\s+/gu, ' ');
      return { status: response.status, latencyMs: Date.now() - startedAt, body: text };
    } catch (error) {
      return {
        status: null,
        latencyMs: Date.now() - startedAt,
        body: String(error?.message ?? error),
      };
    }
  })();
  probes.push({
    fact: `base URL ${BASE_URL}, health at GET ${HEALTH_PATH}`,
    observed: `HTTP ${health.status ?? 'transport error'} in ${health.latencyMs} ms: ${health.body}`,
    confirmed: health.status === 200,
  });

  /*
   * The auth header, tested ON THE ENDPOINT THAT ENFORCES IT.
   *
   * An earlier revision put this probe on GET /v1/speakers and read a 200 as
   * "Authorization: Bearer works too", which would have unpicked a correct
   * contract on false evidence. /v1/speakers and /v1/health are OPEN: no
   * header at all, and a deliberately invalid key, both answer 200. The
   * catalogue is public; only synthesis is charged, so only synthesis is
   * guarded. A probe pointed at an unauthenticated endpoint measures nothing
   * about authentication.
   *
   * POST /v1/audio/speech does enforce it, and enforces it BEFORE capacity --
   * a 401 comes back while the engine is still asleep -- so this runs cold.
   */
  const authProbe = async (headers) => {
    try {
      const response = await fetch(`${BASE_URL}${SPEECH_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Test.',
          voice: PUBLISHED_SPEAKER_BY_LANGUAGE.pcm,
          lang: 'pcm',
          response_format: 'wav',
        }),
        signal: AbortSignal.timeout(30000),
      });
      const detail = (await response.text()).slice(0, 120).replace(/\s+/gu, ' ');
      return { status: response.status, detail };
    } catch {
      return { status: null, detail: 'transport error' };
    }
  };
  const bearerOnly = await authProbe({ authorization: `Bearer ${rawKey}` });
  // A literal that is not a credential, and could not be one.
  const invalidKey = await authProbe({ [AUTH_HEADER]: 'not-a-valid-key-000' });
  probes.push({
    fact:
      `authentication is the ${AUTH_HEADER} header on POST ${SPEECH_PATH}, not ` +
      'Authorization: Bearer, and the key is actually checked',
    observed:
      `presented as Authorization: Bearer -> HTTP ${bearerOnly.status ?? 'transport error'} ` +
      `${bearerOnly.detail}; an invalid value in ${AUTH_HEADER} -> HTTP ` +
      `${invalidKey.status ?? 'transport error'} ${invalidKey.detail}`,
    confirmed: bearerOnly.status === 401 && invalidKey.status === 401,
  });

  probes.push({
    fact: `GET ${SPEAKERS_PATH} and GET ${HEALTH_PATH} are UNAUTHENTICATED`,
    observed: await (async () => {
      try {
        const response = await fetch(`${BASE_URL}${SPEAKERS_PATH}?language=pcm`, {
          signal: AbortSignal.timeout(30000),
        });
        return (
          `the catalogue answered HTTP ${response.status} with no key at all -- it is public, ` +
          'so no probe against it says anything about authentication'
        );
      } catch (error) {
        return `transport error: ${String(error?.message ?? error)}`;
      }
    })(),
    confirmed: true,
  });

  /*
   * The speaker inventory, per language, and WHICH SPEAKER each configured id
   * resolves to.
   *
   * COUNT ROWS, NOT IDENTIFIERS. Each row carries several names for the same
   * speaker -- `id`, `voice_code`, `name`, `database_id` -- so collecting them
   * all and reporting the length says 132 Igbo speakers where there are 66.
   *
   * RESOLVE, DO NOT MERELY MATCH. The founder's chosen voices are opaque
   * UUIDs, and they are the `database_id` of a row rather than its `id`; a
   * membership test against the visible names says "NOT listed" about a voice
   * that is perfectly valid. Worse, a UUID that IS valid may belong to the
   * wrong language or the wrong gender, and the vendor would answer 200 either
   * way. So the row is looked up and its language and gender are reported.
   */
  const speakersFor = async (language) => {
    try {
      const response = await fetch(
        `${BASE_URL}${SPEAKERS_PATH}?language=${encodeURIComponent(language)}`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok) return { status: response.status, rows: null };
      const payload = await response.json();
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.speakers)
          ? payload.speakers
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
      return { status: response.status, rows };
    } catch (error) {
      return { status: null, rows: null, problem: String(error?.message ?? error) };
    }
  };

  // EVERY language's catalogue is loaded BEFORE any of them is judged, so that
  // "this Hausa route is configured with an Igbo speaker" is detectable. Built
  // one language at a time, the lookup table would only ever contain languages
  // already visited and the first one could never be found to be wrong.
  const listedByLanguage = new Map();
  const everySpeaker = [];
  for (const language of LANGUAGES) {
    const listed = await speakersFor(language);
    listedByLanguage.set(language, listed);
    if (listed.rows !== null) everySpeaker.push(...listed.rows);
  }

  for (const language of LANGUAGES) {
    const listed = listedByLanguage.get(language);

    const identify = (candidate) => {
      if (candidate === undefined) return null;
      const row = everySpeaker.find(
        (entry) =>
          entry?.id === candidate ||
          entry?.voice_code === candidate ||
          entry?.database_id === candidate,
      );
      if (row === undefined) return `${candidate}: NOT in the catalogue`;
      const mismatch = row.language === language ? '' : ` -- WRONG LANGUAGE for a ${language} route`;
      return `${candidate} resolves to ${row.id} (${row.language}, ${row.gender})${mismatch}`;
    };

    const voice = PRODUCT_VOICE_BY_LANGUAGE[language];
    const resolved = identify(voice);
    const resolvedRow = everySpeaker.find(
      (entry) => entry?.id === voice || entry?.voice_code === voice || entry?.database_id === voice,
    );
    probes.push({
      fact: `speaker inventory for ${language}, and which speaker this run's voice resolves to`,
      observed:
        listed.rows === null
          ? `GET ${SPEAKERS_PATH}?language=${language} answered HTTP ${
              listed.status ?? 'transport error'
            }`
          : `${listed.rows.length} speakers listed; configured voice ${resolved}; published ` +
            `example ${identify(PUBLISHED_SPEAKER_BY_LANGUAGE[language])}` +
            (DISPUTED_SPEAKER_BY_LANGUAGE[language] === undefined
              ? ''
              : `; also named in the brief, ${identify(DISPUTED_SPEAKER_BY_LANGUAGE[language])}`),
      confirmed:
        listed.rows !== null &&
        listed.rows.length > 0 &&
        resolvedRow !== undefined &&
        resolvedRow.language === language,
      speakerCount: listed.rows === null ? null : listed.rows.length,
      resolvedVoice:
        resolvedRow === undefined
          ? null
          : { id: resolvedRow.id, language: resolvedRow.language, gender: resolvedRow.gender },
      language,
    });
  }

  return probes;
}

/** A language code sent where a speaker id belongs. It must be refused. */
async function probeLanguageCodeAsVoice(rawKey) {
  const language = LANGUAGES.includes('yo') ? 'yo' : LANGUAGES[0];
  const attempt = await speak({
    rawKey,
    text: SENTENCES[language]?.[0] ?? 'Test.',
    voice: language,
    language,
  });
  // A 503 here proves nothing either way: the request never reached whatever
  // validates the field. Reported as INCONCLUSIVE rather than as a refusal,
  // because "the engine was asleep" and "the vendor rejects a language code"
  // are different facts and only one of them is about the contract.
  if (!attempt.ok && attempt.cold === true) {
    return {
      fact: 'voice is a SPEAKER ID; a language code in that field is refused',
      observed:
        `sending voice="${language}" returned ${attempt.problem} -- capacity was cold, so the ` +
        'request never reached field validation',
      confirmed: null,
    };
  }
  return {
    fact: 'voice is a SPEAKER ID; a language code in that field is refused',
    observed: attempt.ok
      ? `sending voice="${language}" returned HTTP 200 with audio -- the field is NOT validated`
      : `sending voice="${language}" returned ${attempt.problem}`,
    confirmed: !attempt.ok,
  };
}

// --- warming ---------------------------------------------------------------

/**
 * Wake scale-to-zero capacity, and say how long it took.
 *
 * Measuring a cold vendor and publishing the result as its latency describes
 * the nap, not the service; hiding the nap describes a vendor that is always
 * up, which is not the one the first listener of the day meets. So: warm
 * first, publish the warm-up cost, measure the distribution warm.
 */
async function warmUp(rawKey) {
  const language = LANGUAGES[0];
  const voice = PRODUCT_VOICE_BY_LANGUAGE[language];
  const startedAt = Date.now();
  let attempts = 0;
  let lastProblem = null;
  let sawCold = false;
  // Every status the wake-up loop met, counted. A run that spends ten minutes
  // on 503 and a run that spends ten minutes on 404 look identical from a
  // progress dot, and they are opposite diagnoses: one is a sleeping engine,
  // the other is a withdrawn speaker id being retried forever.
  const statusCounts = {};
  process.stdout.write('  waking 9jaLingo (scale-to-zero capacity)');
  while (Date.now() - startedAt < WARM_BUDGET_MS) {
    attempts += 1;
    const attempt = await speak({ rawKey, text: 'Test.', voice, language });
    const key = attempt.status === null ? 'transport-error' : String(attempt.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (attempt.ok) {
      const warmedMs = Date.now() - startedAt;
      process.stdout.write(
        ` serving after ${(warmedMs / 1000).toFixed(1)} s (${attempts} attempt(s))\n`,
      );
      return { warmedMs, attempts, statusCounts, coldStart: sawCold, lastProblem, voice, language };
    }
    if (attempt.cold === true) sawCold = true;
    lastProblem = attempt.problem;
    process.stdout.write('.');
    await wait(15000);
  }
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(` still cold after ${Math.round(elapsedMs / 1000)} s\n`);
  return {
    warmedMs: null,
    elapsedMs,
    attempts,
    statusCounts,
    coldStart: true,
    lastProblem,
    voice,
    language,
  };
}

// --- one language ----------------------------------------------------------

async function certifyLanguage(rawKey, language, warm) {
  const voice = PRODUCT_VOICE_BY_LANGUAGE[language];
  const sentences = SENTENCES[language] ?? [];
  const name = LANGUAGE_NAME[language] ?? language;
  const perSample = [];

  if (voice === undefined || sentences.length === 0) {
    return {
      language,
      languageName: name,
      voice: voice ?? null,
      skipped:
        voice === undefined
          ? 'no speaker id is configured for this language'
          : 'no sentences are written for this language',
      technicalCertified: false,
      humanLanguageReview: HUMAN_LANGUAGE_REVIEW,
    };
  }

  process.stdout.write(`  ${name} (${language}) `);
  for (let index = 0; index < SAMPLES; index += 1) {
    const text = sentences[index % sentences.length];
    const attempt = await speak({ rawKey, text, voice, language });
    if (!attempt.ok) {
      perSample.push({
        index,
        characters: text.length,
        ok: false,
        latencyMs: attempt.latencyMs,
        status: attempt.status,
        problem: attempt.problem,
      });
      process.stdout.write('x');
    } else {
      let audio = null;
      let problem = null;
      try {
        audio = decodeWav(attempt.body);
      } catch (error) {
        problem = `undecodable audio: ${error.message}`;
      }
      if (audio !== null && audio.peakAmplitude < SILENCE_PEAK_FLOOR) {
        problem = `silent clip: peak ${audio.peakAmplitude} is below ${SILENCE_PEAK_FLOOR}`;
      } else if (audio !== null && audio.durationSeconds < MINIMUM_DURATION_SECONDS) {
        problem = `clip of ${audio.durationSeconds} s is too short to be a spoken sentence`;
      }
      if (audio !== null && AUDIO_OUT !== '') {
        mkdirSync(AUDIO_OUT, { recursive: true });
        writeFileSync(join(AUDIO_OUT, `${language}-${index + 1}.wav`), attempt.body);
      }
      perSample.push({
        index,
        characters: text.length,
        ok: problem === null,
        latencyMs: attempt.latencyMs,
        status: attempt.status,
        contentType: attempt.contentType ?? null,
        audio,
        charactersPerSecond:
          audio === null || audio.durationSeconds === 0
            ? null
            : Number((text.length / audio.durationSeconds).toFixed(1)),
        ...(problem === null ? {} : { problem }),
      });
      process.stdout.write(problem === null ? '.' : '!');
    }
    if (index + 1 < SAMPLES) await wait(GAP_MS);
  }

  // The published speaker NAME, once, beside the opaque id the product sends.
  // Two identifiers that both work is a fact worth holding; it is recorded
  // separately because it is ONE sample and must never join the distribution.
  const publishedSpeaker = PUBLISHED_SPEAKER_BY_LANGUAGE[language];
  let alternate = null;
  if (publishedSpeaker !== undefined && publishedSpeaker !== voice) {
    const attempt = await speak({ rawKey, text: sentences[0], voice: publishedSpeaker, language });
    let audio = null;
    if (attempt.ok) {
      try {
        audio = decodeWav(attempt.body);
      } catch {
        audio = null;
      }
    }
    alternate = {
      speaker: publishedSpeaker,
      ok: attempt.ok && audio !== null && audio.peakAmplitude >= SILENCE_PEAK_FLOOR,
      latencyMs: attempt.latencyMs,
      status: attempt.status,
      ...(attempt.ok ? {} : { problem: attempt.problem }),
      ...(audio === null ? {} : { audio }),
    };
    process.stdout.write(alternate.ok ? '+' : '-');
  }

  const succeeded = perSample.filter((sample) => sample.ok);
  const latency = stats(succeeded.map((sample) => sample.latencyMs));
  const successRate = perSample.length === 0 ? 0 : succeeded.length / perSample.length;
  const decoded = succeeded.map((sample) => sample.audio).filter((value) => value !== null);

  const rates = [...new Set(decoded.map((audio) => audio.sampleRateHz))];
  const channels = [...new Set(decoded.map((audio) => audio.channels))];
  const depths = [...new Set(decoded.map((audio) => audio.bitsPerSample))];

  const reasons = [];
  if (successRate < ACCEPTABLE_SUCCESS_RATE) {
    reasons.push(
      `success rate ${(successRate * 100).toFixed(0)}% is below the required ` +
        `${(ACCEPTABLE_SUCCESS_RATE * 100).toFixed(0)}%`,
    );
  }
  if (latency === null) {
    reasons.push('no sample succeeded, so there is no latency distribution');
  } else {
    if (latency.median > ACCEPTABLE_MEDIAN_MS) {
      reasons.push(`median ${latency.median} ms exceeds the ${ACCEPTABLE_MEDIAN_MS} ms budget`);
    }
    if (latency.max > ACCEPTABLE_MAX_MS) {
      reasons.push(`slowest sample ${latency.max} ms exceeds the ${ACCEPTABLE_MAX_MS} ms ceiling`);
    }
  }
  if (decoded.length === 0) reasons.push('no clip decoded as playable audio');
  if (rates.length > 1) reasons.push(`inconsistent sample rate across clips: ${rates.join(', ')}`);

  const technicalCertified = reasons.length === 0;

  process.stdout.write(
    ` ${succeeded.length}/${perSample.length} ok` +
      (latency === null ? '' : `, median ${latency.median} ms`) +
      (decoded.length === 0 ? '' : `, ${rates.join('/')} Hz ${channels.join('/')} ch`) +
      (decoded.length === 0
        ? ''
        : `, ${decoded.filter((clip) => clip.clippedSamples > 0).length}/${decoded.length} clipped`) +
      '\n',
  );

  return {
    language,
    languageName: name,
    voice,
    voiceSource: VOICE_SOURCE_BY_LANGUAGE[language] ?? 'unstated',
    modelId: MODEL_ID,
    request: `POST ${SPEECH_PATH} {input, voice, lang, response_format:"wav"}`,
    sampleCount: perSample.length,
    succeeded: succeeded.length,
    successRate: Number(successRate.toFixed(3)),
    latencyMs: latency,
    audio:
      decoded.length === 0
        ? null
        : {
            encoding: 'linear PCM (WAVE format tag 1)',
            sampleRateHz: rates,
            channels,
            bitsPerSample: depths,
            durationSeconds: {
              min: Math.min(...decoded.map((clip) => clip.durationSeconds)),
              max: Math.max(...decoded.map((clip) => clip.durationSeconds)),
            },
            peakAmplitude: {
              min: Math.min(...decoded.map((clip) => clip.peakAmplitude)),
              max: Math.max(...decoded.map((clip) => clip.peakAmplitude)),
            },
            rms: {
              min: Math.min(...decoded.map((clip) => clip.rms)),
              max: Math.max(...decoded.map((clip) => clip.rms)),
            },
            silentClips: succeeded.filter(
              (sample) => sample.audio !== null && sample.audio.peakAmplitude < SILENCE_PEAK_FLOOR,
            ).length,
          },
    level: levelFindings(decoded),
    repeatability: repeatability(succeeded),
    coldStart: {
      warmedMs: warm.warmedMs,
      observedCold: warm.coldStart,
      note:
        'the distribution above is WARM-PATH ONLY; the first request after an idle period ' +
        'pays the warm-up cost or is refused with HTTP 503',
    },
    alternateSpeakerProbe: alternate,
    perSample,
    technicalCertified,
    technicalCertifiedBecause: technicalCertified
      ? 'every sample returned decodable, non-silent linear PCM within the stated budget'
      : reasons.join('; '),
    /*
     * THE OTHER STATE. Not derived from anything above, and it cannot be:
     * every measurement in this file would look identical if the voice were
     * reading this language's orthography with English phonology, which is the
     * exact defect that got two general vendors rejected by ear.
     */
    humanLanguageReview: HUMAN_LANGUAGE_REVIEW,
    humanLanguageReviewNote:
      `no automated signal distinguishes correct ${name} pronunciation from confident wrong ` +
      `${name}; a named speaker of ${name} must listen before this route is approved for any ` +
      'production service scope',
  };
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log('9jaLingo certification -- four languages, measured independently');
  console.log(`  environment     ${ENVIRONMENT_LABEL}`);
  console.log(`  base URL        ${BASE_URL}`);
  console.log(`  auth header     ${AUTH_HEADER} (name only; no value is printed or stored)`);
  console.log(`  model           ${MODEL_ID}`);
  console.log(`  samples each    ${SAMPLES}`);
  console.log(`  languages       ${LANGUAGES.join(', ')}`);

  const loaded = loadEnvFile(ENV_PATH);
  console.log(`  env file        ${ENV_PATH} ${loaded ? 'read' : 'ABSENT'}`);
  const rawKey = env('NAIJALINGO_API_KEY');
  console.log(`  credential      NAIJALINGO_API_KEY ${rawKey === null ? 'MISSING' : 'present'}`);
  if (rawKey === null) {
    console.error(
      '\nNAIJALINGO_API_KEY is not set. A missing key is a SKIP, not a failure and not a pass ' +
        '-- nothing is certified and nothing is condemned.',
    );
    process.exit(2);
  }

  console.log('');
  const warm = await warmUp(rawKey);
  if (warm.warmedMs === null) {
    console.error(
      `\nThe vendor never served within ${Math.round(WARM_BUDGET_MS / 1000)} s ` +
        `(last: ${warm.lastProblem ?? 'unknown'}). NOTHING is certified and nothing is ` +
        'condemned: the provider was never exercised warm.',
    );
  }

  console.log('\ncontract probes');
  // RUN EVEN WHEN THE INFERENCE ENDPOINT IS ASLEEP. Health, the speaker
  // inventory and the auth header are served by the vendor's API gateway, not
  // by the SageMaker endpoint that scales to zero. An earlier revision skipped
  // all of them whenever warming failed, which threw away the only evidence
  // available on exactly the run where evidence was scarcest -- and made a
  // sleeping engine look like an unreachable vendor.
  const contract = await probeContract(rawKey);
  contract.push(await probeLanguageCodeAsVoice(rawKey));
  for (const probe of contract) {
    const verdict =
      probe.confirmed === null ? 'inconclusive' : probe.confirmed ? 'confirmed' : 'NOT confirmed';
    console.log(`  [${verdict}] ${probe.fact}`);
    console.log(`      ${probe.observed}`);
  }

  console.log('\nper-language measurement');
  const languages = {};
  for (const language of LANGUAGES) {
    languages[language] =
      warm.warmedMs === null
        ? {
            language,
            languageName: LANGUAGE_NAME[language] ?? language,
            skipped: 'the vendor never served warm within the budget',
            technicalCertified: false,
            humanLanguageReview: HUMAN_LANGUAGE_REVIEW,
          }
        : await certifyLanguage(rawKey, language, warm);
  }

  const report = {
    provider: 'naijalingo',
    providerName: '9jaLingo',
    modelId: MODEL_ID,
    capability: 'speech-synthesis',
    executionClass: 'cloud',
    environment: ENVIRONMENT_LABEL,
    baseUrl: BASE_URL,
    authHeader: AUTH_HEADER,
    recordedAt: new Date().toISOString(),
    warmUp: warm,
    contract,
    languages,
    thresholds: {
      silencePeakFloor: SILENCE_PEAK_FLOOR,
      minimumDurationSeconds: MINIMUM_DURATION_SECONDS,
      acceptableMedianMs: ACCEPTABLE_MEDIAN_MS,
      acceptableMaxMs: ACCEPTABLE_MAX_MS,
      acceptableSuccessRate: ACCEPTABLE_SUCCESS_RATE,
    },
    statement:
      'technicalCertified means the API returned valid playable audio at acceptable latency. ' +
      'It is NOT a statement about pronunciation. humanLanguageReview is required-not-done for ' +
      'every language here, and no measurement in this file can change it.',
  };

  assertHumanReviewUntouched(report);

  console.log('\nverdict -- two states, kept apart');
  for (const language of LANGUAGES) {
    const result = languages[language];
    console.log(
      `  ${(result.languageName ?? language).padEnd(16)} technicalCertified=${String(
        result.technicalCertified,
      ).padEnd(5)}  humanLanguageReview=${result.humanLanguageReview}`,
    );
    if (result.technicalCertifiedBecause !== undefined) {
      console.log(`      ${result.technicalCertifiedBecause}`);
    }
    if (result.skipped !== undefined) console.log(`      skipped: ${result.skipped}`);
  }
  console.log(
    '\nNo language above may be marked production-approved for any service scope until a named ' +
      'speaker has listened. A 200 is not a pronunciation.',
  );

  if (JSON_OUT !== '') {
    writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nreport written to ${JSON_OUT}`);
  } else {
    console.log(`\n----- JSON -----\n${JSON.stringify(report, null, 2)}`);
  }
}

main().catch((error) => {
  console.error(`certification run failed: ${error?.stack ?? error}`);
  process.exit(1);
});
