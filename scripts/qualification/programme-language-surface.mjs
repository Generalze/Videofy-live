#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Programme language-surface qualification framework.
 *
 * This script reads the existing directional translation route registry and
 * generates documentation around it. It does not approve routes, edit the
 * registry, touch production configuration, contact providers, or run
 * benchmarks. The output is deliberately a qualification framework: a matrix,
 * reusable evidence commands, and manual continuation notes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTE_DOCUMENT = join(
  ROOT,
  'packages',
  'translation-routes',
  'routes',
  'translation-routes.seed.json',
);
const DEFAULT_OUT_DIR = join(ROOT, 'docs', 'certification', 'programme-language-surface');

const EXPECTED_DIRECTIONS = [
  ['en', 'fr'],
  ['fr', 'en'],
  ['en', 'es'],
  ['es', 'en'],
  ['en', 'pt'],
  ['pt', 'en'],
  ['en', 'ha'],
  ['ha', 'en'],
  ['en', 'ig'],
  ['ig', 'en'],
  ['en', 'yo'],
  ['yo', 'en'],
  ['en', 'pcm'],
  ['pcm', 'en'],
];

const SERVICE_SCOPES = ['messaging', 'programme-live', 'call-live'];
const LANGUAGE_LABELS = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  ha: 'Hausa',
  ig: 'Igbo',
  yo: 'Yoruba',
  pcm: 'Nigerian Pidgin',
};

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const outDir = resolve(argValue('--out-dir', DEFAULT_OUT_DIR));
const writeMode = process.argv.includes('--write');
const checkMode = process.argv.includes('--check');
const printCommands = process.argv.includes('--print-evidence-commands');
const printFirstCommand = process.argv.includes('--print-first-manual-command');
const checkGoogleSttWiring = process.argv.includes('--check-google-stt-wiring');

const GOOGLE_STT_CANDIDATE_LOCALES = {
  ha: 'ha-NG',
  ig: 'ig-NG',
  yo: 'yo-NG',
};

function loadDocument() {
  return JSON.parse(readFileSync(ROUTE_DOCUMENT, 'utf8'));
}

function direction(source, target) {
  return `${source}->${target}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateRoutes(document) {
  if (!Array.isArray(document.routes)) fail('route document has no routes array');
  const byDirection = new Map();
  for (const route of document.routes) {
    byDirection.set(direction(route.sourceLanguage, route.targetLanguage), route);
  }
  const missing = EXPECTED_DIRECTIONS.map(([source, target]) => direction(source, target)).filter(
    (key) => !byDirection.has(key),
  );
  const extra = [...byDirection.keys()].filter(
    (key) => !EXPECTED_DIRECTIONS.some(([source, target]) => direction(source, target) === key),
  );
  if (missing.length > 0 || extra.length > 0) {
    fail(
      [
        'route document no longer matches the 14-direction framework',
        missing.length ? `missing: ${missing.join(', ')}` : '',
        extra.length ? `extra: ${extra.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return EXPECTED_DIRECTIONS.map(([source, target]) => byDirection.get(direction(source, target)));
}

function escapeCell(value) {
  return String(value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
}

function table(headers, rows) {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

function routeSummary(route) {
  if (route.provider === 'unassigned') return 'declared gap';
  if (route.technicalEvidence === null) return 'technical evidence missing';
  const latency = route.technicalEvidence.latencyMs;
  return `n=${route.technicalEvidence.sampleCount}; success=${route.technicalEvidence.successRate}; median=${latency.median} ms; max=${latency.max} ms`;
}

function latencyField(route) {
  if (route.technicalEvidence === null) return 'missing';
  const latency = route.technicalEvidence.latencyMs;
  return `min ${latency.min} / median ${latency.median} / mean ${latency.mean} / max ${latency.max} ms`;
}

function integrityField(route) {
  if (route.technicalEvidence === null) return 'missing';
  const notes = route.technicalEvidence.notes ?? '';
  const findings = [];
  if (/hallucinate/iu.test(notes)) findings.push('blank/emoji hallucination recorded');
  if (/digit/iu.test(notes)) findings.push('digit corruption recorded');
  if (/5000-character|long input|times out|truncated/iu.test(notes)) {
    findings.push('long-input defect recorded');
  }
  if (/not reachable|cannot invoke|unsupported-language/iu.test(notes)) {
    findings.push('service reachability gap recorded');
  }
  return findings.length ? findings.join('; ') : 'basic route benchmark only';
}

function humanReviewField(route) {
  const evidence = route.reviewEvidence
    ? `; evidence ${route.reviewEvidence.evidenceReference}`
    : '';
  return `${route.humanReviewStatus}${evidence}`;
}

function licenceField(route) {
  return `${route.licenceStatus.licence}; commercial=${route.licenceStatus.commercialUse}`;
}

function scopeField(route, scope) {
  return route.serviceScopes?.[scope] ?? 'missing';
}

function sttEvidence(sourceLanguage) {
  if (Object.hasOwn(GOOGLE_STT_CANDIDATE_LOCALES, sourceLanguage)) {
    return `Google Cloud Speech-to-Text V2 / Chirp routed live STT path present (${GOOGLE_STT_CANDIDATE_LOCALES[sourceLanguage]}); server configuration and live accuracy unqualified`;
  }
  if (sourceLanguage === 'pcm') {
    return 'pcm unresolved: no STT candidate is recorded by this framework';
  }
  if (['en', 'es'].includes(sourceLanguage)) {
    return 'existing Deepgram harness has clean TTS fixtures; rerun required';
  }
  return 'manual fixture corpus needed before accuracy can be claimed';
}

function ttsEvidence(targetLanguage) {
  if (['en', 'fr', 'es'].includes(targetLanguage)) return 'general TTS harness covers language';
  if (['ha', 'ig', 'yo', 'pcm'].includes(targetLanguage)) {
    return '9jaLingo technical TTS harness covers language; human listening still required';
  }
  if (targetLanguage === 'pt') return 'Portuguese TTS corpus/voice evidence missing';
  return 'missing';
}

function e2eEvidence(route) {
  const key = direction(route.sourceLanguage, route.targetLanguage);
  if (['en->fr', 'fr->en', 'en->es', 'es->en'].includes(key)) {
    return `available: node scripts/verify-language-pair.mjs ${route.sourceLanguage} ${route.targetLanguage}`;
  }
  return 'manual fixture/voice coverage needed before end-to-end command can prove this route';
}

function overallReadiness(route) {
  if (Object.values(route.serviceScopes).every((value) => value !== 'approved')) {
    return 'not ready - no approved service scope';
  }
  return 'requires CTO review before any use';
}

function evidenceCommands(routes) {
  const opusIds = routes
    .filter((route) => route.provider === 'opus-mt')
    .map((route) => `${route.sourceLanguage}-${route.targetLanguage}`)
    .join(',');
  return [
    '# Evidence command plan',
    '',
    'These commands are reusable collection commands. They are intentionally not run by this framework.',
    'Run them only on the appropriate qualification host with approved credentials already present.',
    'Credential values must not be printed or copied into reports.',
    '',
    '## Setup',
    '',
    '```bash',
    'mkdir -p /tmp/videofy-programme-language-surface',
    '```',
    '',
    '## Registry and current decisions',
    '',
    '```bash',
    'npm run test -w packages/translation-routes',
    'node scripts/qualification/programme-language-surface.mjs --check',
    '```',
    '',
    '## Machine translation route evidence',
    '',
    'All OPUS-MT directions, using the existing deployed-provider benchmark:',
    '',
    '```bash',
    `sudo node scripts/certify/opus.mjs --only ${opusIds} --out /tmp/videofy-programme-language-surface/opus-all-routes.json`,
    '```',
    '',
    'Single-direction rerun form:',
    '',
    '```bash',
    'sudo node scripts/certify/opus.mjs --only en-fr --out /tmp/videofy-programme-language-surface/opus-en-fr.json',
    '```',
    '',
    'Pidgin is intentionally not listed above because both pcm directions are `provider: unassigned` in the route registry. Do not manufacture a pcm MT result until a real translator is named.',
    '',
    '## STT evidence for live surfaces',
    '',
    '### Google STT configuration and wiring verification',
    '',
    'For Hausa, Igbo and Yoruba, treat Google Cloud Speech-to-Text V2 / Chirp as the candidate provider. This is not a live-accuracy qualification and not a production approval. Verify repo-side wiring first:',
    '',
    '```bash',
    'node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring',
    '```',
    '',
    'That check must find a language-routed live recognizer, Deepgram as the general/default route, Google STT for `ha-NG`, `ig-NG` and `yo-NG`, explicit refusal of unsupported source languages such as `pcm`, and non-secret configuration names before any live benchmark is commissioned. Google Translation is already integrated separately; do not use that fact as STT evidence.',
    '',
    'Read-only server configuration verification, names only and no secrets:',
    '',
    '```bash',
    firstManualCommand(),
    '```',
    '',
    'Deepgram support and accuracy collection through the shipped adapter:',
    '',
    '```bash',
    'sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs --language-support en,fr,es,pt,pcm --languages en,es --out /tmp/videofy-programme-language-surface/deepgram-live-stt.json',
    '```',
    '',
    'Do not read the Deepgram `language-support` result as accuracy. For ha/ig/yo, Deepgram refusal does not close the STT lane because Google STT V2 / Chirp is the candidate. For fr, pt and pcm, add approved spoken fixtures or a candidate decision before marking STT accuracy complete.',
    '',
    '## TTS evidence for live surfaces',
    '',
    'General TTS vendors, existing corpus only:',
    '',
    '```bash',
    'sudo node scripts/certify/tts.mjs --languages en,es,fr --samples 5 --out /tmp/videofy-programme-language-surface/tts-general.json',
    '```',
    '',
    'Nigerian specialist TTS:',
    '',
    '```bash',
    'sudo node scripts/certify/naijalingo.mjs --languages ha,ig,yo,pcm --samples 5 --json /tmp/videofy-programme-language-surface/naijalingo-tts.json',
    '```',
    '',
    'Portuguese TTS remains missing until a Portuguese corpus and selected voice are added to the TTS certification harness.',
    '',
    '## End-to-end STT -> translation -> TTS checks',
    '',
    'Existing deterministic language-pair verifier, for pairs already covered by source and target voices:',
    '',
    '```bash',
    'node scripts/verify-language-pair.mjs en fr',
    'node scripts/verify-language-pair.mjs fr en',
    'node scripts/verify-language-pair.mjs en es',
    'node scripts/verify-language-pair.mjs es en',
    '```',
    '',
    'Every other direction needs fixture and voice work before this verifier can prove the route. Do not substitute browser microphone tests for this proof.',
  ].join('\n');
}

function firstManualCommand() {
  return `ssh c7-claude 'cd /srv/videofy-prod/current && git rev-parse HEAD && node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring && sudo awk -F= '"'"'/^(STREAMING_TRANSCRIPTION_PROVIDER|DEEPGRAM_API_KEY|DEEPGRAM_MODEL|GOOGLE_STT_PROJECT_ID|GOOGLE_STT_LOCATION|GOOGLE_STT_RECOGNIZER|GOOGLE_STT_MODEL|GOOGLE_CLOUD_QUOTA_PROJECT)=/ {print $1"=<set>"}'"'"' /etc/videofy/media-ingest.env'`;
}

function matrixDocument(routes) {
  const rows = routes.map((route) => [
    direction(route.sourceLanguage, route.targetLanguage),
    `${LANGUAGE_LABELS[route.sourceLanguage]} to ${LANGUAGE_LABELS[route.targetLanguage]}`,
    `${route.provider} / ${route.modelId}`,
    routeSummary(route),
    humanReviewField(route),
    licenceField(route),
    latencyField(route),
    integrityField(route),
    scopeField(route, 'messaging'),
    scopeField(route, 'programme-live'),
    scopeField(route, 'call-live'),
  ]);

  const pipelineRows = routes.map((route) => [
    direction(route.sourceLanguage, route.targetLanguage),
    sttEvidence(route.sourceLanguage),
    route.technicalEvidence === null ? 'missing or unassigned' : 'route benchmark recorded; rerun required for fresh evidence',
    ttsEvidence(route.targetLanguage),
    e2eEvidence(route),
    overallReadiness(route),
  ]);

  return [
    '# Programme language-surface qualification matrix',
    '',
    'Base route registry: `packages/translation-routes/routes/translation-routes.seed.json`.',
    '',
    'This matrix is a qualification framework only. It does not approve a route, change a service scope, deploy code, or manufacture evidence. The authoritative registry remains fail-closed: every route is currently either `unapproved` or `refused` for every service scope.',
    '',
    '## Route decision matrix',
    '',
    table(
      [
        'Direction',
        'Languages',
        'Provider / model',
        'Translation evidence',
        'Human review',
        'Licence / commercial clearance',
        'Latency',
        'Integrity tests',
        'Messaging',
        'Programme-live',
        'Call-live',
      ],
      rows,
    ),
    '',
    '## Pipeline readiness matrix',
    '',
    'For live surfaces, one route is not enough. The source language must pass STT, the direction must pass translation, the target language must pass TTS, and the combined path must pass an end-to-end programme/call proof. A green technical row still does not replace human review or licence clearance.',
    '',
    'Google Cloud Translation is already integrated as a translation provider. Google Cloud STT is a separate candidate lane: for `ha-NG`, `ig-NG` and `yo-NG`, this framework names Google Cloud Speech-to-Text V2 / Chirp as the candidate and the repo-side routed live STT path is present. Deepgram remains the general live recognizer for existing supported source languages. Server configuration and live accuracy remain unqualified. Production approval remains false.',
    '',
    table(
      ['Direction', 'STT source evidence', 'Translation route evidence', 'TTS target evidence', 'End-to-end proof', 'Current readiness'],
      pipelineRows,
    ),
    '',
    '## Gate interpretation',
    '',
    '- `messaging`, `programme-live` and `call-live` are separate decisions from the registry. Approval in one must never imply approval in another.',
    '- `call-live: refused` is a decision, not a missing benchmark. Do not move it with automated evidence alone.',
    '- Hausa, Igbo and Yoruba STT are not provider-blocked here. Google Cloud Speech-to-Text V2 / Chirp is the candidate; repo-side wiring is present, while server configuration and live accuracy still need evidence.',
    '- Nigerian Pidgin (`pcm`) remains separate and unresolved unless repo evidence proves a specific STT candidate.',
    '- Human review, commercial clearance, latency and integrity evidence are separate fields. Completing one does not complete the others.',
    '- Programme readiness requires STT, translation, TTS and end-to-end evidence for the same direction and service surface.',
  ].join('\n');
}

function manualContinuation(routes) {
  const missingHuman = routes.map((route) => direction(route.sourceLanguage, route.targetLanguage));
  return [
    '# Manual continuation',
    '',
    'This is the stop point for the automated framework work. No production configuration, deployment, merge, route approval or hosted qualification has been performed.',
    '',
    '## What Zoe can complete manually',
    '',
    '1. Run the evidence command plan and store resulting JSON under an evidence ticket or a dated qualification folder.',
    '2. Arrange human review for every current direction:',
    '',
    missingHuman.map((key) => `   - ${key}`).join('\n'),
    '',
    '3. Complete licence/commercial clearance for every third-party model named by the registry. Apache-2.0 identifiers are not enough; obligations and redistribution requirements must be reviewed.',
    '4. Verify Google Cloud STT V2 / Chirp server configuration and non-secret configuration names before any ha-NG, ig-NG or yo-NG live benchmark.',
    '5. Add or approve missing fixture corpora before claiming STT accuracy for fr, pt, ha, ig, yo and pcm.',
    '6. Keep pcm separate and unresolved unless repo evidence proves a specific STT candidate.',
    '7. Add Portuguese TTS evidence before any route targeting pt can be considered live-ready.',
    '8. Extend the deterministic end-to-end verifier before using it for pt, ha, ig, yo or pcm directions.',
    '9. After evidence is gathered, update the registry only through a reviewed route-document change. Do not approve scopes by editing generated framework docs.',
    '',
    '## Google STT manual verification before live benchmarks',
    '',
    'Google Translation and Google STT are separate provider surfaces. The existing Google translation integration does not prove STT readiness. Before any live STT run for Hausa, Igbo or Yoruba, verify all of the following:',
    '',
    '- The deployed media-ingest runtime is at a SHA containing the Google Cloud Speech-to-Text V2 / Chirp adapter and `deepgram-google-stt` language-routed selector.',
    '- Non-secret configuration names exist for the resource project, location and recognizer/model selection.',
    '- ADC/quota-project handling is explicitly compatible with the existing Google authorization path.',
    '- The configured route table sends `ha-NG`, `ig-NG` and `yo-NG` to Google STT, keeps `en`, `es`, `fr` and `pt` on Deepgram, and refuses unsupported source languages such as `pcm`.',
    '- No result is written as production approval; live accuracy remains unqualified until a benchmark and human review are complete.',
    '',
    '## Exact first manual command',
    '',
    '```bash',
    firstManualCommand(),
    '```',
    '',
    'That command is read-only: it prints the deployed SHA, runs the repo-side wiring check on the deployed checkout, and prints only whether the non-secret Google STT configuration names are set. It does not print credentials and does not run a live benchmark.',
  ].join('\n');
}

function generatedFiles(routes) {
  return new Map([
    ['QUALIFICATION_MATRIX.md', `${matrixDocument(routes)}\n`],
    ['EVIDENCE_COMMANDS.md', `${evidenceCommands(routes)}\n`],
    ['MANUAL_CONTINUATION.md', `${manualContinuation(routes)}\n`],
  ]);
}

function collectFiles(dir, predicate, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      collectFiles(path, predicate, found);
    } else if (predicate(path)) {
      found.push(path);
    }
  }
  return found;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function runGoogleSttWiringCheck() {
  const mediaIngest = join(ROOT, 'services', 'media-ingest', 'src');
  const aiRegistry = join(ROOT, 'services', 'ai-registry', 'src');
  const googleProviderDir = join(mediaIngest, 'providers', 'google');
  const googleFiles = collectFiles(
    googleProviderDir,
    (path) => /\.(ts|tsx|js|mjs)$/u.test(path),
  );
  const allRelevantFiles = [
    ...collectFiles(mediaIngest, (path) => /\.(ts|tsx|js|mjs)$/u.test(path)),
    ...collectFiles(aiRegistry, (path) => /\.(ts|tsx|js|mjs)$/u.test(path)),
  ];
  const relevantText = allRelevantFiles.map(readIfExists).join('\n');
  const googleText = googleFiles.map(readIfExists).join('\n');
  const checks = [
    {
      label: 'Google Translation integration remains present',
      ok:
        /providerId:\s*'google-cloud'/u.test(relevantText) &&
        /translation:\s*\{\s*requestResponse:\s*'yes'/u.test(relevantText),
    },
    {
      label: 'Google STT adapter or provider file exists',
      ok:
        googleFiles.some((path) => /stt|speech|transcription/iu.test(path)) ||
        /Google.*(Speech|STT|Transcription)|Speech-to-Text|Chirp/iu.test(googleText),
    },
    {
      label: 'Google STT V2 / Chirp candidate is named in repo wiring',
      ok: /Chirp|Speech-to-Text V2|speech-to-text.*v2|recognizers/iu.test(relevantText),
    },
    {
      label: 'Deepgram remains the default/general live recognizer',
      ok:
        /streamingTranscriptionProvider:\s*[\s\S]*'deepgram-nova'[\s\S]*'deepgram-flux'[\s\S]*'deepgram-google-stt'/u.test(
          relevantText,
        ) &&
        /case\s+'deepgram-nova'/u.test(relevantText) &&
        /case\s+'deepgram-flux'/u.test(relevantText) &&
        /case\s+'deepgram-google-stt'/u.test(relevantText) &&
        /DEEPGRAM_STT_SOURCE_LANGUAGES\s*=\s*\[\s*'en'\s*,\s*'es'\s*,\s*'fr'\s*,\s*'pt'\s*\]/u.test(
          relevantText,
        ),
    },
    {
      label: 'ha-NG, ig-NG and yo-NG route to Google STT',
      ok:
        /GOOGLE_STT_SOURCE_LANGUAGES\s*=\s*\[\s*'ha'\s*,\s*'ig'\s*,\s*'yo'\s*\]/u.test(
          relevantText,
        ) &&
        /createLanguageRoutedTranscriptionProvider/u.test(relevantText) &&
        /google\.openStream|options\.google/u.test(relevantText),
    },
    {
      label: 'Unsupported source languages refuse instead of falling back',
      ok:
        /UNSUPPORTED_STT_SOURCE_LANGUAGES\s*=\s*\[\s*'pcm'\s*\]/u.test(relevantText) &&
        /not in the qualified routing table|unsupported\/unqualified|source language is required/u.test(
          relevantText,
        ),
    },
    {
      label: 'Nigerian Google STT candidate locales are configured or declared',
      ok: ['ha-NG', 'ig-NG', 'yo-NG'].every((locale) => relevantText.includes(locale)),
    },
    {
      label: 'Non-secret Google STT config names are present',
      ok: [
        'GOOGLE_STT_PROJECT_ID',
        'GOOGLE_STT_LOCATION',
        'GOOGLE_STT_RECOGNIZER',
        'GOOGLE_STT_MODEL',
      ].every((name) => relevantText.includes(name)),
    },
  ];
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'MISSING'}  ${check.label}`);
  }
  const ok = checks.every((check) => check.ok);
  if (!ok) {
    console.log('');
    console.log(
      'Google STT remains a candidate only. Do not benchmark or approve ha-NG, ig-NG or yo-NG STT until the missing wiring/configuration checks are closed.',
    );
    process.exit(1);
  }
  console.log('');
  console.log('Google STT wiring/configuration is statically present; live accuracy remains unqualified.');
}

function writeFiles(files) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) {
    writeFileSync(join(outDir, name), content, 'utf8');
  }
}

function checkFiles(files) {
  const problems = [];
  for (const [name, expected] of files) {
    const path = join(outDir, name);
    if (!existsSync(path)) {
      problems.push(`${path} is missing`);
      continue;
    }
    const actual = readFileSync(path, 'utf8');
    if (actual !== expected) problems.push(`${path} is not up to date`);
  }
  if (problems.length > 0) fail(problems.join('\n'));
  console.log(`programme language-surface framework ok (${files.size} files, 14 directions)`);
}

const document = loadDocument();
const routes = validateRoutes(document);
const files = generatedFiles(routes);

if (printCommands) {
  console.log(evidenceCommands(routes));
}

if (printFirstCommand) {
  console.log(firstManualCommand());
}

if (checkGoogleSttWiring) {
  runGoogleSttWiringCheck();
}

if (writeMode) {
  writeFiles(files);
  console.log(`wrote ${files.size} files to ${outDir}`);
}

if (checkMode) {
  checkFiles(files);
}

if (!writeMode && !checkMode && !printCommands && !printFirstCommand && !checkGoogleSttWiring) {
  console.log('Usage: node scripts/qualification/programme-language-surface.mjs --write|--check|--print-evidence-commands|--print-first-manual-command|--check-google-stt-wiring');
}
