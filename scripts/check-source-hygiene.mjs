#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Refuse source that cannot be read as source.
 *
 * This exists because the same defect landed three times in one wave. A patch
 * script meant to write the six characters `\u0000` into a TypeScript string
 * wrote one actual NUL byte instead. The code behaved identically — a NUL is a
 * perfectly good map-key separator — every test passed, typecheck passed, and
 * the commit went out with git quietly reclassifying the file as BINARY. No
 * diff, no review, no blame. The tests could not catch it because the tests
 * were not wrong; the file was unreadable, which is a different property.
 *
 * So it is checked mechanically rather than remembered.
 *
 * Three families are refused:
 *
 * CONTROL CHARACTERS other than tab, newline and carriage return. NUL is the
 * one that has actually bitten, and the rest share its defect: they survive
 * compilation, change nothing observable, and make a file undiffable.
 *
 * BIDIRECTIONAL AND INVISIBLE FORMATTING. Source that renders in one order and
 * compiles in another is the Trojan Source class (CVE-2021-42574): a reviewer
 * approves what they can see while the compiler reads something else. This
 * repository has none today, which makes now the cheap moment to keep it that
 * way rather than the expensive one later.
 *
 * The forbidden characters are built by code point rather than written out, so
 * this file never contains what it refuses and cannot fail against itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|ya?ml)$/;

/** Tab, newline and carriage return are ordinary; nothing else below 0x20 is. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

const BIDI = new Map([
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
]);

function describe(code) {
  if (code === 0) return 'NUL';
  const named = BIDI.get(code);
  if (named !== undefined) return named;
  return code === 0x7f ? 'DELETE' : 'control character';
}

// `--cached --others --exclude-standard` rather than tracked files alone.
// The guard checked only what git already knew about, so a BRAND-NEW file
// containing a NUL passed every gate right up until it was committed -- and was
// only caught on the next run, with the damage already in history. A guard that
// clears exactly the change you are about to make is the one that matters.
const everyPath = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split(String.fromCharCode(0))
  .filter((path) => path !== '');

const tracked = everyPath.filter((path) => TEXT.test(path));

const findings = [];
for (const path of tracked) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  let line = 1;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === '\n') {
      line += 1;
      continue;
    }
    const forbidden =
      (code < 0x20 && !ALLOWED_CONTROL.has(code)) || code === 0x7f || BIDI.has(code);
    if (forbidden) {
      findings.push(
        `${path}:${line}  U+${code.toString(16).toUpperCase().padStart(4, '0')}  ${describe(code)}`,
      );
    }
  }
}

/*
 * COMPILER OUTPUT MUST NOT LIVE BESIDE ITS SOURCE.
 *
 * A stray `tsc` run emitted .js, .d.ts and their .map files next to the
 * TypeScript they came from, and they were committed. Nothing broke, which is
 * the problem: a compiled copy in `src` goes stale in silence, and an editor or
 * a bundler that resolves the .js ahead of the .ts sends somebody hunting a bug
 * in code that is no longer the code being run.
 *
 * DETECTED BY PAIRING, NOT BANNED BY EXTENSION. Authored JavaScript is
 * legitimate and this repository has plenty of it; so are ambient declarations
 * like vite-env.d.ts and hls-light.d.ts, which describe things that have no
 * TypeScript source at all. What is never legitimate is an artefact whose
 * corresponding SOURCE FILE sits in the same directory -- that pairing is what
 * makes it output rather than something a person wrote.
 */
const SOURCE_DIR = /(^|\/)src\//;

/** The TypeScript file this path would have been compiled FROM, if any. */
function sourceOf(path) {
  const suffix = ['.d.ts.map', '.js.map', '.d.ts', '.js'].find((end) => path.endsWith(end));
  if (suffix === undefined) return null;
  const stem = path.slice(0, -suffix.length);
  return [stem + '.ts', stem + '.tsx'];
}

const present = new Set(everyPath);
const emitted = [];
for (const path of everyPath) {
  if (!SOURCE_DIR.test(path)) continue;
  const candidates = sourceOf(path);
  if (candidates === null) continue;
  const origin = candidates.find((candidate) => present.has(candidate));
  if (origin !== undefined) emitted.push({ path, origin });
}

if (emitted.length > 0) {
  console.error(
    `source hygiene: ${emitted.length} compiler artefact(s) beside their source`,
  );
  for (const { path, origin } of emitted.slice(0, 40)) {
    console.error(`  ${path}  <- emitted from ${origin}`);
  }
  console.error(
    [
      '',
      'Delete them and keep build output in the package dist directory. A',
      'compiled copy in src goes stale without a word, and whichever of the two',
      'a tool happens to resolve is the one somebody will end up debugging.',
    ].join('\n'),
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`source hygiene: ${findings.length} forbidden character(s)\n`);
  for (const finding of findings.slice(0, 40)) console.error(`  ${finding}`);
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`);
  console.error(
    '\nWrite the ESCAPE SEQUENCE, not the character. A literal NUL in a string\n' +
      'literal compiles and passes tests while making the file undiffable.',
  );
  process.exit(1);
}

console.log(
  `source hygiene: ${tracked.length} files, no forbidden characters, ` +
    'no compiler artefacts beside source',
);
