// Videofy Live - does the pipeline invent words when a speaker stops talking?
//
// Reproduces the exact reported failure: the owner said "Were you just gathering
// momentum?", stopped talking WITHOUT muting, and their own cloned voice then
// recited an invented sentence eight times until they muted.
//
// One real sentence followed by several chunks of room tone, submitted the way
// the chunker submits them. The pass condition is blunt: silence must produce
// no transcript, no translation and no spoken audio.
//
// Amplitude matters. Digital zero is trivially rejected by anything; a real
// muted-but-live microphone is not silent. NOISE_AMPLITUDE straddles the VAD
// energy threshold on purpose, so this tests the guards rather than the VAD.
//
// Usage:
//   node scripts/verify-silence-invention.mjs [amplitude]
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const ROOT = resolve(import.meta.dirname, '..');
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.replace(/^﻿/, '').trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq <= 0) continue;
  const k = t.slice(0, eq).trim(); if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
}
const BASE = process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002';
// 900 sits just above the configured VAD energy gate; 40 is a quiet room.
const NOISE_AMPLITUDE = Number(process.argv[2] ?? 900);
const STAGING = process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ?? join(ROOT, 'uploads', 'webrtc-staging');
const PIPER = process.env['PIPER_EXECUTABLE'];
const FFMPEG = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';
let model = null;
for (const e of (process.env['PIPER_VOICES'] ?? '').split(',')) {
  const [lang, id, path] = e.split('|');
  if (lang === 'en' && id === 'en_US-hfc_female-medium') model = path;
}
const work = tmpdir();
const raw = join(work, 'r.wav'), speech = join(work, 's.wav');
execFileSync(PIPER, ['--model', model, '--output_file', raw, '--quiet'], { input: 'Were you just gathering momentum?\n' });
execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', speech], { stdio: 'ignore' });

function silence(seconds) {
  const n = 16000 * seconds, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF',0); b.writeUInt32LE(36+n*2,4); b.write('WAVE',8); b.write('fmt ',12);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(n*2,40);
  // Real room tone, not digital zero: a muted-but-live mic is never silent.
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((Math.random()-0.5)*NOISE_AMPLITUDE), 44+i*2);
  const p = join(work, `sil-${seconds}-${Math.random().toString(36).slice(2)}.wav`);
  writeFileSync(p, b); return p;
}
const post = (p, b) => fetch(BASE+p, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) }).then(async r => ({ s:r.status, j: await r.json().catch(()=>null) }));
const sessionId = `call_sil${Date.now().toString(36)}_participant_1_r1`;
mkdirSync(STAGING, { recursive: true });
await post('/internal/webrtc/sessions', { sessionId, broadcastId:'callcast_sil', broadcasterPeerId:'peer_sil', revision:1,
  sourceLanguage:'en', sourceLanguageMode:'manual', targetLanguage:'fr', targetLanguages:['fr'],
  voiceIdsByLanguage:{ fr:'fr_FR-upmc-pierre' }, generatedAudioPacing:'natural' });

let cursor = 0, last = null;
const clips = [speech, silence(4), silence(4), silence(4), silence(4), silence(4)];
for (const [i, clip] of clips.entries()) {
  const staged = join(STAGING, `repro-${Date.now()}-${i}.wav`);
  copyFileSync(clip, staged);
  const bytes = statSync(clip).size;
  const dur = Math.max(1000, Math.round((bytes - 44) / 32));
  const r = await post(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/chunks`, {
    sequence:i, startMs:cursor, endMs:cursor+dur, sampleRate:16000, channelCount:1,
    pcmFormat:'pcm_s16le', mimeType:'audio/wav', sizeBytes:bytes, sourcePath:staged });
  cursor += dur; last = r.j?.session ?? last;
  console.log(`chunk ${i} (${i===0?'SPEECH':'silence'}) submitted`);
}
const tr = (last?.transcription?.events ?? []).filter(e=>e.status==='transcribed');
const tl = (last?.translation?.events ?? []).filter(e=>e.status==='translated');
const ga = (last?.generatedAudio?.events ?? []).filter(e=>e.status==='generated');
console.log('\n--- transcripts ---');
for (const e of tr) console.log(`  seq ${e.sequence}: ${JSON.stringify(e.sourceText)}`);
console.log('--- translations ---');
for (const e of tl) console.log(`  seq ${e.sequence}: ${JSON.stringify(e.translatedText)}`);
console.log(`--- spoken clips: ${ga.length} ---`);

// One sentence in, one sentence out. Anything more came from the model.
const checks = [
  ['The real sentence was transcribed', tr.length >= 1],
  ['Silence invented no extra transcript', tr.length === 1],
  ['Silence invented no extra translation', tl.length === 1],
  ['Silence produced no extra spoken audio', ga.length === 1],
];
console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`Summary: ${passed}/${checks.length} passed  (noise amplitude ${NOISE_AMPLITUDE})`);

await post(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/stop`, {});
process.exit(passed === checks.length ? 0 : 1);
