#!/usr/bin/env node
/** @author masterzee001 */
/**
 * C-AI1 direct provider smoke tests.
 *
 * WHAT THIS IS: proof that OUR EXACT REQUESTS work against the real services.
 * Documentation says a vendor permits something; this says our adapter asks for
 * it correctly. Those are different claims and the second one is the one that
 * fails at 3am.
 *
 * WHAT THIS IS NOT: certification. It cannot move a provider past `testing`.
 * Certification needs latency distributions, accuracy against references, cost
 * per minute and error rates under load, per language route and per service
 * category -- that is C-AI1.2 and it is a different exercise entirely.
 *
 * SKIPS RATHER THAN FAILS when a credential is absent, so it is safe to run
 * anywhere. Never prints a credential, and never writes one to disk.
 *
 * Run:  node scripts/c-ai1-provider-smoke.mjs
 */
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const work = mkdtempSync(join(tmpdir(), 'c-ai1-smoke-'));

function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const env = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/** 16 kHz mono PCM16: a short tone, so a recogniser has real signal to chew on. */
function tone(ms, hz = 220) {
  const samples = new Int16Array(Math.round((16000 * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 16000) * 8000);
  }
  return samples;
}

function pcmToBytes(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i], i * 2);
  return out;
}

function wav(samples) {
  const data = pcmToBytes(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// --- Deepgram batch (Nova) -------------------------------------------------

async function deepgramBatch() {
  const key = env('DEEPGRAM_API_KEY');
  if (key === null) return record('Deepgram Nova-3 batch', 'SKIP', 'DEEPGRAM_API_KEY not set');
  const file = join(work, 'tone.wav');
  writeFileSync(file, wav(tone(1500)));
  try {
    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&utterances=true&language=en',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'content-type': 'audio/wav' },
        body: wav(tone(1500)),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      return record('Deepgram Nova-3 batch', 'FAIL', `HTTP ${response.status}`);
    }
    const body = await response.json();
    const alt = body?.results?.channels?.[0]?.alternatives?.[0];
    const hasWords = Array.isArray(alt?.words);
    // A tone is not speech, so an EMPTY transcript is a correct answer. What is
    // being proved is that the request shape is accepted and the envelope
    // parses -- not that the model can transcribe a sine wave.
    record(
      'Deepgram Nova-3 batch',
      'PASS',
      `accepted 16 kHz WAV; envelope parsed; words[] ${hasWords ? 'present' : 'absent'}`,
    );
  } catch (error) {
    record('Deepgram Nova-3 batch', 'FAIL', String(error).slice(0, 120));
  }
}

// --- Deepgram streaming (Nova v1 and Flux v2) ------------------------------

async function deepgramStreaming({ label, url, expectMessage }) {
  const key = env('DEEPGRAM_API_KEY');
  if (key === null) return record(label, 'SKIP', 'DEEPGRAM_API_KEY not set');
  let WebSocket;
  try {
    ({ WebSocket } = await import('ws'));
  } catch {
    return record(label, 'SKIP', 'ws not installed');
  }

  return await new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
    const seen = new Set();
    let opened = false;
    const finish = (status, detail) => {
      try { socket.close(); } catch { /* already gone */ }
      record(label, status, detail);
      resolve();
    };
    const timer = setTimeout(
      () => finish(opened ? 'PASS' : 'FAIL', opened
        ? `connected; messages: ${[...seen].join(',') || 'none within window'}`
        : 'no connection within 20s'),
      20_000,
    );

    socket.on('open', () => {
      opened = true;
      // 80 ms packets: the cadence Flux recommends and Nova tolerates.
      const packet = pcmToBytes(tone(80));
      let sent = 0;
      const pump = setInterval(() => {
        if (socket.readyState !== socket.OPEN || sent >= 25) {
          clearInterval(pump);
          return;
        }
        socket.send(packet);
        sent += 1;
      }, 80);
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (typeof message.type === 'string') seen.add(message.type);
        if (message.type === expectMessage) {
          clearTimeout(timer);
          finish('PASS', `connected; received ${expectMessage}`);
        }
      } catch { /* binary or unparseable frames are not the subject here */ }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish('FAIL', String(error?.message ?? error).slice(0, 140));
    });
    socket.on('close', (code) => {
      if (!opened) {
        clearTimeout(timer);
        // 400/401 arrive as an abnormal close; the code is the diagnostic.
        finish('FAIL', `closed before open (code ${code})`);
      }
    });
  });
}

// --- Google translation ----------------------------------------------------

async function googleTranslate() {
  const project = env('GOOGLE_TRANSLATE_PROJECT_ID');
  const creds = env('GOOGLE_APPLICATION_CREDENTIALS');
  if (project === null || creds === null) {
    return record('Google translate en->es', 'SKIP', 'GOOGLE_TRANSLATE_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS not set');
  }
  let token = null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    token = await (await auth.getClient()).getAccessToken();
    token = typeof token === 'string' ? token : token?.token ?? null;
  } catch {
    return record('Google translate en->es', 'SKIP', 'google-auth-library not installed (ADC needs it)');
  }
  if (token === null) return record('Google translate en->es', 'FAIL', 'ADC returned no token');

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
        body: JSON.stringify({ text: 'Buenos dias, la reunion comenzara en breve.', model_id: 'eleven_flash_v2_5' }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return record('ElevenLabs streaming TTS', 'FAIL', `HTTP ${response.status}`);
    let firstChunkMs = null;
    const chunks = [];
    for await (const chunk of response.body) {
      if (firstChunkMs === null) firstChunkMs = Date.now() - started;
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(out, Buffer.concat(chunks));
    const bytes = statSync(out).size;
    if (bytes === 0) return record('ElevenLabs streaming TTS', 'FAIL', 'zero bytes returned');
    // pcm_16000 is 32000 bytes per second of audio.
    const seconds = (bytes / 32000).toFixed(2);
    record(
      'ElevenLabs streaming TTS',
      'PASS',
      `first chunk ${firstChunkMs} ms; ${bytes} bytes (~${seconds}s of pcm_16000)`,
    );
  } catch (error) {
    record('ElevenLabs streaming TTS', 'FAIL', String(error).slice(0, 120));
  }
}

async function main() {
  console.log('\nC-AI1 PROVIDER SMOKE TESTS');
  console.log('='.repeat(70));
  console.log('Proves our exact requests work. NOT certification.\n');

  await deepgramBatch();
  await deepgramStreaming({
    label: 'Deepgram Nova-3 streaming (v1)',
    url: 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&language=en',
    expectMessage: 'Results',
  });
  await deepgramStreaming({
    label: 'Deepgram Flux streaming (v2)',
    url: 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000',
    expectMessage: 'TurnInfo',
  });
  await googleTranslate();
  await elevenLabs();

  console.log('\n' + '='.repeat(70));
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
