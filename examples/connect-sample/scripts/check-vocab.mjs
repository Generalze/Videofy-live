/** @author masterzee001 */
/**
 * The R18 independence guard: the sample must live entirely on the PUBLIC
 * Videofy surfaces, so its sources may never mention internal wire or media
 * vocabulary. Scans every source file in this package (skipping build output
 * and installed dependencies) for the banned terms, case-insensitively.
 *
 * Each term is assembled from pieces so this checker can hunt them without
 * containing them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BANNED_TERMS = [
  ['media', 'Revision'].join(''),
  ['sl', 'ot'].join(''),
  ['ingest', 'Session'].join(''),
  ['resume', 'Token'].join(''),
];

/**
 * The internal wire-event prefix is banned in its QUOTED form only — the same
 * rule the public SDK surface tests apply — because the hazard is a string
 * literal that could reach a wire emit, while identifier positions (such as
 * the R9 capabilities key spelled personal + Call, then a colon) are public
 * contract vocabulary.
 */
const WIRE_PREFIX = ['ca', 'll', ':'].join('');
const QUOTED_WIRE_PREFIX = new RegExp('[\'"`]' + WIRE_PREFIX, 'gi');

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.html', '.css', '.md', '.json']);

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
      console.error(
        `banned term "${term}" in ${path.relative(packageRoot, file)} at line ${line}`,
      );
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
  console.error('check-vocab found no source files — wrong directory?');
  process.exit(1);
}
if (hits > 0) {
  console.error(`${hits} banned-vocabulary hit(s) across ${filesScanned} files.`);
  process.exit(1);
}
console.log(`sample sources are clean of internal vocabulary (${filesScanned} files scanned).`);
