/** @author masterzee001 */
/**
 * The dependency law, asserted: Connect Reference consumes the PUBLIC Videofy
 * surfaces only. Its package declares no internal-scope packages and its
 * sources never name them. (The banned scope is assembled from pieces so this
 * file can hunt it without containing it — the same trick as check-vocab.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTERNAL_SCOPE = ['@videofy', '-live/'].join('');
const ALLOWED_VIDEOFY_PACKAGES = new Set(['@videofy/server-sdk']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(fullPath);
      continue;
    }
    yield fullPath;
  }
}

describe('the purity law', () => {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('is named like a customer, not like the platform', () => {
    expect(manifest.name).toBe('connect-reference-server');
    expect(manifest.private).toBe(true);
  });

  it('declares only public Videofy packages', () => {
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(name.startsWith(INTERNAL_SCOPE.slice(0, -1))).toBe(false);
      if (name.startsWith('@videofy/')) {
        expect(ALLOWED_VIDEOFY_PACKAGES.has(name)).toBe(true);
      }
    }
  });

  it('never names the internal scope in any source file', () => {
    const scanned: string[] = [];
    for (const dir of ['src', 'scripts']) {
      for (const file of sourceFiles(path.join(packageRoot, dir))) {
        scanned.push(file);
        const text = readFileSync(file, 'utf8');
        expect(
          text.includes(INTERNAL_SCOPE),
          `${path.relative(packageRoot, file)} names the internal scope`,
        ).toBe(false);
      }
    }
    expect(scanned.length).toBeGreaterThan(5);
  });
});
