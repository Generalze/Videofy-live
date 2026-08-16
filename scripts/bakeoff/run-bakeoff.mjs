// Videofy Live — C-AI1.0 provider bake-off.
//
//   node scripts/bakeoff/run-bakeoff.mjs                 # baseline only
//   node scripts/bakeoff/run-bakeoff.mjs --pair en-es    # one direction
//
// Runs every registered provider over the same corpus and prints one comparable
// row each. No provider is wired into the product by running this, and no
// vendor account is required for the baseline — the point is to have the
// measurement rig ready and trusted before any contract is signed.
//
// Raw per-utterance evidence is written to .videofy-bakeoff/ (git-ignored), so
// a surprising summary can always be traced back to what was actually said.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CORPUS, NIGERIAN_ACCENT_GAP, corpusFor } from './corpus.mjs';
import { scoreUtterance, summarize } from './metrics.mjs';
import { assertProvider } from './provider-contract.mjs';
import { createBaselineBatchProvider } from './providers/baseline-batch.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EVIDENCE_DIR = join(ROOT, '.videofy-bakeoff');
const AUDIO_DIR = join(EVIDENCE_DIR, 'corpus-audio');
const STAGING = process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ?? join(ROOT, 'uploads', 'webrtc-staging');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvFile(join(ROOT, '.env'));

const pairArg = process.argv.includes('--pair')
  ? process.argv[process.argv.indexOf('--pair') + 1]
  : null;
const utterances = corpusFor(pairArg);

/** Synthesises corpus audio once; reused by every provider so input is identical. */
function ensureCorpusAudio() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const piper = process.env['PIPER_EXECUTABLE'];
  const ffmpeg = process.env['PIPER_FFMPEG'] ?? 'ffmpeg';
  const voices = new Map();
  for (const entry of (process.env['PIPER_VOICES'] ?? '').split(',')) {
    const [lang, voiceId, modelPath] = entry.split('|');
    if (lang && modelPath && !voices.has(lang)) voices.set(lang, modelPath);
  }
  if (!piper || voices.size === 0) {
    throw new Error('PIPER_EXECUTABLE and PIPER_VOICES must be set (load .env) to build corpus audio.');
  }

  let built = 0;
  for (const utterance of utterances) {
    const ready = join(AUDIO_DIR, `${utterance.id}.wav`);
    if (existsSync(ready)) continue;
    const model = voices.get(utterance.sourceLanguage);
    if (!model) throw new Error(`No Piper voice registered for ${utterance.sourceLanguage}`);
    const raw = join(AUDIO_DIR, `${utterance.id}.raw.wav`);
    execFileSync(piper, ['--model', model, '--output_file', raw, '--quiet'], {
      input: `${utterance.text}\n`,
    });
    execFileSync(ffmpeg, ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ready], {
      stdio: 'ignore',
    });
    built += 1;
  }
  return built;
}

async function runProvider(provider) {
  assertProvider(provider);
  await provider.setUp?.();
  const scored = [];
  try {
    for (const utterance of utterances) {
      const result = await provider.run(utterance);
      scored.push(scoreUtterance(utterance, result));
    }
  } finally {
    await provider.tearDown?.();
  }
  return { summary: summarize(provider.name, scored, provider.usage?.()), scored };
}

function pct(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}ms`;
}

function report(summaries) {
  for (const summary of summaries) {
    console.log(`\n${'='.repeat(64)}\n${summary.provider}  (${summary.utterances} utterances)`);
    console.log('  latency            p50      p90      p95');
    for (const [stage, value] of Object.entries(summary.latency)) {
      const label = stage.replace(/Ms$/, '').replace(/([A-Z])/g, ' $1').toLowerCase();
      if (!value) {
        console.log(`    ${label.padEnd(24)} not supported by this provider`);
        continue;
      }
      console.log(`    ${label.padEnd(24)} ${pct(value.p50).padStart(7)} ${pct(value.p90).padStart(8)} ${pct(value.p95).padStart(8)}`);
    }
    const q = summary.quality;
    console.log('  quality');
    console.log(`    word error rate          ${q.wordErrorRate === null ? '—' : (q.wordErrorRate * 100).toFixed(1) + '%'}`);
    console.log(`    invented words           ${q.inventedWords}`);
    console.log(`    dropped words            ${q.droppedWords}`);
    console.log(`    sentence-boundary damage ${q.sentenceBoundaryDamage}`);
    console.log(`    content recall           ${q.contentRecall === null ? '—' : (q.contentRecall * 100).toFixed(0) + '%'}`);
    console.log(`    names and numbers kept   ${q.protectedTokenAccuracy === null ? '—' : (q.protectedTokenAccuracy * 100).toFixed(0) + '%'}`);
    const e = summary.economics;
    console.log('  economics');
    console.log(
      `    effective $/participant-min  ${e.effectiveCostPerParticipantMinute === null ? '—' : '$' + e.effectiveCostPerParticipantMinute.toFixed(4)}  [${e.verdict}]`,
    );
    if (e.note) console.log(`    note                         ${e.note}`);
  }
  console.log(`\n${'='.repeat(64)}`);
  console.log(`UNMEASURED  ${NIGERIAN_ACCENT_GAP.dimension}: ${NIGERIAN_ACCENT_GAP.reason}`);
  console.log(`            ${NIGERIAN_ACCENT_GAP.howToSupply}`);
}

const built = ensureCorpusAudio();
console.log(
  `corpus: ${utterances.length} utterances${pairArg ? ` (${pairArg})` : ''}, ${built} newly synthesised`,
);

const providers = [createBaselineBatchProvider({ stagingDir: STAGING, audioDir: AUDIO_DIR })];
// Azure and OpenAI adapters register here once credentials exist; the runner and
// the scoring do not change to accommodate them, which is the point.

const runs = [];
for (const provider of providers) {
  runs.push(await runProvider(provider));
}
const summaries = runs.map((run) => run.summary);
report(summaries);

mkdirSync(EVIDENCE_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidencePath = join(EVIDENCE_DIR, `bakeoff-${stamp}.json`);
writeFileSync(
  evidencePath,
  JSON.stringify(
    {
      corpus: CORPUS,
      pair: pairArg,
      summaries,
      // Per-utterance detail is the point of keeping evidence: a surprising
      // summary must be traceable to what was actually said and heard.
      utterances: Object.fromEntries(runs.map((run) => [run.summary.provider, run.scored])),
      unmeasured: [NIGERIAN_ACCENT_GAP],
    },
    null,
    2,
  ),
);
console.log(`\nevidence: ${evidencePath}`);
