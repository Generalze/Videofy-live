#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Does this candidate satisfy the rules THIS environment applies at startup?
 *
 * WHY THIS EXISTS AT ALL. On 2026-09-05 a fully certified staging wave was
 * deployed to production and the service refused to boot on
 * `TRANSLATION_ROUTES_DOCUMENT is required in production`. The guard sits
 * inside an `isProduction` branch, and staging runs `C7_ENVIRONMENT=staging`,
 * so staging had never evaluated that line and never could. The certification
 * was real and proved nothing about it.
 *
 * The only thing that finds a production-only guard is production
 * configuration. So the candidate's own `loadConfig` is called with the real
 * environment file, before anything points at the candidate.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, because a preflight that joins the live
 * system is worse than no preflight:
 *
 *   - it imports `config.js`, never `index.js`, so nothing starts
 *   - it binds no port and answers no request
 *   - it opens no socket to the gateway and is never routed to
 *   - it calls no provider, so it cannot spend money
 *   - it opens no database connection and runs no migration
 *   - it writes nothing anywhere
 *
 * It reads configuration, applies the rules, and exits. That is the whole
 * program.
 *
 * AND IT NEVER PRINTS A VALUE. The environment it loads holds provider keys
 * and the auth secret. Everything reported here is a NAME, a boolean, or a
 * count -- because a preflight whose output has to be redacted before it can
 * be pasted into a review is a preflight nobody will run.
 *
 *   node preflight-config.mjs <candidate-dir> <env-file>
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [, , candidateDir, envFile] = process.argv;

if (!candidateDir || !envFile) {
  console.error('usage: preflight-config.mjs <candidate-dir> <env-file>');
  process.exit(64);
}

/**
 * The environment file as systemd would apply it.
 *
 * `EnvironmentFile=` is KEY=VALUE, one per line, `#` comments, and no shell
 * expansion -- so this parser does no expansion either. Interpreting `$X` here
 * would preflight a configuration the service will never see.
 */
function readEnvFile(path) {
  const applied = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    process.env[key] = line.slice(eq + 1);
    applied.push(key);
  }
  return applied;
}

let applied;
try {
  applied = readEnvFile(envFile);
} catch (error) {
  console.error(`PREFLIGHT FAILED: cannot read ${envFile}: ${error.message}`);
  process.exit(1);
}
// NAMES ONLY. Never the values.
console.log(`preflight: ${applied.length} environment keys applied from the real environment file`);

const configModule = join(candidateDir, 'services/media-ingest/dist/services/media-ingest/src/config.js');

let loadConfig;
try {
  ({ loadConfig } = await import(pathToFileURL(configModule).href));
} catch (error) {
  console.error(`PREFLIGHT FAILED: cannot load the candidate's config module.`);
  console.error(`  ${configModule}`);
  console.error(`  ${error.message}`);
  console.error('  A candidate whose configuration cannot even be imported must not be published.');
  process.exit(1);
}

if (typeof loadConfig !== 'function') {
  console.error('PREFLIGHT FAILED: the candidate exports no loadConfig; this preflight would prove nothing.');
  process.exit(1);
}

try {
  const config = loadConfig();
  /*
   * Report the SHAPE of what was accepted, so a human reading a deploy log can
   * see which providers this release would run with -- and see a `mock` before
   * it reaches production rather than afterwards.
   */
  const summary = {
    environment: process.env['C7_ENVIRONMENT'] ?? '(unset)',
    transcription: config.transcriptionProvider ?? '(unset)',
    synthesis: config.textToSpeechProvider ?? '(unset)',
    translation: config.translationProvider ?? '(unset)',
    streamingTranscription: config.streamingTranscriptionProvider ?? '(unset)',
    streamingSynthesis: config.streamingSynthesisProvider ?? '(unset)',
  };
  for (const [role, value] of Object.entries(summary)) {
    console.log(`  ${role}: ${value}`);
  }

  /*
   * A RUNNING SERVICE THAT FABRICATES OUTPUT IS WORSE THAN A STOPPED ONE.
   * `loadConfig` already refuses `demo` and `development-demo` in production;
   * `mock` is refused here for every environment this preflight runs in,
   * because the preflight only ever runs against a real environment file.
   */
  const fabricating = Object.entries(summary).filter(([, v]) => v === 'mock' || v === 'demo');
  if (fabricating.length > 0) {
    console.error('PREFLIGHT FAILED: a fabricating provider is configured:');
    for (const [role, value] of fabricating) console.error(`  ${role} = ${value}`);
    process.exit(1);
  }

  console.log('preflight: the candidate satisfies this environment\'s startup configuration rules');
  process.exit(0);
} catch (error) {
  console.error('PREFLIGHT FAILED: the candidate refuses this environment\'s configuration.');
  console.error(`  ${error.message}`);
  console.error('  This is the check staging cannot perform: the rule lives behind an');
  console.error('  isProduction branch. Nothing has been published; the running release is untouched.');
  process.exit(1);
}
