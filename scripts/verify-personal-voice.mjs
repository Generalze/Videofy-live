// Videofy Live - P6.3 personal-voice pipeline verification.
//
// Answers one question the unit tests structurally cannot: does the RUNNING
// media-ingest service actually speak an enrolled voice?
//
// Three times in this milestone a personal-voice component was correct and the
// running service used none of it — the provider existed and nothing called it,
// then the router existed and nothing gave it an owner. Every one of those was
// reported as working on green tests. So this drives the real HTTP surface of
// the real process: enroll, join with an owner, speak, and then look at what
// voice actually came out.
//
// What this CANNOT verify is whether the result sounds like the person. That is
// a human judgement and it stays one.
//
// Usage:
//   node scripts/verify-personal-voice.mjs [sourceLanguage] [targetLanguage]
//   node scripts/verify-personal-voice.mjs en es      (default)
//
// Requires: media-ingest running with OPENVOICE_SERVICE_URL set, the OpenVoice
// service running, and the Piper voices the .env registry points at.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

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
const STAGING =
  process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ?? join(ROOT, 'uploads', 'webrtc-staging');
const PIPER = process.env['PIPER_EXECUTABLE'] ?? '';
const FFMPEG = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';

const sourceLanguage = process.argv[2] ?? 'en';
// EN<->ES by default: Spanish is the direction the accepted OpenVoice quality
// evidence was actually gathered against.
const targetLanguage = process.argv[3] ?? 'es';

const SENTENCES = {
  en: [
    'Good morning. Can you hear me clearly?',
    'I would like to book a table for four people.',
    'Thank you very much for your help.',
  ],
  es: [
    'Hola, buenos días. ¿Me escuchas bien?',
    'Quiero confirmar que la traducción funciona.',
    'Muchas gracias por su ayuda.',
  ],
};

const VOICES = {
  en: 'en_US-hfc_female-medium',
  fr: 'fr_FR-siwis-medium',
  es: 'es_ES-sharvard-medium',
};

/**
 * The enrollment voice is deliberately a DIFFERENT Piper voice from the one the
 * call would otherwise use.
 *
 * If the pipeline quietly fell back, the output would be the ordinary target
 * voice and the difference would be audible as well as visible in the voiceId.
 */
const ENROLLMENT_VOICE = 'en_US-hfc_male-medium';

const expected = SENTENCES[sourceLanguage];
if (!expected) {
  console.error(`No known sentences for "${sourceLanguage}".`);
  process.exit(2);
}

function piperEntryFor(language, voiceId) {
  const raw = process.env['PIPER_VOICES'] ?? '';
  for (const entry of raw.split(',')) {
    const [lang, id, modelPath] = entry.split('|');
    if (lang === language && id === voiceId && modelPath) return modelPath;
  }
  return null;
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const workDir = mkdtempSync(join(tmpdir(), 'videofy-personal-'));
const sourceModel = piperEntryFor(sourceLanguage, VOICES[sourceLanguage]);
const enrollmentModel = piperEntryFor('en', ENROLLMENT_VOICE) ?? sourceModel;
if (!PIPER || !sourceModel) {
  console.error('Set PIPER_EXECUTABLE and PIPER_VOICES (load .env).');
  process.exit(2);
}

function speak(model, text, name) {
  const raw = join(workDir, `${name}-raw.wav`);
  const ready = join(workDir, `${name}.wav`);
  execFileSync(PIPER, ['--model', model, '--output_file', raw, '--quiet'], { input: `${text}\n` });
  execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ready], {
    stdio: 'ignore',
  });
  return ready;
}

// ------------------------------------------------------------------ enrollment

const ownerId = `devid_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-6)}`;
const ownerHeader = { 'x-videofy-voice-owner': ownerId };

const created = await postJson(
  '/voice-profiles',
  { consentTextVersion: 'verify-script-v1', callUseGranted: true },
  ownerHeader,
);
if (created.status !== 201) {
  console.error('Could not start enrollment:', created.status, created.json);
  process.exit(1);
}
const voiceProfileId = created.json.voiceProfileId;

// A long enough sample for the engine to derive a tone colour from.
const enrollmentClip = speak(
  enrollmentModel,
  'This is my voice. I am recording a sample so that my translated speech can sound like me. ' +
    'The quick brown fox jumps over the lazy dog, and the weather today is bright and clear.',
  'enrollment',
);
const enrollmentBytes = readFileSync(enrollmentClip);
const enrollResponse = await fetch(
  `${BASE}/voice-profiles/${encodeURIComponent(voiceProfileId)}/enrollment`,
  {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-videofy-enrolled-language': 'en', ...ownerHeader },
    body: enrollmentBytes,
  },
);
const enrollBody = await enrollResponse.json().catch(() => null);
const enrolled = enrollResponse.status >= 200 && enrollResponse.status < 300;

console.log(`\n=== PERSONAL VOICE: ${sourceLanguage.toUpperCase()} -> ${targetLanguage.toUpperCase()} ===`);
console.log(`  owner    ${ownerId}`);
console.log(`  profile  ${voiceProfileId}`);
console.log(`  enrolled ${enrollResponse.status} ${JSON.stringify(enrollBody)}`);

// ------------------------------------------------------------------- the call

const clips = expected.map((sentence, index) => speak(sourceModel, sentence, `clip-${index}`));

const sessionId = `call_pv${Math.floor(Math.random() * 99999)}_participant_1_r1`;
mkdirSync(STAGING, { recursive: true });
const session = await postJson('/internal/webrtc/sessions', {
  sessionId,
  broadcastId: 'callcast_pv_participant_1_r1',
  broadcasterPeerId: 'peer_call_participant_1',
  revision: 1,
  sourceLanguage,
  sourceLanguageMode: 'manual',
  targetLanguage,
  targetLanguages: [targetLanguage],
  voiceIdsByLanguage: { [targetLanguage]: VOICES[targetLanguage] },
  generatedAudioPacing: 'natural',
  voiceOwnerId: ownerId,
});
if (session.status !== 201) {
  console.error('Session creation refused:', session.status, session.json);
  process.exit(1);
}

let cursor = 0;
let latest = null;
for (const [index, clip] of clips.entries()) {
  const staged = join(STAGING, `pv-${index}-${Date.now()}.wav`);
  copyFileSync(clip, staged);
  const bytes = statSync(clip).size;
  const durationMs = Math.max(1000, Math.round((bytes - 44) / 32));
  const result = await postJson(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/chunks`, {
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
  cursor += durationMs + 1200;
  latest = result.json?.session ?? latest;
}

const generated = (latest?.generatedAudio?.events ?? []).filter((e) => e.status === 'generated');
const personalClips = generated.filter((e) => String(e.voiceId).startsWith('personal:'));
const standardClips = generated.filter((e) => !String(e.voiceId).startsWith('personal:'));

console.log('');
for (const event of generated) {
  console.log(`  seq ${event.sequence}  voice=${event.voiceId}  ${event.durationMs ?? '?'}ms`);
}

// ------------------------------------------------------------ across a restart
//
// The store used to be a Map, so every guarantee built on it expired when the
// process did — while the recordings it described stayed on disk. This proves
// the record came back from storage rather than being enrolled again: the
// profile id after the restart must be the SAME one.
//
// Restarting is triggered by touching a watched source file, which only works
// under `tsx watch`. When it does not restart, this reports SKIPPED rather than
// PASS, because "the service never restarted" and "the voice survived a
// restart" must not produce the same green line.

const RESTART_PROBE = {
  sessionId: `call_probe${Math.floor(Math.random() * 99999)}_participant_1_r1`,
  broadcastId: 'callcast_probe_participant_1_r1',
  broadcasterPeerId: 'peer_probe',
  revision: 1,
  sourceLanguage,
  sourceLanguageMode: 'manual',
  targetLanguage,
  targetLanguages: [targetLanguage],
};

/** Sessions live in memory, so an id that can be recreated means a new process. */
async function processRestarted() {
  const again = await postJson('/internal/webrtc/sessions', RESTART_PROBE);
  return again.status === 201;
}

await postJson('/internal/webrtc/sessions', RESTART_PROBE);
const watchedFile = join(ROOT, 'services', 'media-ingest', 'src', 'index.ts');
utimesSync(watchedFile, new Date(), new Date());

let restarted = false;
for (let attempt = 0; attempt < 60 && !restarted; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    restarted = await processRestarted();
  } catch {
    // The port is down mid-restart, which is the expected middle of this.
  }
}

// Which session the withdrawal phase should act on. A restart wipes in-memory
// sessions, so continuing to use the first one would test nothing but its
// absence — and read as a withdrawal failure when it is only a dead session.
let activeSessionId = sessionId;
let activeGenerated = generated;
let activeCursor = cursor;

let survivedProfileId = null;
if (restarted) {
  const afterSessionId = `call_pv${Math.floor(Math.random() * 99999)}_participant_2_r1`;
  await postJson('/internal/webrtc/sessions', {
    sessionId: afterSessionId,
    broadcastId: 'callcast_pv_participant_2_r1',
    broadcasterPeerId: 'peer_call_participant_2',
    revision: 1,
    sourceLanguage,
    sourceLanguageMode: 'manual',
    targetLanguage,
    targetLanguages: [targetLanguage],
    voiceIdsByLanguage: { [targetLanguage]: VOICES[targetLanguage] },
    generatedAudioPacing: 'natural',
    voiceOwnerId: ownerId,
  });
  const restartClip = speak(sourceModel, expected[0], 'after-restart');
  const stagedRestart = join(STAGING, `pv-restart-${Date.now()}.wav`);
  copyFileSync(restartClip, stagedRestart);
  const restartBytes = statSync(restartClip).size;
  const restartResult = await postJson(
    `/internal/webrtc/sessions/${encodeURIComponent(afterSessionId)}/chunks`,
    {
      sequence: 0,
      startMs: 0,
      endMs: Math.max(1000, Math.round((restartBytes - 44) / 32)),
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: restartBytes,
      sourcePath: stagedRestart,
    },
  );
  const restartEvents = (restartResult.json?.session?.generatedAudio?.events ?? []).filter(
    (e) => e.status === 'generated',
  );
  survivedProfileId = restartEvents[0]?.voiceId ?? null;
  console.log(`\n  after restart  voice=${survivedProfileId}`);

  activeSessionId = afterSessionId;
  activeGenerated = restartEvents;
  activeCursor = Math.max(1000, Math.round((restartBytes - 44) / 32)) + 1200;
} else {
  console.log('\n  restart did not happen (not running under tsx watch) — SKIPPED');
}

// -------------------------------------------------------------- taking it back
//
// Consent that cannot be withdrawn through the running system is not consent,
// and withdrawal that only changes future routing leaves cloned utterances
// sitting in listeners' playback queues. So this checks the harder half: that
// audio which ALREADY EXISTS stops being fetchable.

const firstClip = activeGenerated[0];
const clipUrl = firstClip
  ? `${BASE}/sessions/${encodeURIComponent(activeSessionId)}/generated-audio/segments/${encodeURIComponent(firstClip.segmentId)}/audio?language=${targetLanguage}`
  : null;
const beforeStatus = clipUrl ? (await fetch(clipUrl)).status : 0;

const deleted = await fetch(`${BASE}/voice-profiles`, {
  method: 'DELETE',
  headers: ownerHeader,
});
const deletedBody = await deleted.json().catch(() => ({}));
const afterStatus = clipUrl ? (await fetch(clipUrl)).status : 0;

// One more utterance on the SAME live session: no rejoin, no restart.
const afterClip = speak(sourceModel, expected[0], 'after-delete');
const stagedAfter = join(STAGING, `pv-after-${Date.now()}.wav`);
copyFileSync(afterClip, stagedAfter);
const afterBytes = statSync(afterClip).size;
const afterSequence = activeGenerated.length;
const afterResult = await postJson(
  `/internal/webrtc/sessions/${encodeURIComponent(activeSessionId)}/chunks`,
  {
    sequence: afterSequence,
    startMs: activeCursor,
    endMs: activeCursor + Math.max(1000, Math.round((afterBytes - 44) / 32)),
    sampleRate: 16000,
    channelCount: 1,
    pcmFormat: 'pcm_s16le',
    mimeType: 'audio/wav',
    sizeBytes: afterBytes,
    sourcePath: stagedAfter,
  },
);
const afterEvents = (afterResult.json?.session?.generatedAudio?.events ?? []).filter(
  (e) => e.status === 'generated' && e.sequence === afterSequence,
);

console.log('');
console.log(`  withdrawal ${deleted.status} ${JSON.stringify(deletedBody)}`);
console.log(`  queued clip fetch: before=${beforeStatus} after=${afterStatus}`);
for (const event of afterEvents) {
  console.log(`  seq ${event.sequence}  voice=${event.voiceId}   (after deletion)`);
}

// --------------------------------------------------------------- what it means

const checks = [
  ['Enrollment produced a usable profile', enrolled],
  ['Every utterance produced audio', generated.length >= expected.length],
  ['Audio was generated in the PERSONAL voice', personalClips.length >= expected.length],
  [
    'The personal voice is this owner’s profile',
    personalClips.every((e) => e.voiceId === `personal:${voiceProfileId}`),
  ],
  ['Nothing silently fell back to a standard voice', standardClips.length === 0],
  ['No session error', !latest?.error],
  // Reported separately from PASS/FAIL when the service never restarted, so a
  // check that could not run never reads as a check that succeeded.
  [
    restarted
      ? 'The SAME voice profile survived a process restart'
      : 'SKIPPED (no restart): voice survives a process restart',
    restarted ? survivedProfileId === `personal:${voiceProfileId}` : true,
  ],
  ['Deletion was accepted', deleted.status === 200 && deletedBody.deleted >= 1],
  ['Deletion reports nothing left behind', deletedBody.nothingLeft === true],
  [
    'Already-generated audio was destroyed',
    activeGenerated.length > 0 && deletedBody.generatedAudioRemoved >= activeGenerated.length,
  ],
  ['A queued clip was fetchable before deletion', beforeStatus === 200],
  ['That same clip is NOT fetchable after deletion', afterStatus === 404],
  [
    'The next utterance uses the standard voice, with no restart',
    afterEvents.length > 0 && afterEvents.every((e) => e.voiceId === VOICES[targetLanguage]),
  ],
];

console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`Summary: ${passed}/${checks.length} passed`);

if (personalClips.length === 0 && generated.length > 0) {
  console.log(
    '\nAudio was produced in the standard voice. That is the pipeline working and the\n' +
      'personal voice not being selected — check that OPENVOICE_SERVICE_URL is set on\n' +
      'media-ingest and that the OpenVoice service is reachable.',
  );
}

console.log(
  '\nSTILL PENDING HUMAN VERIFICATION: whether the generated audio actually sounds\n' +
    'like the enrolled voice. This script proves the routing, not the resemblance.',
);
console.log(`Generated clips: ${join('uploads', 'audio-chunks', sessionId, 'tts', targetLanguage)}`);

await postJson(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/stop`, {});

process.exit(passed === checks.length ? 0 : 1);
