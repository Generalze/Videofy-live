/**
 * Which TTS provider should serve a live call.
 *
 * Runs the SAME sentences through each adapter and records what a listener
 * actually experiences -- time to the first audible chunk -- plus the numbers a
 * bill is computed from. It answers latency and cost. It does NOT answer
 * quality, which needs a person to listen, and this prints nothing that
 * pretends otherwise.
 *
 * Every figure is per-run and small-sample. The registry's own discipline
 * applies: a handful of runs is an observation, not a latency distribution, and
 * must not be quoted as representative or used to certify anybody.
 */
import { AzureStreamingSynthesisProvider } from '../dist/services/media-ingest/src/providers/azure/streaming-tts.js';
import { ElevenLabsStreamingSynthesisProvider } from '../dist/services/media-ingest/src/providers/elevenlabs/tts.js';

/** Sentences of the length a translated call actually produces. */
const SENTENCES = [
  'Good morning, thank you for taking my call today.',
  'We can ship the first container before the end of the month if the payment clears this week.',
  'Could you repeat that? I did not catch the last part.',
  'The price you quoted is higher than we discussed, so I would like to understand what changed.',
  'Let us agree the terms now and put the details in writing afterwards.',
];

const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const LANGUAGE = process.env.BENCH_LANGUAGE ?? 'es';

/**
 * Empty is absent.
 *
 * `?? default` does NOT catch an empty string, and an env file that declares a
 * key with no value produces exactly that. The service already normalises this
 * way in `optional()`; this benchmark did not, sent an empty model id, and got
 * a 400 that blamed the voice.
 */
function present(value) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function buildProviders() {
  const built = [];

  const elevenKey = present(process.env.ELEVENLABS_API_KEY);
  const elevenVoice = present(process.env.ELEVENLABS_DEFAULT_VOICE_ID);
  if (elevenKey && elevenVoice) {
    built.push(
      new ElevenLabsStreamingSynthesisProvider({
        apiKey: elevenKey,
        modelId: present(process.env.ELEVENLABS_MODEL) ?? 'eleven_flash_v2_5',
        voiceIds: {},
        defaultVoiceId: elevenVoice,
      }),
    );
  }

  const azureKey = present(process.env.AZURE_SPEECH_KEY);
  const azureRegion = present(process.env.AZURE_SPEECH_REGION);
  if (azureKey && azureRegion) {
    built.push(
      new AzureStreamingSynthesisProvider({
        apiKey: azureKey,
        region: azureRegion,
        voiceIds: {},
        defaultVoiceId: present(process.env.AZURE_DEFAULT_VOICE_ID) ?? 'es-ES-ElviraNeural',
      }),
    );
  } else {
    console.log('Azure: no credentials configured on this box -- skipped, not failed.');
  }

  return built;
}

async function measure(provider, text) {
  const started = Date.now();
  let samples = 0;
  let firstChunkAt = null;
  let error = null;

  const result = await provider
    .synthesize({
      text,
      targetLanguage: LANGUAGE,
      voiceId: 'voice_default',
      onChunk: (chunk) => {
        if (firstChunkAt === null) firstChunkAt = Date.now() - started;
        samples += chunk.samples.length;
      },
      onError: (err) => {
        error = err;
      },
    })
    .catch((err) => {
      error = err;
      return null;
    });

  return {
    ok: error === null && samples > 0,
    error: error ? String(error.message ?? error) : null,
    characters: text.length,
    samples,
    // 16 kHz mono is the engine format, so samples convert directly to seconds.
    audioSeconds: samples / 16000,
    timeToFirstChunkMs: result?.timeToFirstChunkMs ?? firstChunkAt,
    totalMs: result?.totalMs ?? Date.now() - started,
  };
}

function summarise(name, runs) {
  const ok = runs.filter((run) => run.ok);
  if (ok.length === 0) {
    return { name, ok: 0, failed: runs.length, note: runs[0]?.error ?? 'no successful run' };
  }
  const firsts = ok.map((run) => run.timeToFirstChunkMs).filter((value) => value !== null).sort((a, b) => a - b);
  const characters = ok.reduce((total, run) => total + run.characters, 0);
  const audioSeconds = ok.reduce((total, run) => total + run.audioSeconds, 0);

  return {
    name,
    ok: ok.length,
    failed: runs.length - ok.length,
    /* Median, not mean: one cold start should not describe the steady state. */
    medianFirstChunkMs: firsts[Math.floor(firsts.length / 2)] ?? null,
    worstFirstChunkMs: firsts[firsts.length - 1] ?? null,
    characters,
    audioSeconds: Number(audioSeconds.toFixed(2)),
    /* The ratio a bill is computed from, and the one that scales with usage. */
    charactersPerAudioMinute: Math.round((characters / audioSeconds) * 60),
  };
}

const providers = buildProviders();
if (providers.length === 0) {
  console.log('No TTS credentials present in this environment. Nothing to measure.');
  process.exit(1);
}

console.log(`language=${LANGUAGE} runs=${RUNS} sentences=${SENTENCES.length}`);
console.log('');

for (const provider of providers) {
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) {
    for (const sentence of SENTENCES) {
      runs.push(await measure(provider, sentence));
    }
  }
  console.log(JSON.stringify(summarise(provider.name, runs), null, 2));
  console.log('');
}
