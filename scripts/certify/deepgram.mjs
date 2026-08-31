#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Measure Deepgram LIVE transcription the way production actually invokes it.
 *
 * WHAT THIS IS FOR. A status code is not evidence. A 101 on the Deepgram
 * WebSocket says a credential authenticated; it says nothing about whether the
 * words that came back are the words that were said. This harness therefore
 * speaks a KNOWN sentence at the recogniser, in real time, through the same
 * adapter the service uses, and compares what comes back to what went in.
 *
 * WHY IT DRIVES THE DEPLOYED ADAPTER RATHER THAN THE VENDOR SDK. A benchmark
 * that opens its own socket certifies the vendor. It does not certify THIS
 * PLATFORM, whose behaviour also depends on the adapter's cumulative-text
 * normalisation, its Finalize-on-discontinuity, its parameter set (linear16 /
 * 16000 / mono / interim_results / punctuate) and its model-family guard. So
 * the provider is built by `buildStreamingTranscriptionProvider` -- the exact
 * function `live-provider-wiring` calls at boot -- against the DEPLOYED dist,
 * and audio is pushed frame by frame through `StreamingTranscriptionSession`
 * exactly as `LiveStreamPipeline.onAudio` pushes it.
 *
 * WHY IT PACES AUDIO IN REAL TIME. Pushing a whole file at once measures how
 * fast a server can chew a buffer. Live translation cares about the interval
 * between a speaker finishing and the transcript existing, and that interval
 * only means anything if the audio arrived at the speed speech arrives. Frames
 * are 20 ms, which is what the realtime ingress carries.
 *
 * WHAT IT REFUSES TO CONCLUDE.
 *   - Evidence is recorded per MODEL. Nova-3 numbers are never reported for
 *     Flux; they are different products on different protocols (v1 vs v2).
 *   - Evidence is recorded per LANGUAGE. An English success rate says nothing
 *     about Spanish and nothing at all about Yoruba.
 *   - Evidence is recorded per DIRECTION-FREE recogniser input only. This is
 *     speech-to-text; it certifies no translation route.
 *   - TTS-GENERATED SPEECH IS NOT A HUMAN SPEAKER. It is clean, evenly paced,
 *     free of crosstalk, and it never coughs. Every number here is therefore
 *     an UPPER BOUND on what a real caller would get, and the evidence file
 *     says so in the same breath as the number.
 *
 * CREDENTIALS. Read from the environment, held in a variable, never printed,
 * never written to the evidence file, never passed on a command line. Run it
 * on the box as:
 *
 *   sudo node --env-file=/etc/videofy/media-ingest.env \
 *     scripts/certify/deepgram.mjs --out /tmp/evidence.json
 *
 * so the values never reach `argv` and never appear in `ps`. Node's own
 * env-file parser is used rather than `. file` in a shell for a second reason
 * this run discovered: the staging env file contains a stray line that bash
 * tries to EXECUTE, and a measurement harness should not be the thing that
 * runs whatever a configuration file happens to contain.
 *
 * USAGE
 *   node scripts/certify/deepgram.mjs [options]
 *     --dist <dir>       deployed media-ingest dist src dir (default:
 *                        /srv/videofy/app/services/media-ingest/dist/services/media-ingest/src)
 *     --model <id>       Deepgram model id (default: $DEEPGRAM_MODEL or nova-3)
 *     --languages <csv>  platform language codes to measure (default: en)
 *     --samples <n>      max samples per language (default: all defined)
 *     --fixtures <dir>   PCM cache directory (default: ./.deepgram-evidence)
 *     --tts-locale <csv>  override the synthesis locale, e.g. `en=en-NG`, to
 *                        measure an ACCENT as its own record
 *     --language-support <csv>  open a stream per platform language code and
 *                        record which ones the model will even accept
 *     --out <file>       write the machine-readable JSON block here
 *     --skip-probes      skip the failure-behaviour probes
 *     --probes-only      run only the failure-behaviour probes
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const SAMPLE_RATE = 16000;
/** 20 ms at 16 kHz. What the realtime ingress carries, so what is sent here. */
const FRAME_SAMPLES = 320;
/** Similarity at or above this counts the transcript as MEANINGFUL. */
const MEANINGFUL_WORD_SIMILARITY = 0.7;

/* ------------------------------------------------------------------ *
 * Reference speech. Short, ordinary, and deliberately varied: a clean
 * declarative is the easiest thing a recogniser ever hears, and a set made
 * only of those would certify nothing but the easy case.
 * ------------------------------------------------------------------ */
const REFERENCE_TEXTS = {
  en: [
    'Good morning everyone, thank you for joining the call today.',
    'Can you hear me clearly, or should I move closer to the microphone?',
    'The delivery is scheduled for Thursday afternoon and the driver will call ahead.',
    'I disagree with that approach, and I would like to explain why before we vote.',
    'Please send the invoice to the accounts team and copy me on the message.',
    'She asked whether the payment had cleared, and nobody in the room knew.',
    'We are going to start the broadcast in about ten minutes, so take your seats.',
    'It was raining so heavily that the match had to be abandoned at half time.',
    'My name is Adebayo and I work in the logistics department in Lagos.',
    'If the connection drops again, call me back on the other number.',
    'The report says revenue grew, but the margin fell for the third quarter running.',
    'Sorry, could you repeat the last part? I think the line broke up.',
  ],
  es: [
    'Buenos dias a todos, gracias por acompanarnos en la llamada de hoy.',
    'Me escuchas bien, o prefieres que me acerque mas al microfono?',
    'La entrega esta programada para el jueves por la tarde.',
    'No estoy de acuerdo con esa propuesta y quiero explicar por que.',
    'Por favor envia la factura al equipo de contabilidad y ponme en copia.',
    'Vamos a empezar la transmision en unos diez minutos, tomen asiento.',
    'Llovia tanto que tuvieron que suspender el partido en el descanso.',
    'Si la conexion se corta otra vez, llamame al otro numero.',
  ],
  yo: [
    'E kaaro o, e sedupe fun wiwa si ipade yii loni.',
    'Se o gbo mi daadaa, tabi ki n sunmo maiki naa?',
    'A o bere igbohunsafefe naa ni bii iseju mewa.',
    'Oruko mi ni Adebayo, mo n sise ni eka gbigbe eru ni Eko.',
  ],
};

/** Azure locale to synthesise each platform language with. */
const TTS_LOCALE = { en: 'en-US', es: 'es-ES', yo: 'yo-NG' };

/*
 * ACCENT IS A SEPARATE MEASUREMENT, which is why the locale is overridable.
 *
 * `en-US` certifies American-accented English and nothing else. The people who
 * will actually speak into this platform are largely Nigerian, and a recogniser
 * that hears `en-US` perfectly and `en-NG` poorly would pass a certification
 * run that never asked. `--tts-locale en=en-NG` asks, and the resulting record
 * is kept as its own row rather than averaged into the en-US one.
 */


/* ------------------------------------------------------------------ *
 * Text comparison. A non-empty string is not evidence; a string that
 * resembles what was said is.
 * ------------------------------------------------------------------ */

/**
 * Fold away everything a recogniser is allowed to differ on.
 *
 * Punctuation and case are formatting choices, not hearing. Accents are
 * folded because the reference texts are written without them (the SSML is
 * plain ASCII so it survives every transport between here and the box) while
 * the recogniser will emit them, and counting that as an error would blame the
 * vendor for the harness's own limitation. Digits are NOT normalised: no
 * reference sentence contains one, deliberately, because "10" versus "ten" is
 * a formatting argument that would swamp a small sample.
 */
export function normalizeForComparison(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Word error rate and the two similarities the evidence table reports. */
export function compareTranscript(reference, hypothesis) {
  const referenceWords = normalizeForComparison(reference).split(' ').filter(Boolean);
  const hypothesisWords = normalizeForComparison(hypothesis).split(' ').filter(Boolean);
  const wordDistance = levenshtein(referenceWords, hypothesisWords);
  const wordErrorRate =
    referenceWords.length === 0 ? (hypothesisWords.length === 0 ? 0 : 1) : wordDistance / referenceWords.length;
  const referenceChars = normalizeForComparison(reference);
  const hypothesisChars = normalizeForComparison(hypothesis);
  const charDistance = levenshtein([...referenceChars], [...hypothesisChars]);
  const charSimilarity =
    Math.max(referenceChars.length, hypothesisChars.length) === 0
      ? 1
      : 1 - charDistance / Math.max(referenceChars.length, hypothesisChars.length);
  return {
    referenceWordCount: referenceWords.length,
    hypothesisWordCount: hypothesisWords.length,
    wordErrorRate: round(wordErrorRate, 4),
    wordSimilarity: round(Math.max(0, 1 - wordErrorRate), 4),
    charSimilarity: round(Math.max(0, charSimilarity), 4),
  };
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------------------ *
 * Fixtures. Real speech, synthesised, cached on disk so a re-run of the
 * measurement does not re-run the synthesis -- and so the exact bytes that
 * produced a number can be listened to afterwards.
 * ------------------------------------------------------------------ */

async function azureVoiceCatalogue(region, speechKey) {
  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    { headers: { 'Ocp-Apim-Subscription-Key': speechKey } },
  );
  if (!response.ok) {
    throw new Error(`Azure voice list refused: HTTP ${response.status}`);
  }
  return await response.json();
}

/**
 * A voice this REGION will actually serve.
 *
 * Chosen from the region's own list rather than from documentation, because
 * the portal advertises voices a given region rejects with a bodyless 400 --
 * the trap this repository has already paid for once.
 */
function pickVoice(catalogue, locale) {
  const exact = catalogue.filter((voice) => voice.Locale === locale);
  const family = catalogue.filter((voice) => voice.Locale.split('-')[0] === locale.split('-')[0]);
  const pool = exact.length > 0 ? exact : family;
  const neural = pool.filter((voice) => (voice.VoiceType ?? '').includes('Neural'));
  const chosen = (neural.length > 0 ? neural : pool)[0];
  return chosen === undefined ? null : chosen.ShortName;
}

function ssmlFor(locale, voiceName, text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<speak version="1.0" xml:lang="${locale}">` +
    `<voice xml:lang="${locale}" name="${voiceName}">${escaped}</voice>` +
    `</speak>`
  );
}

/**
 * Synthesise one sentence to raw 16 kHz mono PCM16.
 *
 * `raw-16khz-16bit-mono-pcm` is asked for so nothing in this harness resamples
 * anything. A resampler between the fixture and the recogniser would be a
 * second thing under test, and a quiet way to blame the vendor for our own
 * aliasing.
 */
async function synthesize(region, speechKey, locale, voiceName, text) {
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': speechKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'raw-16khz-16bit-mono-pcm',
      'User-Agent': 'videofy-deepgram-certification',
    },
    body: ssmlFor(locale, voiceName, text),
  });
  if (!response.ok) {
    throw new Error(`Azure synthesis refused: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < SAMPLE_RATE) {
    throw new Error(`Azure returned ${bytes.length} bytes; too short to be speech`);
  }
  return bytes;
}

function pcmFromBytes(bytes) {
  const samples = new Int16Array(bytes.length >> 1);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2);
  }
  return samples;
}

/**
 * Where the speech ACOUSTICALLY starts and stops inside a fixture.
 *
 * This is not a nicety. The first run of this harness quoted a finalisation
 * latency of MINUS 61 ms, which is not a latency at all -- it is the harness
 * measuring from the end of the FILE while the recogniser had endpointed on the
 * end of the VOICE, and a synthesiser leaves a few hundred milliseconds of room
 * tone after the last word. Quoting that number would have credited Deepgram
 * with clairvoyance. Latency is measured from the last voiced sample, found
 * here by RMS over 20 ms windows, so the clock starts where a listener would
 * say the speaker stopped.
 */
function voicedBounds(samples, threshold = 300) {
  const window = FRAME_SAMPLES;
  let first = null;
  let last = null;
  for (let offset = 0; offset + window <= samples.length; offset += window) {
    let energy = 0;
    for (let index = offset; index < offset + window; index += 1) {
      energy += samples[index] * samples[index];
    }
    if (Math.sqrt(energy / window) >= threshold) {
      if (first === null) first = offset;
      last = offset + window;
    }
  }
  return { first: first ?? 0, last: last ?? samples.length };
}

/** Leading and trailing silence, so endpointing has something to endpoint on. */
function padWithSilence(samples, leadMs, trailMs) {
  const lead = Math.round((leadMs / 1000) * SAMPLE_RATE);
  const trail = Math.round((trailMs / 1000) * SAMPLE_RATE);
  const padded = new Int16Array(lead + samples.length + trail);
  padded.set(samples, lead);
  const voiced = voicedBounds(samples);
  return {
    audio: padded,
    speechStartSample: lead + voiced.first,
    speechEndSample: lead + voiced.last,
    voicedMs: Math.round(((voiced.last - voiced.first) / SAMPLE_RATE) * 1000),
  };
}

async function buildFixtures(options, state) {
  const { region, speechKey } = state;
  const catalogue = await azureVoiceCatalogue(region, speechKey);
  mkdirSync(options.fixtures, { recursive: true });
  const fixtures = [];
  const voices = {};
  for (const language of options.languages) {
    const locale = options.ttsLocale[language] ?? TTS_LOCALE[language];
    const voiceName = locale === undefined ? null : pickVoice(catalogue, locale);
    voices[language] = voiceName;
    if (voiceName === null) {
      process.stderr.write(
        `fixtures: no ${locale ?? language} voice in this Azure region; ${language} left unmeasured\n`,
      );
      continue;
    }
    const texts = (REFERENCE_TEXTS[language] ?? []).slice(0, options.samples);
    for (const [index, text] of texts.entries()) {
      const id = `${language}-${String(index + 1).padStart(2, '0')}`;
      const digest = createHash('sha256').update(`${voiceName}|${text}`).digest('hex').slice(0, 12);
      const path = join(options.fixtures, `${id}-${digest}.pcm`);
      if (!existsSync(path)) {
        const bytes = await synthesize(region, speechKey, locale, voiceName, text);
        writeFileSync(path, bytes);
        process.stderr.write(`fixtures: synthesised ${id} (${bytes.length} bytes)\n`);
      }
      const samples = pcmFromBytes(readFileSync(path));
      fixtures.push({
        id,
        language,
        text,
        voiceName,
        path,
        samples,
        durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      });
    }
  }
  return { fixtures, voices };
}

/* ------------------------------------------------------------------ *
 * The measurement itself.
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the recogniser through the SERVICE's own selector.
 *
 * `buildStreamingTranscriptionProvider` is what `live-provider-wiring` calls
 * at boot. Going through it means the model-family guard, the default model,
 * the transport factory and the parameter set under test are the deployed
 * ones, not a second implementation that agrees with them today.
 */
async function loadProviderFactory(distDir) {
  const wiring = await import(`file://${join(distDir, 'live-provider-wiring.js')}`);
  return (model, transcriptionKey) => {
    const provider = model.startsWith('flux') ? 'deepgram-flux' : 'deepgram-nova';
    return {
      provider: wiring.buildStreamingTranscriptionProvider(
        { streamingTranscriptionProvider: provider },
        { deepgramApiKey: transcriptionKey, deepgramModel: model },
      ),
      executionPath: provider,
    };
  };
}

/**
 * One sample, start to finish, timed.
 *
 * The clock the numbers are quoted against is `speechEndAt`: the wall-clock
 * moment the last sample of actual SPEECH was handed to the adapter. That is
 * the moment a listener stops hearing the speaker, and every millisecond after
 * it is a millisecond of silence somebody is sitting through.
 */
async function measureSample({ provider, fixture, sourceLanguage, isFlux }) {
  const signals = [];
  const errors = [];
  let disconnected = null;
  const started = performance.now();
  let session = null;
  try {
    session = await provider.openStream({
      sessionId: `certify-${fixture.id}`,
      streamId: `certify-${fixture.id}`,
      ...(sourceLanguage === undefined ? {} : { sourceLanguage, sourceLanguageMode: 'manual' }),
      requestEndpointing: true,
      onSignal: (signal) => signals.push({ ...signal, at: performance.now() }),
      onError: (error) => errors.push(error.message),
      onDisconnected: (reason) => {
        disconnected = reason;
      },
    });
  } catch (error) {
    return {
      opened: false,
      connectMs: round(performance.now() - started),
      failure: error instanceof Error ? error.message : String(error),
      errors,
    };
  }
  const connectMs = performance.now() - started;

  const { audio, speechStartSample, speechEndSample, voicedMs } = padWithSilence(
    fixture.samples,
    400,
    1200,
  );
  const pushStart = performance.now();
  let speechStartAt = null;
  let speechEndAt = null;
  for (let offset = 0, frame = 0; offset < audio.length; offset += FRAME_SAMPLES, frame += 1) {
    const target = pushStart + frame * 20;
    const wait = target - performance.now();
    if (wait > 1) await sleep(wait);
    if (speechStartAt === null && offset >= speechStartSample) speechStartAt = performance.now();
    if (speechEndAt === null && offset >= speechEndSample) speechEndAt = performance.now();
    await session.pushAudio({
      samples: audio.subarray(offset, Math.min(offset + FRAME_SAMPLES, audio.length)),
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
      platformTimestampMs: frame * 20,
    });
  }
  if (speechStartAt === null) speechStartAt = pushStart;
  if (speechEndAt === null) speechEndAt = performance.now();

  // Wait for the recogniser to decide the turn ended ON ITS OWN first: that is
  // what happens on a live call, where nobody presses a button. Only when it
  // does not is the pipeline's flush (`finish`) used, and which of the two
  // produced the final is recorded rather than averaged away.
  const naturalWaitMs = isFlux ? 9000 : 3500;
  const hasFinal = () => signals.some((signal) => signal.kind === 'final');
  const deadline = performance.now() + naturalWaitMs;
  while (!hasFinal() && performance.now() < deadline && disconnected === null) await sleep(50);
  let finalPath = hasFinal() ? 'natural-endpoint' : null;
  if (!hasFinal()) {
    await session.finish();
    const flushDeadline = performance.now() + 4000;
    while (!hasFinal() && performance.now() < flushDeadline && disconnected === null) await sleep(50);
    if (hasFinal()) finalPath = 'flush';
  }
  await session.close('certification complete');

  const finals = signals.filter((signal) => signal.kind === 'final');
  const partials = signals.filter((signal) => signal.kind === 'partial' && signal.text !== '');
  const endpoints = signals.filter((signal) => signal.kind === 'endpoint');
  const transcript = finals.map((signal) => signal.text).join(' ').trim();
  const bestEffort = transcript !== '' ? transcript : (partials.at(-1)?.text ?? '');
  return {
    opened: true,
    connectMs: round(connectMs),
    audioMs: fixture.durationMs,
    finalCount: finals.length,
    partialCount: partials.length,
    endpointCount: endpoints.length,
    finalPath,
    voicedMs,
    firstPartialFromSpeechStartMs:
      partials.length === 0 ? null : round(partials[0].at - speechStartAt),
    finalFromSpeechEndMs: finals.length === 0 ? null : round(finals.at(-1).at - speechEndAt),
    transcript,
    bestEffortTranscript: bestEffort,
    confidence: finals.at(-1)?.confidence ?? null,
    disconnected,
    errors,
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    min: round(sorted[0]),
    median: round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: round(sorted.at(-1)),
  };
}

/* ------------------------------------------------------------------ *
 * Failure behaviour. How a thing breaks is part of what it is.
 * ------------------------------------------------------------------ */

function silence(ms) {
  return new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE));
}

/**
 * Broadband noise at speech-ish level.
 *
 * The question this answers is the one that matters most: does the recogniser
 * INVENT words when handed something that is not speech? A fabricated caption
 * is worse than a missing one, because it is confident and someone will act on
 * it.
 */
function noise(ms, amplitude = 4000) {
  const samples = new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round((Math.random() * 2 - 1) * amplitude);
  }
  return samples;
}

/**
 * Which of the PLATFORM's own language codes can even open a live stream.
 *
 * This is the cheapest and most decision-relevant question there is, and it is
 * asked separately from accuracy because the two failures are nothing alike. A
 * model that mishears Yoruba produces a bad caption; a model that REFUSES
 * Yoruba produces no session at all -- `LiveStreamPipeline.open` awaits
 * `openStream`, so a refusal here is a call that does not start. One is a
 * quality problem, the other is an outage, and a registry that recorded them
 * with the same word would mislead whoever reads it next.
 *
 * The codes probed are the platform's own supported list, so the answer maps
 * onto the routes the product actually offers.
 */
async function probeLanguageSupport({ factory, model, transcriptionKey, codes }) {
  const rows = [];
  for (const code of codes) {
    const { provider } = factory(model, transcriptionKey);
    let session = null;
    let refusal = null;
    try {
      session = await provider.openStream({
        sessionId: `certify-lang-${code}`,
        streamId: `certify-lang-${code}`,
        sourceLanguage: code,
        sourceLanguageMode: 'manual',
        requestEndpointing: true,
        onSignal: () => {},
        onError: () => {},
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (session !== null) await session.close('language support probe');
    rows.push({ language: code, opens: refusal === null, refusal });
  }
  return rows;
}

async function runProbes({ factory, model, transcriptionKey, speechFixture }) {
  const probes = [];

  // 1. A key that is not a key. Shaped like one so the failure is the SERVICE's
  //    rejection rather than a client-side format check.
  const rejectedKey = randomBytes(20).toString('hex');
  {
    const { provider } = factory(model, rejectedKey);
    const outcome = await measureSample({
      provider,
      fixture: { id: 'probe-bad-key', samples: silence(500), durationMs: 500 },
      sourceLanguage: 'en',
      isFlux: model.startsWith('flux'),
    });
    probes.push({
      probe: 'invalid-credential',
      expectation: 'connection refused before any audio is accepted',
      opened: outcome.opened,
      observed: outcome.opened ? 'stream opened' : outcome.failure,
      latencyMs: outcome.connectMs,
      verdict: outcome.opened ? 'FAILS CLOSED? no -- stream opened' : 'fails closed',
    });
  }

  // 2. A language the model does not serve.
  {
    const { provider } = factory(model, transcriptionKey);
    const outcome = await measureSample({
      provider,
      fixture: speechFixture,
      sourceLanguage: 'yo',
      isFlux: model.startsWith('flux'),
    });
    probes.push({
      probe: 'unsupported-language',
      expectation: 'refused, or transcribed in a language nobody asked for',
      requestedLanguage: 'yo',
      audioLanguage: speechFixture.language ?? 'unknown',
      opened: outcome.opened,
      observed: outcome.opened
        ? `opened; finals=${outcome.finalCount}; transcript=${JSON.stringify(outcome.bestEffortTranscript.slice(0, 120))}`
        : outcome.failure,
      errors: outcome.errors,
      latencyMs: outcome.connectMs,
    });
  }

  // 3. Digital silence.
  {
    const { provider } = factory(model, transcriptionKey);
    const outcome = await measureSample({
      provider,
      fixture: { id: 'probe-silence', samples: silence(4000), durationMs: 4000, language: 'en' },
      sourceLanguage: 'en',
      isFlux: model.startsWith('flux'),
    });
    probes.push({
      probe: 'digital-silence',
      expectation: 'no words',
      opened: outcome.opened,
      transcript: outcome.bestEffortTranscript,
      inventedWords: outcome.bestEffortTranscript.trim() !== '',
      finalCount: outcome.finalCount ?? 0,
    });
  }

  // 4. Broadband noise.
  {
    const { provider } = factory(model, transcriptionKey);
    const outcome = await measureSample({
      provider,
      fixture: { id: 'probe-noise', samples: noise(4000), durationMs: 4000, language: 'en' },
      sourceLanguage: 'en',
      isFlux: model.startsWith('flux'),
    });
    probes.push({
      probe: 'broadband-noise',
      expectation: 'no words',
      opened: outcome.opened,
      transcript: outcome.bestEffortTranscript,
      inventedWords: outcome.bestEffortTranscript.trim() !== '',
      finalCount: outcome.finalCount ?? 0,
    });
  }

  return probes;
}

/* ------------------------------------------------------------------ *
 * Entry point.
 * ------------------------------------------------------------------ */

function parseArguments(argv) {
  const options = {
    dist: '/srv/videofy/app/services/media-ingest/dist/services/media-ingest/src',
    model: process.env['DEEPGRAM_MODEL'] ?? 'nova-3',
    languages: ['en'],
    samples: Number.POSITIVE_INFINITY,
    fixtures: '.deepgram-evidence',
    ttsLocale: {},
    languageSupport: [],
    out: null,
    skipProbes: false,
    probesOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dist') options.dist = value;
    else if (flag === '--model') options.model = value;
    else if (flag === '--languages') options.languages = value.split(',').map((part) => part.trim());
    else if (flag === '--samples') options.samples = Number(value);
    else if (flag === '--fixtures') options.fixtures = value;
    else if (flag === '--language-support') {
      options.languageSupport = value.split(',').map((part) => part.trim()).filter(Boolean);
    }
    else if (flag === '--tts-locale') {
      for (const pair of value.split(',')) {
        const [language, locale] = pair.split('=');
        if (language !== undefined && locale !== undefined) options.ttsLocale[language.trim()] = locale.trim();
      }
    }
    else if (flag === '--out') options.out = value;
    else if (flag === '--skip-probes') { options.skipProbes = true; continue; }
    else if (flag === '--probes-only') { options.probesOnly = true; continue; }
    else continue;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const transcriptionKey = process.env['DEEPGRAM_API_KEY'];
  const speechKey = process.env['AZURE_SPEECH_KEY'];
  const region = process.env['AZURE_SPEECH_REGION'];
  const missing = [
    transcriptionKey ? null : 'DEEPGRAM_API_KEY',
    speechKey ? null : 'AZURE_SPEECH_KEY',
    region ? null : 'AZURE_SPEECH_REGION',
  ].filter(Boolean);
  if (missing.length > 0) {
    // NAMES only, and that is the whole point of naming them.
    process.stderr.write(`not set: ${missing.join(', ')}\n`);
    process.exit(2);
  }

  const factory = await loadProviderFactory(options.dist);
  const isFlux = options.model.startsWith('flux');
  const { fixtures, voices } = await buildFixtures(options, { region, speechKey });

  const results = [];
  if (!options.probesOnly) {
    for (const fixture of fixtures) {
      const { provider, executionPath } = factory(options.model, transcriptionKey);
      const outcome = await measureSample({
        provider,
        fixture,
        sourceLanguage: fixture.language,
        isFlux,
      });
      const comparison = outcome.opened
        ? compareTranscript(fixture.text, outcome.bestEffortTranscript)
        : null;
      const meaningful =
        comparison !== null && comparison.wordSimilarity >= MEANINGFUL_WORD_SIMILARITY;
      results.push({
        id: fixture.id,
        language: fixture.language,
        model: options.model,
        adapter: provider.name,
        executionPath,
        voiceName: fixture.voiceName,
        reference: fixture.text,
        ...outcome,
        comparison,
        meaningful,
      });
      process.stderr.write(
        `${fixture.id} ${fixture.language} opened=${outcome.opened} ` +
          `final=${outcome.finalCount ?? 0} sim=${comparison?.wordSimilarity ?? 'n/a'} ` +
          `latency=${outcome.finalFromSpeechEndMs ?? 'n/a'}ms\n`,
      );
    }
  }

  const byLanguage = {};
  for (const language of new Set(results.map((result) => result.language))) {
    const rows = results.filter((result) => result.language === language);
    const meaningfulRows = rows.filter((row) => row.meaningful);
    byLanguage[language] = {
      language,
      model: options.model,
      executionMode: 'streaming',
      sampleCount: rows.length,
      openedCount: rows.filter((row) => row.opened).length,
      finalCount: rows.filter((row) => (row.finalCount ?? 0) > 0).length,
      meaningfulCount: meaningfulRows.length,
      successRate: rows.length === 0 ? 0 : round(meaningfulRows.length / rows.length, 4),
      meanWordErrorRate:
        rows.length === 0
          ? null
          : round(
              rows.reduce((sum, row) => sum + (row.comparison?.wordErrorRate ?? 1), 0) / rows.length,
              4,
            ),
      finalFromSpeechEndMs: distribution(
        rows.map((row) => row.finalFromSpeechEndMs).filter((value) => typeof value === 'number'),
      ),
      firstPartialMs: distribution(
        rows
          .map((row) => row.firstPartialFromSpeechStartMs)
          .filter((value) => typeof value === 'number'),
      ),
      connectMs: distribution(rows.map((row) => row.connectMs).filter((value) => typeof value === 'number')),
    };
  }

  const languageSupport = options.languageSupport.length === 0
    ? []
    : await probeLanguageSupport({
        factory,
        model: options.model,
        transcriptionKey,
        codes: options.languageSupport,
      });
  for (const row of languageSupport) {
    process.stderr.write(`language-support ${row.language}: ${row.opens ? 'opens' : row.refusal}
`);
  }

  let probes = [];
  if (!options.skipProbes) {
    const speechFixture = fixtures.find((fixture) => fixture.language === 'en') ?? fixtures[0];
    if (speechFixture !== undefined) {
      probes = await runProbes({
        factory,
        model: options.model,
        transcriptionKey,
        speechFixture,
      });
    }
  }

  const report = {
    tool: 'scripts/certify/deepgram.mjs',
    recordedAt: new Date().toISOString(),
    model: options.model,
    executionMode: 'streaming',
    protocol: isFlux ? 'deepgram-listen-v2' : 'deepgram-listen-v1',
    adapterUnderTest: options.dist,
    frameMs: 20,
    sampleRate: SAMPLE_RATE,
    speechSource: 'azure-tts',
    speechSourceCaveat:
      'TTS-generated speech, not human speakers: clean, evenly paced, no crosstalk or disfluency. ' +
      'Every number is an upper bound on live human performance.',
    ttsVoices: voices,
    meaningfulThreshold: MEANINGFUL_WORD_SIMILARITY,
    byLanguage,
    samples: results.map(({ samples: _ignored, ...rest }) => rest),
    languageSupport,
    failureProbes: probes,
  };

  const json = JSON.stringify(report, null, 2);
  if (options.out !== null) writeFileSync(options.out, json);
  process.stdout.write(json + '\n');
}

/*
 * Guarded so the comparison helpers above can be imported and exercised
 * without the import itself reaching for a credential and opening a socket.
 */
const invokedDirectly = process.argv[1] !== undefined && /deepgram\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
