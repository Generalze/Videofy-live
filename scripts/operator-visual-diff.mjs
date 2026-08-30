#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Operator console visual diff against the golden masters.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR PREMIUM UI GOLDEN
 * MASTERS: the PNGs in docs/design/VIDEOFY OPERATOR UI AND IMPLEMENTATION
 * CONTRACT/ are immutable visual acceptance references at 1586 x 992;
 * "implement, render, capture, pixel-diff, correct, repeat". This is the
 * capture-and-diff half of that loop, so the number a page is judged by is
 * measured rather than eyeballed.
 *
 * IT IS A GATE (founder directive, 30 Aug 2026, SS13 OPERATOR GOLDEN-MASTER
 * CORRECTION): "The visual harness must become an enforcement gate ... EACH
 * PAGE <= 1.0% mismatch, not an average ... Current default of
 * maxMismatch=100 is unacceptable." So --max-mismatch now defaults to 1.0,
 * is applied per page, and any page above it fails the command.
 *
 * WHAT IT RENDERS. By default the deterministic fixture entry
 * (apps/operator-web/visual/), not the app. The app has no gateway, ingest or
 * account service behind it here, so every capture used to be the signed-out,
 * disconnected console -- 0 viewers, Waiting chips, disabled controls, empty
 * catalogue -- diffed against masters drawn with sample state. Most of the
 * mismatch was that difference and none of it was a layout defect. The
 * fixture entry mounts the SAME shell and page components with state that
 * does not move between runs, so the number is about geometry, typography
 * and spacing. Pass --app to capture the real console instead, which is
 * still the honest way to see what an operator sees.
 *
 * The fixtures are test-only and cannot reach production: nothing under
 * apps/operator-web/src imports them and nothing there branches on a fixture
 * flag. That is asserted below, before anything is built, as well as by
 * src/fixtureIsolation.test.ts -- a leak should fail the harness that
 * benefits from it, not only the test suite.
 *
 * What it does:
 *   1. asserts the fixtures have not leaked into src/;
 *   2. builds the fixture entry (or the app, with --app); skip with
 *      --no-build;
 *   3. serves the build from an in-process static server on a free port,
 *      with an SPA fallback to index.html so the hash router loads on every
 *      route;
 *   4. for each page, launches headless Microsoft Edge at 1586 x 992 and
 *      screenshots #/<page>;
 *   5. compares the capture with the reference PNG through pixelmatch and
 *      writes <page>.actual.png, <page>.diff.png and summary.json;
 *   6. prints a PASS/FAIL table against the limit and exits non-zero when any
 *      page breaches it.
 *
 * HONEST SCOPE: fonts are whatever the machine has. The masters were drawn
 * with a geometric sans and no webfont is bundled, so some of the remaining
 * mismatch is type rendering rather than layout, and it is not zero.
 *
 * Usage:
 *   node scripts/operator-visual-diff.mjs [--app] [--no-build] [--out <dir>]
 *        [--max-mismatch <pct>] [--threshold <0..1>] [--page <id>]...
 *        [--edge <path>] [--keep-server] [--baseline]
 *
 * --baseline records the numbers without failing the command. It is for
 * measuring a lane's starting point, never for landing work that breaches
 * the limit; the output says so loudly and summary.json records it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pixelmatch = require('pixelmatch');
// pixelmatch carries its own pngjs; resolve it from there so the two agree on a PNG.
const { PNG } = createRequire(require.resolve('pixelmatch'))('pngjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'operator-web');
const APP_DIST_DIR = join(APP_DIR, 'dist');
const FIXTURE_DIST_DIR = join(APP_DIR, 'dist-visual');
const SRC_DIR = join(APP_DIR, 'src');
const REFERENCE_DIR = join(REPO_ROOT, 'docs', 'design', 'VIDEOFY OPERATOR UI AND IMPLEMENTATION CONTRACT');
const DEFAULT_OUT = join(APP_DIR, 'visual');
const DEFAULT_EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const VIEWPORT = { width: 1586, height: 992 };

/** Route id -> reference file. The ids are the hash routes in router.ts. */
const PAGES = [
  { id: 'overview', route: '#/overview', reference: '01-overview-reference.png' },
  { id: 'source', route: '#/source', reference: '02-source-reference.png' },
  { id: 'languages', route: '#/languages', reference: '03-languages-reference.png' },
  { id: 'audio', route: '#/audio', reference: '04-audio-voices-reference.png' },
  { id: 'live', route: '#/live', reference: '10-live-control-reference.png' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function parseArgs(argv) {
  const options = {
    build: true,
    out: DEFAULT_OUT,
    /*
     * The gate. Per page, not an average: a run where four pages are perfect
     * and one is 4% must fail, and a mean would have passed it.
     */
    maxMismatch: 1,
    threshold: 0.1,
    pages: [],
    edge: DEFAULT_EDGE,
    keepServer: false,
    baseline: false,
    target: 'fixture',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === '--no-build') options.build = false;
    else if (arg === '--app') options.target = 'app';
    else if (arg === '--baseline') options.baseline = true;
    else if (arg === '--out') options.out = resolve(next());
    else if (arg === '--max-mismatch') options.maxMismatch = Number(next());
    else if (arg === '--threshold') options.threshold = Number(next());
    else if (arg === '--page') options.pages.push(next());
    else if (arg === '--edge') options.edge = next();
    else if (arg === '--keep-server') options.keepServer = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'node scripts/operator-visual-diff.mjs [--app] [--no-build] [--out <dir>] [--max-mismatch <pct>] [--threshold <0..1>] [--page <id>]... [--edge <path>] [--keep-server] [--baseline]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!Number.isFinite(options.maxMismatch) || options.maxMismatch < 0) throw new Error('--max-mismatch must be a percentage.');
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) throw new Error('--threshold must be between 0 and 1.');
  return options;
}

/** The app's Vite base, read from its config; '/' when none is set. */
function readViteBase() {
  const config = readFileSync(join(APP_DIR, 'vite.config.ts'), 'utf8');
  const match = config.match(/\bbase\s*:\s*['"`]([^'"`]+)['"`]/);
  const base = match?.[1] ?? '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** Every .ts/.tsx under a directory. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Refuse to run if the fixtures have leaked into the console's own source.
 *
 * This is checked HERE, not only in the test suite, because the harness is
 * the thing that benefits from a leak: a fixture reached from src/ would
 * make these numbers better and the product worse. The harness that reports
 * the number is the right place to refuse it.
 */
function assertFixturesAreIsolated() {
  const importsVisual = /\bfrom\s+['"][^'"]*\bvisual\/[^'"]*['"]|\bimport\s*\(\s*['"][^'"]*\bvisual\/[^'"]*['"]/;
  const fixtureFlag = /\b(?:VITE_)?(?:USE_)?(?:FIXTURES?|VISUAL_FIXTURES?|MOCK_STATE|GOLDEN_MASTER)\b/;
  const offenders = [];
  for (const file of sourceFiles(SRC_DIR)) {
    if (file.endsWith('fixtureIsolation.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    if (importsVisual.test(text)) offenders.push(`${file}: imports visual/`);
    if (fixtureFlag.test(text)) offenders.push(`${file}: branches on a fixture flag`);
  }
  if (offenders.length > 0) {
    throw new Error(
      `The visual fixtures have leaked into apps/operator-web/src. They are test-only and production must be incapable of reading them:\n  ${offenders.join('\n  ')}`,
    );
  }
}

function build(target) {
  if (target === 'app') {
    console.log('Building apps/operator-web (the real console) ...');
    const result = spawnSync('npm', ['run', 'build', '-w', 'apps/operator-web'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) throw new Error(`The operator-web build failed with status ${result.status}.`);
    return;
  }
  console.log('Building the deterministic fixture entry (apps/operator-web/visual) ...');
  // Typecheck the app and the fixtures together first: a fixture that no
  // longer matches a page's props must fail here, not render half a page.
  const typecheck = spawnSync('npm', ['run', 'typecheck', '-w', 'apps/operator-web'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  if (typecheck.status !== 0) throw new Error(`Typecheck failed with status ${typecheck.status}; the fixtures no longer match the components.`);
  const result = spawnSync('npm', ['run', 'build:visual', '-w', 'apps/operator-web'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`The fixture build failed with status ${result.status}.`);
}

/** A static server for `distDir` under `base`, falling back to index.html for the SPA. */
function serve(base, distDir) {
  const index = join(distDir, 'index.html');
  if (!existsSync(index)) throw new Error(`No build at ${index}. Run without --no-build first.`);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(base)) {
      response.writeHead(302, { location: base });
      response.end();
      return;
    }
    pathname = pathname.slice(base.length);
    let file = resolve(distDir, pathname);
    if (!file.startsWith(distDir)) file = index;
    if (!existsSync(file) || statSync(file).isDirectory()) file = index;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(readFileSync(file));
  });
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Screenshot one URL with headless Edge, waiting for the file to land. */
async function capture(edge, url, outFile, profileDir) {
  rmSync(outFile, { force: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    /*
     * NOT --virtual-time-budget. With it, this page never produced a
     * screenshot: the console's socket.io client keeps a reconnect timer
     * pending, virtual time never reaches idle, and Edge waits forever.
     * The console paints its first frame before the load event (the bundle
     * is the last resource), so the plain post-load capture is complete;
     * --timeout is a ceiling, not a wait.
     */
    '--timeout=5000',
    `--screenshot=${outFile}`,
    url,
  ];
  const child = spawn(edge, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let exitCode = null;
  const exited = new Promise((resolvePromise) =>
    child.on('exit', (code) => {
      exitCode = code;
      resolvePromise();
    }),
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(outFile) && statSync(outFile).size > 0) {
      await exited;
      return;
    }
    if (exitCode !== null) break;
    await sleep(200);
  }
  // Kill the whole tree: a renderer left behind keeps the profile locked and the next launch waiting.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
  const tail = stderr.trim().split(/\r?\n/).slice(-5).join('\n');
  throw new Error(`Edge produced no screenshot for ${url}${exitCode === null ? ' within 30s' : ` (exit ${exitCode})`}.${tail ? `\n${tail}` : ''}`);
}

function readPng(file) {
  return PNG.sync.read(readFileSync(file));
}

/** Copy `png` onto a canvas of the reference size so pixelmatch sees equal dimensions. */
function fitTo(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const canvas = new PNG({ width, height });
  for (let y = 0; y < Math.min(height, png.height); y++) {
    for (let x = 0; x < Math.min(width, png.width); x++) {
      const from = (y * png.width + x) * 4;
      const to = (y * width + x) * 4;
      canvas.data[to] = png.data[from];
      canvas.data[to + 1] = png.data[from + 1];
      canvas.data[to + 2] = png.data[from + 2];
      canvas.data[to + 3] = png.data[from + 3];
    }
  }
  return canvas;
}

function compare(actualFile, referenceFile, diffFile, threshold) {
  const reference = readPng(referenceFile);
  const rawActual = readPng(actualFile);
  const actual = fitTo(rawActual, reference.width, reference.height);
  const diff = new PNG({ width: reference.width, height: reference.height });
  const differing = pixelmatch(actual.data, reference.data, diff.data, reference.width, reference.height, { threshold, includeAA: false });
  writeFileSync(diffFile, PNG.sync.write(diff));
  const total = reference.width * reference.height;
  return {
    differing,
    total,
    mismatchPct: Number(((differing / total) * 100).toFixed(2)),
    actualSize: `${rawActual.width}x${rawActual.height}`,
    referenceSize: `${reference.width}x${reference.height}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.edge)) throw new Error(`Microsoft Edge not found at ${options.edge}; pass --edge <path>.`);
  const pages = options.pages.length === 0 ? PAGES : PAGES.filter((page) => options.pages.includes(page.id));
  if (pages.length === 0) throw new Error(`No page matched ${options.pages.join(', ')}. Known: ${PAGES.map((page) => page.id).join(', ')}.`);

  assertFixturesAreIsolated();
  if (options.build) build(options.target);
  // The fixture entry builds with a relative base and is served at the root;
  // the app carries whatever base its own config sets.
  const base = options.target === 'app' ? readViteBase() : '/';
  const distDir = options.target === 'app' ? APP_DIST_DIR : FIXTURE_DIST_DIR;
  const { server, origin } = await serve(base, distDir);
  mkdirSync(options.out, { recursive: true });
  // A private, throwaway Edge profile beside the output (gitignored). A
  // profile under the system temp directory is refused by some sandboxes,
  // and sharing the person's real profile would hand the capture to an
  // already-running Edge, which exits without writing anything.
  const profileRoot = join(options.out, '.edge-profile');
  try {
    rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A previous run's Edge may still hold a lock file; each capture below uses its own subdirectory anyway.
  }
  mkdirSync(profileRoot, { recursive: true });

  const results = [];
  try {
    for (const page of pages) {
      const referenceFile = join(REFERENCE_DIR, page.reference);
      if (!existsSync(referenceFile)) throw new Error(`Reference missing: ${referenceFile}`);
      const actualFile = join(options.out, `${page.id}.actual.png`);
      const diffFile = join(options.out, `${page.id}.diff.png`);
      const url = `${origin}${base}${page.route}`;
      process.stdout.write(`Capturing ${page.id} (${url}) ... `);
      // One profile per capture attempt: a profile still being released by the
      // previous Edge makes the next launch attach to it and never write a
      // screenshot. That is also why a capture that produced nothing is tried
      // once more with a fresh profile before the run is failed.
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const profileDir = join(profileRoot, `${page.id}-${process.pid}-${attempt}`);
        mkdirSync(profileDir, { recursive: true });
        try {
          await capture(options.edge, url, actualFile, profileDir);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 1) process.stdout.write('retrying ... ');
        }
      }
      if (lastError !== null) throw lastError;
      const result = compare(actualFile, referenceFile, diffFile, options.threshold);
      console.log(`${result.mismatchPct}% mismatch`);
      results.push({ page: page.id, route: page.route, reference: page.reference, ...result, actual: actualFile, diff: diffFile });
    }
  } finally {
    if (!options.keepServer) server.close();
    try {
      // Edge releases its profile a moment after exiting; retry rather than fail the run over a lock.
      rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`Could not remove the throwaway Edge profile at ${profileRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const summary = {
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    threshold: options.threshold,
    /* The gate, recorded with the numbers so a summary.json can be read on its own. */
    maxMismatchPct: options.maxMismatch,
    enforcement: options.baseline ? 'baseline (recorded, not enforced)' : 'per page, fails the command',
    rendered: options.target === 'app' ? 'the real console' : 'the deterministic fixture entry',
    base,
    pages: results.map(({ page, route, reference, differing, total, mismatchPct, actualSize, referenceSize }) => ({
      page,
      route,
      reference,
      differingPixels: differing,
      totalPixels: total,
      mismatchPct,
      actualSize,
      referenceSize,
      /* Per page against the limit. There is deliberately no average anywhere. */
      verdict: mismatchPct <= options.maxMismatch ? 'PASS' : 'FAIL',
      pass: mismatchPct <= options.maxMismatch,
    })),
  };
  writeFileSync(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('');
  console.table(
    summary.pages.map(({ page, reference, mismatchPct, actualSize, verdict }) => ({
      page,
      reference,
      'mismatch %': mismatchPct,
      'limit %': options.maxMismatch,
      captured: actualSize,
      verdict,
    })),
  );
  console.log(`Rendered: ${summary.rendered}${options.target === 'app' ? '' : ' (apps/operator-web/visual)'}`);
  console.log(`Output: ${options.out} (summary.json, <page>.actual.png, <page>.diff.png)`);

  const failing = summary.pages.filter((page) => !page.pass);
  if (failing.length === 0) {
    console.log(`All ${summary.pages.length} page(s) at or under ${options.maxMismatch}% mismatch.`);
    return;
  }
  const detail = failing.map((page) => `${page.page} ${page.mismatchPct}%`).join(', ');
  if (options.baseline) {
    console.warn('');
    console.warn(`BASELINE RUN -- NOT ENFORCED. ${failing.length} page(s) above ${options.maxMismatch}%: ${detail}.`);
    console.warn('The numbers are recorded and the command is passing because --baseline was given.');
    console.warn('Run without --baseline before landing: the gate is per page and these breach it.');
    return;
  }
  console.error('');
  console.error(`FAIL: ${failing.length} page(s) above the ${options.maxMismatch}% limit: ${detail}.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
