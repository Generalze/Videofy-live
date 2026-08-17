// Videofy Live - how much VOICED audio is in a short answer?
//
// Correcting the VAD accounting is roughly a threefold tightening: the counter
// that decides "did anybody speak" used to absorb silence, so minSpeechMs=500
// was satisfied by 500ms of nothing plus two blips. Now it counts only frames
// above the gate — which means 500ms would start deleting the shortest real
// utterances in the language, silently, visible to nobody but a counter.
//
// So the new threshold is measured rather than chosen. This runs the SAME
// energy gate the chunker uses, frame for frame, over real synthesised speech,
// and reports the voiced duration of the words a caller is most likely to lose.
//
// Usage:
//   node scripts/measure-voiced-duration.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const trimmed = line.replace(/^﻿/, '').trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
}

const PIPER = process.env['PIPER_EXECUTABLE'];
const FFMPEG = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';
const THRESHOLD = Number(process.env['WEBRTC_VAD_SPEECH_THRESHOLD'] ?? 0.012);
const FRAME = 160; // 10 ms at 16 kHz, matching RTCAudioSink.

function voiceModel(language, voiceId) {
  for (const entry of (process.env['PIPER_VOICES'] ?? '').split(',')) {
    const [lang, id, modelPath] = entry.split('|');
    if (lang === language && id === voiceId && modelPath) return modelPath;
  }
  return null;
}

/** The chunker's own energy calculation, reproduced exactly. */
function frameEnergy(samples) {
  let sum = 0;
  for (const sample of samples) {
    const normalised = sample / 32768;
    sum += normalised * normalised;
  }
  return Math.sqrt(sum / samples.length);
}

function voicedMs(wavPath) {
  const buffer = readFileSync(wavPath);
  // 44-byte canonical header written by ffmpeg for pcm_s16le.
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset + 44, (buffer.length - 44) / 2);
  let voiced = 0;
  for (let offset = 0; offset + FRAME <= pcm.length; offset += FRAME) {
    if (frameEnergy(pcm.subarray(offset, offset + FRAME)) >= THRESHOLD) voiced += 10;
  }
  return voiced;
}

const WORDS = [
  ['en', 'en_US-hfc_female-medium', ['Yes.', 'No.', 'Hi.', 'Okay.', 'Sure.']],
  ['en', 'en_US-hfc_male-medium', ['Yes.', 'No.', 'Okay.']],
  ['es', 'es_ES-sharvard-medium', ['Sí.', 'No.', 'Gracias.']],
  ['fr', 'fr_FR-siwis-medium', ['Oui.', 'Non.', 'Merci.']],
  ['fr', 'fr_FR-upmc-pierre', ['Oui.', 'Non.', 'Merci.']],
];

const work = tmpdir();
const measured = [];
console.log(`\n=== VOICED DURATION OF SHORT ANSWERS (gate ${THRESHOLD}) ===\n`);

for (const [language, voiceId, words] of WORDS) {
  const model = voiceModel(language, voiceId);
  if (!PIPER || !model || !existsSync(model)) {
    console.log(`  ${language}/${voiceId}: model unavailable, skipped`);
    continue;
  }
  for (const word of words) {
    const raw = join(work, 'vd-raw.wav');
    const ready = join(work, 'vd.wav');
    execFileSync(PIPER, ['--model', model, '--output_file', raw, '--quiet'], { input: `${word}\n` });
    execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ready], {
      stdio: 'ignore',
    });
    const ms = voicedMs(ready);
    measured.push({ language, voiceId, word, ms });
    console.log(`  ${language}  ${voiceId.padEnd(24)} ${word.padEnd(10)} ${String(ms).padStart(4)} ms voiced`);
  }
}

if (measured.length === 0) {
  console.error('\nNo voices available to measure.');
  process.exit(2);
}

const shortest = measured.reduce((a, b) => (a.ms <= b.ms ? a : b));
console.log(`\n  shortest: ${shortest.word} (${shortest.language}) at ${shortest.ms} ms voiced`);
console.log(`  current WEBRTC_VAD_MIN_SPEECH_MS: ${process.env['WEBRTC_VAD_MIN_SPEECH_MS'] ?? '(unset)'}`);
console.log(
  `\n  A threshold at or above ${shortest.ms} ms deletes "${shortest.word}" entirely —\n` +
    '  no caption, no translation, no audio, visible only as a counter.\n' +
    '  Leave clear headroom below it: real microphones are quieter and noisier\n' +
    '  than synthesised speech, so measured values here are an OPTIMISTIC bound.',
);
