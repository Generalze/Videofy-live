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
 * What it does:
 *   1. builds apps/operator-web (skip with --no-build);
 *   2. serves apps/operator-web/dist from an in-process static server on a
 *      free port, under the app's configured Vite base (SPA fallback to
 *      index.html, so the hash router loads on every route);
 *   3. for each page, launches headless Microsoft Edge at 1586 x 992 and
 *      screenshots #/<page>;
 *   4. compares the capture with the reference PNG through pixelmatch and
 *      writes <page>.actual.png, <page>.diff.png and summary.json;
 *   5. prints a table of mismatch percentages and exits non-zero when any
 *      page is above --max-mismatch.
 *
 * HONEST SCOPE: no gateway, ingest or account service is running, so every
 * capture is the console in its disconnected state -- which is precisely the
 * state the masters depict ("Gateway Disconnected", "Channel not set up" in
 * place of a sample avatar). Fonts are whatever the machine has; the masters
 * were drawn with a geometric sans and no webfont is bundled, so a few
 * percent of the mismatch is type rendering, not layout.
 *
 * Usage:
 *   node scripts/operator-visual-diff.mjs [--no-build] [--out <dir>]
 *        [--max-mismatch <pct>] [--threshold <0..1>] [--page <id>]...
 *        [--edge <path>] [--keep-server]
 *
 * --max-mismatch defaults to 100 (informational) until the page lanes land;
 * lower it per page as each reaches its visual pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const DIST_DIR = join(APP_DIR, 'dist');
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
  const options = { build: true, out: DEFAULT_OUT, maxMismatch: 100, threshold: 0.1, pages: [], edge: DEFAULT_EDGE, keepServer: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === '--no-build') options.build = false;
    else if (arg === '--out') options.out = resolve(next());
    else if (arg === '--max-mismatch') options.maxMismatch = Number(next());
    else if (arg === '--threshold') options.threshold = Number(next());
    else if (arg === '--page') options.pages.push(next());
    else if (arg === '--edge') options.edge = next();
    else if (arg === '--keep-server') options.keepServer = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/operator-visual-diff.mjs [--no-build] [--out <dir>] [--max-mismatch <pct>] [--threshold <0..1>] [--page <id>]... [--edge <path>]');
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

function build() {
  console.log('Building apps/operator-web ...');
  const result = spawnSync('npm', ['run', 'build', '-w', 'apps/operator-web'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`The operator-web build failed with status ${result.status}.`);
}

/** A static server for dist under `base`, falling back to index.html for the SPA. */
function serve(base) {
  const index = join(DIST_DIR, 'index.html');
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
    let file = resolve(DIST_DIR, pathname);
    if (!file.startsWith(DIST_DIR)) file = index;
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

  if (options.build) build();
  const base = readViteBase();
  const { server, origin } = await serve(base);
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
    maxMismatchPct: options.maxMismatch,
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
      pass: mismatchPct <= options.maxMismatch,
    })),
  };
  writeFileSync(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('');
  console.table(summary.pages.map(({ page, reference, mismatchPct, actualSize, pass }) => ({ page, reference, 'mismatch %': mismatchPct, captured: actualSize, pass })));
  console.log(`Output: ${options.out} (summary.json, <page>.actual.png, <page>.diff.png)`);

  const failing = summary.pages.filter((page) => !page.pass);
  if (failing.length > 0) {
    console.error(`${failing.length} page(s) above --max-mismatch ${options.maxMismatch}%: ${failing.map((page) => page.page).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
