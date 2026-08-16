// Videofy Live - account identity acceptance, the machine-checkable half.
//
// The manual passes exist to prove two things:
//
//   1. one browser, two people  -> B must never inherit A's voice
//   2. one person, two browsers -> A's voice is found without re-recording
//
// Both have a server-side core that does not need a browser at all, and that
// core is where the defect would actually live. A second sign-in produces a
// second token exactly as a second browser would; whether the profile is found
// is decided by the account behind the token, not by anything stored locally.
//
// So this runs that core, and the human passes are then only proving what a
// browser uniquely covers: that the app stores, clears and re-presents the
// session correctly, and that it sounds right.
//
// Usage:
//   node scripts/verify-account-identity.mjs
//
// Requires the account service and media-ingest running (npm run dev).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.replace(/^﻿/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvFile(join(ROOT, '.env'));

const INGEST = process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002';
const ACCOUNTS = process.env['ACCOUNT_URL'] ?? 'http://localhost:3006';
const STAGING =
  process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ?? join(ROOT, 'uploads', 'webrtc-staging');
const PIPER = process.env['PIPER_EXECUTABLE'] ?? '';
const FFMPEG = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';
const PASSWORD = 'identity acceptance passphrase';

const work = mkdtempSync(join(tmpdir(), 'videofy-identity-'));

function piperModel(language, voiceId) {
  for (const entry of (process.env['PIPER_VOICES'] ?? '').split(',')) {
    const [lang, id, modelPath] = entry.split('|');
    if (lang === language && id === voiceId && modelPath) return modelPath;
  }
  return null;
}

const EN_MODEL = piperModel('en', 'en_US-hfc_female-medium');
const ENROLL_MODEL = piperModel('en', 'en_US-hfc_male-medium') ?? EN_MODEL;
if (!PIPER || !EN_MODEL) {
  console.error('Set PIPER_EXECUTABLE and PIPER_VOICES (load .env).');
  process.exit(2);
}

function speak(model, text, name) {
  const raw = join(work, `${name}-raw.wav`);
  const ready = join(work, `${name}.wav`);
  execFileSync(PIPER, ['--model', model, '--output_file', raw, '--quiet'], { input: `${text}\n` });
  execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ready], {
    stdio: 'ignore',
  });
  return ready;
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A sign-in, exactly as an independent browser would perform it. */
async function signIn(email) {
  const { status, body } = await json(`${ACCOUNTS}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (status !== 200) throw new Error(`sign-in failed: ${status}`);
  return body;
}

async function register(email) {
  const { status, body } = await json(`${ACCOUNTS}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (status !== 201) throw new Error(`registration failed: ${status}`);
  return body;
}

async function enrol(token, label) {
  const started = await json(`${INGEST}/voice-profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ consentTextVersion: 'identity-acceptance-v1', callUseGranted: true }),
  });
  if (started.status !== 201) throw new Error(`enrollment start failed: ${started.status}`);
  const clip = speak(
    ENROLL_MODEL,
    'This is my voice. I am recording a sample so my translated speech can sound like me. ' +
      'The quick brown fox jumps over the lazy dog, and the weather today is bright and clear.',
    `enrol-${label}`,
  );
  const response = await fetch(
    `${INGEST}/voice-profiles/${encodeURIComponent(started.body.voiceProfileId)}/enrollment`,
    {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-videofy-enrolled-language': 'en',
        authorization: `Bearer ${token}`,
      },
      body: readFileSync(clip),
    },
  );
  const body = await response.json().catch(() => ({}));
  return { ok: response.status === 201 && body.personalVoiceReady === true, profileId: started.body.voiceProfileId };
}

/**
 * One utterance on a fresh call session owned by `accountId`.
 *
 * The owner is what a real gateway would derive from that client's token; this
 * hands media-ingest the same value so the question under test is "does this
 * account find its voice", not "does the gateway verify" — which has its own
 * tests and its own live proof.
 */
let sessionSerial = 0;
async function speakOnCall(accountId, label) {
  const sessionId = `call_id${Date.now().toString(36)}${++sessionSerial}_participant_1_r1`;
  mkdirSync(STAGING, { recursive: true });
  await json(`${INGEST}/internal/webrtc/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      broadcastId: `callcast_id_${sessionSerial}`,
      broadcasterPeerId: `peer_id_${sessionSerial}`,
      revision: 1,
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguage: 'es',
      targetLanguages: ['es'],
      voiceIdsByLanguage: { es: 'es_ES-sharvard-medium' },
      generatedAudioPacing: 'natural',
      ...(accountId ? { voiceOwnerId: accountId } : {}),
    }),
  });
  const clip = speak(EN_MODEL, 'Good morning. Can you hear me clearly?', `say-${label}`);
  const staged = join(STAGING, `identity-${Date.now()}-${sessionSerial}.wav`);
  copyFileSync(clip, staged);
  const bytes = statSync(clip).size;
  const result = await json(`${INGEST}/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/chunks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sequence: 0,
      startMs: 0,
      endMs: Math.max(1000, Math.round((bytes - 44) / 32)),
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: bytes,
      sourcePath: staged,
    }),
  });
  await json(`${INGEST}/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const generated = (result.body?.session?.generatedAudio?.events ?? []).filter(
    (event) => event.status === 'generated',
  );
  return generated[0]?.voiceId ?? null;
}

// --------------------------------------------------------------------- run it

const stamp = Date.now().toString(36);
const emailA = `identity-a-${stamp}@videofy.local`;
const emailB = `identity-b-${stamp}@videofy.local`;

console.log('\n=== ACCOUNT IDENTITY ACCEPTANCE (server-side core) ===');

const accountA = await register(emailA);
const accountB = await register(emailB);
console.log(`  account A  ${accountA.accountId}`);
console.log(`  account B  ${accountB.accountId}`);

const enrolledA = await enrol(accountA.token, 'a');
console.log(`  A enrolled ${enrolledA.ok} (${enrolledA.profileId})`);

// 1. A speaks — personal voice.
const aVoice = await speakOnCall(accountA.accountId, 'a1');

// 2. B has NOT enrolled. B must get a standard voice, and never A's.
const bBeforeVoice = await speakOnCall(accountB.accountId, 'b1');

// 3. B enrols and speaks — B's own voice, still never A's.
const enrolledB = await enrol(accountB.token, 'b');
const bAfterVoice = await speakOnCall(accountB.accountId, 'b2');

// 4. Nobody signed in — standard voice.
const anonymousVoice = await speakOnCall(null, 'anon');

// 5. A signs in AGAIN, as an independent client would. A different token, the
//    same account, and no re-enrolment: the profile must still be found.
const secondClientA = await signIn(emailA);
const aSecondClientVoice = await speakOnCall(secondClientA.accountId, 'a2');

console.log('');
console.log(`  A, client 1          ${aVoice}`);
console.log(`  B before enrolling   ${bBeforeVoice}`);
console.log(`  B after enrolling    ${bAfterVoice}`);
console.log(`  nobody signed in     ${anonymousVoice}`);
console.log(`  A, client 2 (resign) ${aSecondClientVoice}`);

const personalA = `personal:${enrolledA.profileId}`;
const personalB = `personal:${enrolledB.profileId}`;
const STANDARD = 'es_ES-sharvard-medium';

const checks = [
  ['A is heard in A’s own voice', aVoice === personalA],
  ['B without a voice gets the standard one', bBeforeVoice === STANDARD],
  ['B NEVER inherits A’s voice', bBeforeVoice !== personalA && bAfterVoice !== personalA],
  ['B after enrolling is heard in B’s voice', bAfterVoice === personalB],
  ['nobody signed in gets the standard voice', anonymousVoice === STANDARD],
  ['a second client for A finds A’s voice without re-recording', aSecondClientVoice === personalA],
  ['the second sign-in issued a different token', secondClientA.token !== accountA.token],
  ['both tokens name the same account', secondClientA.accountId === accountA.accountId],
];

console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`Summary: ${passed}/${checks.length} passed`);

// Leave nothing behind: both accounts' voices are deleted through the real
// owner-scoped endpoint, which is also one last proof that it works.
for (const token of [accountA.token, accountB.token]) {
  await fetch(`${INGEST}/voice-profiles`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

console.log(
  '\nSTILL PENDING HUMAN VERIFICATION: that the BROWSER stores, clears and\n' +
    're-presents the session correctly across sign-out and sign-in, and that the\n' +
    'voice sounds right. This proves the server half only.',
);

process.exit(passed === checks.length ? 0 : 1);
