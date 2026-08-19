// owner: masterzee001
/**
 * The purity law, asserted from inside the package: Connect Reference consumes
 * ONLY the public Videofy SDKs. The dependency allowlist and the banned
 * internal vocabulary are checked here over package.json and every source
 * file, and the vocab guard script must be wired into the test script so CI
 * can never run the suite without it. Needles are assembled from pieces so
 * this test can hunt them without containing them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const INTERNAL_SCOPE = ['@videofy', '-live/'].join('');
const BANNED_TERMS = [
  INTERNAL_SCOPE,
  ['media', 'revision'].join(''),
  ['language', 'revision'].join(''),
  ['sl', 'ot'].join(''),
  ['ingest', 'session'].join(''),
  ['resume', 'token'].join(''),
  ['callsession', 'store'].join(''),
];
const QUOTED_WIRE_PREFIX = new RegExp('[\'"`]' + ['ca', 'll', ':'].join(''), 'i');

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
  '.md',
  '.json',
]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) found.push(...sourceFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(fullPath);
  }
  return found;
}

describe('the purity law', () => {
  it('declares no Videofy package other than the public browser SDK', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    const videofyDeclared = declared.filter((name) => name.startsWith('@videofy'));
    expect(videofyDeclared).toEqual(['@videofy/connect']);
  });

  it('contains no internal Videofy vocabulary in any source file', () => {
    const files = sourceFiles(packageRoot);
    expect(files.length).toBeGreaterThan(10);
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const term of BANNED_TERMS) {
        if (text.includes(term)) offences.push(`${path.relative(packageRoot, file)}: ${term}`);
      }
      if (QUOTED_WIRE_PREFIX.test(text)) {
        offences.push(`${path.relative(packageRoot, file)}: quoted wire prefix`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('keeps the vocab guard wired into the test script', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.['test'] ?? '').toContain('check-vocab');
    expect(manifest.scripts?.['build'] ?? '').toContain('check-vocab');
  });
});
