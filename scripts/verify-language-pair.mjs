// Videofy Live - deterministic language-pair verification.
//
// Synthesises known sentences, plays them through the REAL media-ingest
// pipeline as a native-call session, and asserts on the transcript and the
// translation. A pass means the words actually survived speech recognition,
// translation and speech synthesis — not that something plausible appeared.
//
// Why this exists rather than a browser harness: on at least one development
// machine Chrome/Edge ignore --use-fake-device-for-media-capture entirely and
// hand back the real microphone, so a browser test transcribes the room and
// speech recognition hallucinates plausible text on near-silence. That failure
// mode is invisible — it looks like a passing test. Verify content here, and
// use a browser only for what a browser uniquely covers: transport, routing,
// caption delivery and the interface itself.
//
// Usage:
//   node scripts/verify-language-pair.mjs en fr
//   node scripts/verify-language-pair.mjs es en
//
// Requires media-ingest running (npm run dev -w services/media-ingest), plus
// the Piper voices and OPUS-MT models the .env registry points at.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Reads .env directly rather than asking the caller to source it. The registry
 * values are Windows paths full of backslashes, which a POSIX shell mangles on
 * the way in, so "source .env && node ..." silently produces broken paths.
 * Existing environment variables win, so an explicit override still works.
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvFile(join(ROOT, '.env'));

const BASE = process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002';
const STAGING = process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ?? join(ROOT, 'uploads', 'webrtc-staging');
const PIPER = process.env['PIPER_EXECUTABLE'] ?? '';
const FFMPEG = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';

/**
 * Sentences chosen to be ordinary and unambiguous, so a wrong result is a real
 * failure rather than a translator disagreeing about an idiom.
 */
const SENTENCES = {
  en: [
    'Good morning. Can you hear me clearly?',
    'The weather in London is cold today.',
    'I would like to book a table for four people.',
    'Thank you very much for your help.',
  ],
  fr: [
    "Bonjour, est-ce que vous m'entendez bien ?",
    'Je voudrais réserver une chambre pour deux nuits.',
    'Merci beaucoup pour votre aide.',
  ],
  es: [
    'Hola, buenos días. ¿Me escuchas bien?',
    'Quiero confirmar que la traducción funciona en ambas direcciones.',
    'Muchas gracias por su ayuda.',
  ],
};

/** Voice used to SPEAK each source language, and to hear each target. */
const VOICES = {
  en: 'en_US-hfc_female-medium',
  fr: 'fr_FR-siwis-medium',
  es: 'es_ES-sharvard-medium',
};

const sourceLanguage = process.argv[2] ?? 'en';
const targetLanguage = process.argv[3] ?? 'fr';
const expected = SENTENCES[sourceLanguage];
if (!expected) {
  console.error(`No known sentences for "${sourceLanguage}". Add them to SENTENCES.`);
  process.exit(2);
}

function piperModelFor(language) {
  // The .env registry is source:voiceId:model:config, comma separated.
  const raw = process.env['PIPER_VOICES'] ?? '';
  for (const entry of raw.split(',')) {
    const [lang, voiceId, modelPath] = entry.split('|');
    if (lang === language && voiceId === VOICES[language] && modelPath) return modelPath;
  }
  return null;
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const workDir = mkdtempSync(join(tmpdir(), 'videofy-pair-'));
const model = piperModelFor(sourceLanguage);
if (!PIPER || !model) {
  console.error(
    'Set PIPER_EXECUTABLE and PIPER_VOICES (load .env) so known speech can be synthesised.',
  );
  process.exit(2);
}

// Synthesise each sentence, then downsample to the 16 kHz mono the call
// pipeline accepts.
const clips = [];
for (const [index, sentence] of expected.entries()) {
  const raw = join(workDir, `raw-${index}.wav`);
  const ready = join(workDir, `clip-${index}.wav`);
  execFileSync(PIPER, ['--model', model, '--output_file', raw, '--quiet'], { input: `${sentence}\n` });
  execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ready], {
    stdio: 'ignore',
  });
  clips.push(ready);
}

const sessionId = `call_verify${Math.floor(Math.random() * 99999)}_participant_1_r1`;
mkdirSync(STAGING, { recursive: true });
await post('/internal/webrtc/sessions', {
  sessionId,
  broadcastId: 'callcast_verify_participant_1_r1',
  broadcasterPeerId: 'peer_call_participant_1',
  revision: 1,
  sourceLanguage,
  sourceLanguageMode: 'manual',
  targetLanguage,
  targetLanguages: [targetLanguage],
  voiceIdsByLanguage: { [targetLanguage]: VOICES[targetLanguage] },
  generatedAudioPacing: 'natural',
});

let cursor = 0;
let session = null;
for (const [index, clip] of clips.entries()) {
  const staged = join(STAGING, `verify-${index}-${Date.now()}.wav`);
  copyFileSync(clip, staged);
  const bytes = statSync(clip).size;
  // 16 kHz mono 16-bit is 32 bytes per millisecond.
  const durationMs = Math.max(1000, Math.round((bytes - 44) / 32));
  const result = await post(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/chunks`, {
    sequence: index,
    startMs: cursor,
    endMs: cursor + durationMs,
    sampleRate: 16000,
    channelCount: 1,
    pcmFormat: 'pcm_s16le',
    mimeType: 'audio/wav',
    sizeBytes: bytes,
    sourcePath: staged,
  });
  // A real speaker pauses; contiguous chunks are not what a call produces.
  cursor += durationMs + 1200;
  session = result.json?.session ?? session;
}

const transcripts = (session?.transcription?.events ?? []).filter((e) => e.status === 'transcribed');
const translations = (session?.translation?.events ?? []).filter((e) => e.status === 'translated');
const clipsOut = (session?.generatedAudio?.events ?? []).filter((e) => e.status === 'generated');

const normalise = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} ]/gu, '')
    .trim();

/** Share of the expected content words that actually came back. */
function wordOverlap(expectedText, heardText) {
  const wanted = new Set(normalise(expectedText).split(/\s+/).filter((w) => w.length > 2));
  const heard = new Set(normalise(heardText).split(/\s+/));
  if (wanted.size === 0) return 0;
  let hits = 0;
  for (const word of wanted) if (heard.has(word)) hits += 1;
  return hits / wanted.size;
}

console.log(`\n=== ${sourceLanguage.toUpperCase()} -> ${targetLanguage.toUpperCase()} ===`);
let matched = 0;
expected.forEach((sentence, index) => {
  const heard = transcripts[index];
  const score = heard ? wordOverlap(sentence, heard.sourceText) : 0;
  if (score >= 0.5) matched += 1;
  console.log(`  ${score >= 0.5 ? 'OK  ' : 'MISS'} "${sentence}"`);
  console.log(`       heard "${heard?.sourceText ?? '(nothing)'}" (${Math.round(score * 100)}% of words)`);
  const translated = translations.find((t) => t.sequence === heard?.sequence);
  if (translated) console.log(`       ${targetLanguage}    "${translated.translatedText}"`);
});

const checks = [
  ['Every utterance transcribed', transcripts.length >= expected.length],
  ['Transcripts match the known words', matched >= Math.ceil(expected.length * 0.75)],
  ['Every utterance translated', translations.length >= expected.length],
  ['Translation is not a copy of the source', translations.every((t) => normalise(t.translatedText) !== normalise(t.sourceText))],
  ['Translated speech generated', clipsOut.length >= expected.length],
  ['No session error', !session?.error],
];
console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`Summary: ${passed}/${checks.length} passed`);

await post(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/stop`, {});
await fetch(`${BASE}/internal/webrtc/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});

process.exit(passed === checks.length ? 0 : 1);
