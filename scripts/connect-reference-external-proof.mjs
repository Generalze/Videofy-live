#!/usr/bin/env node
/**
 * Purity guard #3 (P6.5 evidence): Connect Reference must build and pass its tests with
 * the two public SDKs installed FROM TARBALLS in a directory outside the
 * workspace — proving monorepo resolution is never load-bearing. An actual
 * customer has tarballs (or a registry) and nothing else.
 *
 * Run: node scripts/connect-reference-external-proof.mjs   (exit 0 = proven)
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const started = Date.now();
const log = (msg) => console.log(`== ${msg}`);
const fail = (msg) => { console.error(`!! FAILURE | ${msg}`); process.exit(1); };
const run = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'ref-external-proof-'));
try {
  // 1. Pack both SDKs from the workspace.
  log('npm pack the public SDKs');
  const tarballs = [];
  for (const pkg of ['packages/connect-sdk', 'packages/connect-server-sdk']) {
    // --ignore-scripts keeps prepack build banners out of the JSON stream;
    // the dist must therefore already exist (same rule as connect-pack-smoke).
    if (!existsSync(join(repo, pkg, 'dist', 'index.d.ts'))) {
      fail(`${pkg}/dist missing — build the SDK first (npm run build -w <pkg>)`);
    }
    const out = run(`npm pack --json --ignore-scripts --pack-destination "${work}"`, join(repo, pkg));
    const name = JSON.parse(out)[0].filename;
    tarballs.push(join(work, name));
  }

  // 2. Overlay the two Connect Reference packages (sources only).
  log('overlay Connect Reference sources outside the workspace');
  const overlay = join(work, 'connect-reference');
  for (const [src, dst] of [
    ['services/connect-reference-server', 'server'],
    ['apps/connect-reference-web', 'web'],
  ]) {
    cpSync(join(repo, src), join(overlay, dst), {
      recursive: true,
      filter: (p) => !/node_modules|dist|\.vite/.test(p),
    });
  }

  // 3. Per package: strip workspace-flavoured scripts, install public deps +
  //    the SDK tarballs by file path, then typecheck and test directly.
  for (const dir of ['server', 'web']) {
    const cwd = join(overlay, dir);
    const manifestPath = join(cwd, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Replace @videofy/* workspace specifiers with the tarball paths.
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name] of Object.entries(manifest[field] ?? {})) {
        if (name === '@videofy/connect') manifest[field][name] = `file:${tarballs[0]}`;
        if (name === '@videofy/server-sdk') manifest[field][name] = `file:${tarballs[1]}`;
      }
    }
    // Tooling the overlay run needs locally (workspace hoisting is gone).
    manifest.devDependencies = {
      ...manifest.devDependencies,
      typescript: '~5.9.3',
      vitest: '^2.1.9',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    log(`${dir}: npm install (tarball SDKs, no workspace)`);
    run('npm install --no-audit --no-fund', cwd);

    // Leak check: nothing @videofy-live/* may exist anywhere.
    const leaks = [];
    const scan = (p) => {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name === '@videofy-live') leaks.push(join(p, entry.name));
        if (entry.isDirectory() && entry.name === 'node_modules') scan(join(p, entry.name));
        else if (entry.isDirectory() && p.endsWith('node_modules')) {
          const nested = join(p, entry.name, 'node_modules');
          if (existsSync(nested)) scan(nested);
        }
      }
    };
    scan(join(cwd, 'node_modules'));
    if (leaks.length > 0) fail(`${dir}: internal packages leaked: ${leaks.join(', ')}`);
    log(`${dir}: zero @videofy-live/* in the external install`);

    log(`${dir}: typecheck against tarball types`);
    run('npx tsc --noEmit', cwd);

    log(`${dir}: vitest against tarball runtime`);
    const out = run('npx vitest run --reporter=basic 2>&1 || npx vitest run', cwd);
    if (!/passed/.test(out)) fail(`${dir}: tests did not pass in the overlay`);

    if (dir === 'web') {
      // The bundle is what actually ships to a browser: build it the way the
      // product does and scan the emitted bytes. Only the internal package
      // scope and the project-key prefix are banned here — the SDK's own
      // bundled internals legitimately implement resume/ids under the hood.
      log('web: vite build against the tarball SDK');
      run('npx vite build', cwd);
      const bundleLeaks = [];
      const scanDist = (p) => {
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          const full = join(p, entry.name);
          if (entry.isDirectory()) { scanDist(full); continue; }
          const text = readFileSync(full, 'utf8');
          for (const needle of ['@videofy-live/', 'vfk_']) {
            if (text.includes(needle)) bundleLeaks.push(`${needle} in ${entry.name}`);
          }
        }
      };
      scanDist(join(cwd, 'dist'));
      if (bundleLeaks.length > 0) fail(`web bundle leaks: ${bundleLeaks.join(', ')}`);
      log('web: shipped bundle clean of internal scope and project keys');
    }
  }

  log(`REF-EXTERNAL-PROOF OK (${Date.now() - started} ms)`);
} catch (error) {
  const detail = (error.stderr || error.stdout || String(error)).slice(-1200);
  fail(`external proof failed:\n${detail}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
