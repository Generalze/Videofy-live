/** @author masterzee001 */
/**
 * The Connect Reference purity guard (P6.5 evidence). This app is built
 * EXACTLY as an outside customer would build one: on the public Videofy
 * surfaces only. Its sources therefore may never mention internal package
 * scopes, wire-event strings, or media/session vocabulary. This script scans
 * every source file in the package (skipping build output and installed
 * dependencies) and fails the build on any hit.
 *
 * Each banned term is assembled from pieces so the guard can hunt them
 * without containing them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BANNED_TERMS = [
  ['@videofy', '-live/'].join(''),
  ['media', 'Revision'].join(''),
  ['language', 'Revision'].join(''),
  ['sl', 'ot'].join(''),
  ['ingest', 'Session'].join(''),
  ['resume', 'Token'].join(''),
  ['resume', '-token'].join(''),
  ['CallSession', 'Store'].join(''),
  // Platform credentials and ids the BROWSER must never even spell: the
  // project key prefix, the public Connect call-id prefix, and the internal
  // media stream prefixes. The server may hold these; this package may not.
  ['vfk', '_'].join(''),
  ['vc', '_'].join(''),
  ['connect', '_'].join(''),
  ['callcast', '_'].join(''),
  ['callpeer', '_'].join(''),
];

/**
 * The internal wire-event prefix is banned in its QUOTED form — the same rule
 * the public SDK surface tests apply — because the hazard is a string literal
 * that could reach a wire emit; identifier positions are public vocabulary.
 */
const WIRE_PREFIX = ['ca', 'll', ':'].join('');
const QUOTED_WIRE_PREFIX = new RegExp('[\'"`]' + WIRE_PREFIX, 'gi');

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css', '.md', '.json']);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* sourceFiles(fullPath);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) yield fullPath;
  }
}

let hits = 0;
let filesScanned = 0;
for (const file of sourceFiles(packageRoot)) {
  filesScanned += 1;
  const text = readFileSync(file, 'utf8');
  const lowered = text.toLowerCase();
  for (const term of BANNED_TERMS) {
    const needle = term.toLowerCase();
    let index = lowered.indexOf(needle);
    while (index !== -1) {
      const line = text.slice(0, index).split('\n').length;
      console.error(`banned term "${term}" in ${path.relative(packageRoot, file)} at line ${line}`);
      hits += 1;
      index = lowered.indexOf(needle, index + 1);
    }
  }
  QUOTED_WIRE_PREFIX.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_WIRE_PREFIX)) {
    const line = text.slice(0, match.index).split('\n').length;
    console.error(
      `banned quoted wire prefix "${match[0]}" in ${path.relative(packageRoot, file)} at line ${line}`,
    );
    hits += 1;
  }
}

if (filesScanned === 0) {
  console.error('check-vocab found no source files -- wrong directory?');
  process.exit(1);
}
if (hits > 0) {
  console.error(`${hits} banned-vocabulary hit(s) across ${filesScanned} files.`);
  process.exit(1);
}
console.log(`Connect Reference web sources are clean of internal vocabulary (${filesScanned} files scanned).`);
