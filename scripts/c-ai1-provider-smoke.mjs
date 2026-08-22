#!/usr/bin/env node
/** @author masterzee001 */
/**
 * C-AI1 direct provider smoke tests.
 *
 * WHAT THIS IS: proof that OUR EXACT REQUESTS work against the real services.
 * Documentation says a vendor permits something; this says our adapter asks for
 * it correctly. Those are different claims, and the second is the one that
 * fails at 3am.
 *
 * WHAT THIS IS NOT: certification. It cannot move a provider past `testing`.
 * Certification needs latency distributions, accuracy against references, cost
 * per minute and error rates under load, per language route and per service
 * category. That is C-AI1.2 and a different exercise entirely.
 *
 * TWO DEFECTS FIXED HERE, both of which would have let this harness lie:
 *
 *   1. The streaming checks used to report PASS when the socket merely OPENED,
 *      even if no `Results` or `TurnInfo` ever arrived. That proves
 *      authentication and query acceptance -- worth knowing -- and proves
 *      nothing at all about the protocol path. CONNECTION and PROTOCOL are now
 *      reported as separate claims, and a socket that opens and then says
 *      nothing is a protocol FAIL.
 *
 *   2. The Google check demanded `GOOGLE_APPLICATION_CREDENTIALS`, which is one
 *      ADC source among several. The adapter deliberately takes an injected
 *      token so it works with `gcloud auth application-default login`, a
 *      metadata server, or workload identity; requiring a JSON key file here
 *      would have quietly undone that abstraction from the test side.
 *
 * SPEECH, NOT A SINE TONE. A recogniser given a 220 Hz tone correctly returns
 * nothing, so the old fixture could not distinguish "the protocol works and
 * there were no words" from "the protocol is broken". The fixture is real
 * English speech, synthesised at run time by the local Piper that already
 * serves as the development TTS baseline -- so nothing has to be committed, and
 * WAV/evidence files stay out of the repository as required.
 *
 * Run:  npm run c-ai1:smoke
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const work = mkdtempSync(join(tmpdir(), 'c-ai1-smoke-'));

/**
 * Load the repository `.env` without overriding the real environment.
 *
 * This is how credentials reach the script: the same file the services already
 * read. Values are never printed -- only whether a NAME is set.
 */
function loadDotEnv() {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // A real environment variable always wins over the file.
    if (process.env[name] === undefined || process.env[name] === '') {
      process.env[name] = value;
    }
  }
}
loadDotEnv();

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`  ${status}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const env = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const SPEECH = 'Good morning. This is a Videofy provider test. Please transcribe this sentence.';

// --- audio helpers ---------------------------------------------------------

function pcmToBytes(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i], i * 2);
  return out;
}

function wav(samples, rate = 16000) {
  const data = pcmToBytes(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Linear resample. Adequate for a smoke fixture; not an audio-quality claim. */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[i] = Math.round(samples[left] * (1 - weight) + samples[right] * weight);
  }
  return out;
}

function readRawPcm(path) {
  const buffer = readFileSync(path);
  const samples = new Int16Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2);
  return samples;
}

function readWavPcm16(path) {
  const buffer = readFileSync(path);
  // Minimal parse: find `data`, read the rate from the fmt chunk.
  const dataIndex = buffer.indexOf('data', 12, 'ascii');
  if (dataIndex < 0) throw new Error('no data chunk');
  const rate = buffer.readUInt32LE(24);
  const start = dataIndex + 8;
  const length = buffer.readUInt32LE(dataIndex + 4);
  const samples = new Int16Array(Math.floor(length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(start + i * 2);
  return { samples, rate };
}

/**
 * Real English speech at 16 kHz mono, or null.
 *
 * Returning null makes the protocol checks SKIP with a stated reason, rather
 * than falling back to a tone and reporting a PASS that means less than it
 * appears to.
 */
function speechFixture() {
  const provided = env('C_AI1_SMOKE_SPEECH_WAV');
  if (provided !== null && existsSync(provided)) {
    try {
      const { samples, rate } = readWavPcm16(provided);
      return { samples: resample(samples, rate, 16000), source: `fixture ${provided}` };
    } catch (error) {
      console.log(`  (could not read C_AI1_SMOKE_SPEECH_WAV: ${String(error).slice(0, 80)})`);
    }
  }

  const piper = env('PIPER_EXECUTABLE');
  const voiceDir = env('C_AI1_SMOKE_PIPER_EN_MODEL');
  const guess = join(
    process.cwd(),
    'services/media-ingest/model_cache/piper/en_US-hfc_male-medium/en_US-hfc_male-medium.onnx',
  );
  const model = voiceDir ?? (existsSync(guess) ? guess : null);
  if (piper === null || !existsSync(piper) || model === null) return null;

  try {
    // `--output-raw` writes headerless PCM to stdout.
    const stdout = execFileSync(piper, ['--model', model, '--output-raw'], {
      input: SPEECH,
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const raw = join(work, 'speech.raw');
    writeFileSync(raw, stdout);
    const at22k = readRawPcm(raw);
    if (at22k.length === 0) return null;
    // Piper voices here are 22.05 kHz; Deepgram is asked for 16 kHz.
    return { samples: resample(at22k, 22050, 16000), source: 'local Piper (en_US-hfc_male-medium)' };
  } catch {
    return null;
  }
}

// --- Deepgram batch --------------------------------------------------------

async function deepgramBatch(speech) {
  const key = env('DEEPGRAM_API_KEY');
  if (key === null) return record('Deepgram Nova-3 batch', 'SKIP', 'DEEPGRAM_API_KEY not set');
  if (speech === null) return record('Deepgram Nova-3 batch', 'SKIP', 'no speech fixture available');
  try {
    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&utterances=true&language=en',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'content-type': 'audio/wav' },
        body: wav(speech.samples),
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok) return record('Deepgram Nova-3 batch', 'FAIL', `HTTP ${response.status}`);
    const body = await response.json();
    const alt = body?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = (alt?.transcript ?? '').trim();
    if (transcript === '') {
      // With real speech in, an empty transcript is a genuine failure rather
      // than the correct answer it would be for a tone.
      return record('Deepgram Nova-3 batch', 'FAIL', 'real speech produced an empty transcript');
    }
    record(
      'Deepgram Nova-3 batch',
      'PASS',
      `transcript ${transcript.length} chars; words[] ${Array.isArray(alt?.words) ? 'present' : 'absent'}`,
    );
  } catch (error) {
    record('Deepgram Nova-3 batch', 'FAIL', String(error).slice(0, 120));
  }
}

// --- Deepgram streaming ----------------------------------------------------

/**
 * Reports TWO results: the connection, and the protocol response.
 *
 * They are different claims and blending them is what let the previous version
 * pass without ever seeing a transcript message.
 */
async function deepgramStreaming({ label, url, expectMessage, speech }) {
  const key = env('DEEPGRAM_API_KEY');
  if (key === null) {
    record(`${label} — connection`, 'SKIP', 'DEEPGRAM_API_KEY not set');
    record(`${label} — ${expectMessage} protocol`, 'SKIP', 'DEEPGRAM_API_KEY not set');
    return;
  }
  let WebSocket;
  try {
    ({ WebSocket } = await import('ws'));
  } catch {
    record(`${label} — connection`, 'SKIP', 'ws not installed');
    record(`${label} — ${expectMessage} protocol`, 'SKIP', 'ws not installed');
    return;
  }
  if (speech === null) {
    record(`${label} — connection`, 'SKIP', 'no speech fixture available');
    record(`${label} — ${expectMessage} protocol`, 'SKIP', 'no speech fixture available');
    return;
  }

  await new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
    const seen = new Set();
    let opened = false;
    let sawExpected = false;
    let settled = false;

    const finish = (connectionDetail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already gone */ }

      record(`${label} — connection`, opened ? 'PASS' : 'FAIL', connectionDetail);
      record(
        `${label} — ${expectMessage} protocol`,
        sawExpected ? 'PASS' : 'FAIL',
        sawExpected
          ? `received ${expectMessage}`
          : `no ${expectMessage} after real speech; saw: ${[...seen].join(',') || 'nothing'}`,
      );
      resolve();
    };

    const timer = setTimeout(() => finish(opened ? 'socket opened' : 'no connection within 25s'), 25_000);

    socket.on('open', () => {
      opened = true;
      // 80 ms packets: the cadence Flux recommends and Nova tolerates.
      const perPacket = 1280;
      let offset = 0;
      const pump = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return clearInterval(pump);
        if (offset >= speech.samples.length) {
          clearInterval(pump);
          return;
        }
        socket.send(pcmToBytes(speech.samples.subarray(offset, offset + perPacket)));
        offset += perPacket;
      }, 80);
    });

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (typeof message.type === 'string') seen.add(message.type);
        if (message.type === expectMessage) {
          sawExpected = true;
          // Give the stream a moment to settle, then report both claims.
          setTimeout(() => finish('socket opened'), 1500);
        }
      } catch { /* binary frames are not the subject here */ }
    });
    socket.on('error', (error) => finish(String(error?.message ?? error).slice(0, 120)));
    socket.on('close', (code) => {
      if (!opened) finish(`closed before open (code ${code})`);
    });
  });
}

// --- Google translation ----------------------------------------------------

async function googleTranslate() {
  const project = env('GOOGLE_TRANSLATE_PROJECT_ID');
  if (project === null) {
    return record('Google translate en->es', 'SKIP', 'GOOGLE_TRANSLATE_PROJECT_ID not set');
  }
  // Deliberately NOT requiring GOOGLE_APPLICATION_CREDENTIALS. ADC resolves
  // from `gcloud auth application-default login`, a metadata server, or
  // workload identity; demanding a JSON key here would undo the abstraction the
  // adapter preserves.
  let token = null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const value = await client.getAccessToken();
    token = typeof value === 'string' ? value : (value?.token ?? null);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes('Cannot find') || message.includes('ERR_MODULE_NOT_FOUND')) {
      return record('Google translate en->es', 'SKIP', 'google-auth-library not installed');
    }
    // An ADC resolution failure is a real, actionable diagnostic.
    return record('Google translate en->es', 'FAIL', `ADC could not resolve: ${message.slice(0, 100)}`);
  }
  if (token === null) return record('Google translate en->es', 'FAIL', 'ADC returned no access token');

  try {
    const response = await fetch(
      `https://translation.googleapis.com/v3/projects/${encodeURIComponent(project)}/locations/global:translateText`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: ['Good morning, the meeting will begin shortly.'],
          sourceLanguageCode: 'en',
          targetLanguageCode: 'es',
          mimeType: 'text/plain',
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return record('Google translate en->es', 'FAIL', `HTTP ${response.status}`);
    const body = await response.json();
    const text = body?.translations?.[0]?.translatedText;
    if (typeof text !== 'string' || text.trim() === '') {
      return record('Google translate en->es', 'FAIL', 'no translatedText in response');
    }
    record('Google translate en->es', 'PASS', `${text.length} chars returned`);
  } catch (error) {
    record('Google translate en->es', 'FAIL', String(error).slice(0, 120));
  }
}

// --- ElevenLabs ------------------------------------------------------------

async function elevenLabs() {
  const key = env('ELEVENLABS_API_KEY');
  if (key === null) return record('ElevenLabs streaming TTS', 'SKIP', 'ELEVENLABS_API_KEY not set');
  const voice = env('ELEVENLABS_SMOKE_VOICE_ID');
  if (voice === null) {
    return record('ElevenLabs streaming TTS', 'SKIP', 'ELEVENLABS_SMOKE_VOICE_ID not set (voice ids are account-specific)');
  }
  const out = join(work, 'tts.pcm');
  try {
    const started = Date.now();
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_16000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Buenos dias, la reunion comenzara en breve.',
          model_id: 'eleven_flash_v2_5',
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return record('ElevenLabs streaming TTS', 'FAIL', `HTTP ${response.status}`);
    let firstChunkMs = null;
    let chunkCount = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      if (firstChunkMs === null) firstChunkMs = Date.now() - started;
      chunkCount += 1;
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(out, Buffer.concat(chunks));
    const bytes = statSync(out).size;
    if (bytes === 0) return record('ElevenLabs streaming TTS', 'FAIL', 'zero bytes returned');
    if (chunkCount < 2) {
      // One chunk means the response was not actually progressive, which is the
      // whole reason for choosing this endpoint.
      record('ElevenLabs streaming TTS', 'FAIL', `only ${chunkCount} chunk; response was not progressive`);
      return;
    }
    const seconds = (bytes / 32000).toFixed(2);
    record(
      'ElevenLabs streaming TTS',
      'PASS',
      `first chunk ${firstChunkMs} ms; ${chunkCount} chunks; ${bytes} bytes (~${seconds}s pcm_16000)`,
    );
  } catch (error) {
    record('ElevenLabs streaming TTS', 'FAIL', String(error).slice(0, 120));
  }
}

async function main() {
  console.log('\nC-AI1 PROVIDER SMOKE TESTS');
  console.log('='.repeat(72));
  console.log('Proves our exact requests work. NOT certification.\n');

  const speech = speechFixture();
  console.log(
    speech === null
      ? '  fixture: NONE — set C_AI1_SMOKE_SPEECH_WAV or configure local Piper.\n' +
        '           Protocol checks will SKIP rather than pass on a tone.\n'
      : `  fixture: ${speech.source}, ${(speech.samples.length / 16000).toFixed(2)}s @ 16 kHz mono\n`,
  );

  await deepgramBatch(speech);
  await deepgramStreaming({
    label: 'Deepgram Nova-3 streaming v1',
    url: 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&language=en',
    expectMessage: 'Results',
    speech,
  });
  await deepgramStreaming({
    label: 'Deepgram Flux streaming v2',
    url: 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000',
    expectMessage: 'TurnInfo',
    speech,
  });
  await googleTranslate();
  await elevenLabs();

  console.log('\n' + '='.repeat(72));
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const passed = results.filter((r) => r.status === 'PASS');
  console.log(`PASS ${passed.length} · SKIP ${skipped.length} · FAIL ${failed.length}`);
  if (skipped.length > 0) {
    console.log('\nSkipped checks prove nothing. A provider stays at its current');
    console.log('integration stage until its check actually runs and passes.');
  }
  console.log('\nEven a full pass does NOT mean certified. Certification requires');
  console.log('latency, accuracy, cost and error-rate evidence per language route');
  console.log('and service category (C-AI1.2).');
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
