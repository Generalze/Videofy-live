/** @owner masterzee001 */
/**
 * R10: `npm pack` must produce a tarball that is a real, externally
 * consumable package — dist only, zero runtime dependencies, no workspace
 * aliases, Node 18+ engines, not private. This suite asserts the manifest and
 * the exact tarball contents without publishing anything.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

interface PackEntry {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
}

function dryRunPack(): PackEntry {
  // --ignore-scripts keeps prepack's build banner out of the JSON stream;
  // the dry run lists the manifest either way.
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(stdout) as PackEntry[];
  expect(parsed).toHaveLength(1);
  return parsed[0]!;
}

describe('npm pack tarball contents', () => {
  it('packs exactly the manifest, README, and dist bundle', { timeout: 120_000 }, () => {
    const entry = dryRunPack();
    expect(entry.name).toBe('@videofy/server-sdk');
    expect(entry.filename).toBe(`videofy-server-sdk-${entry.version}.tgz`);

    const paths = entry.files.map((file) => file.path).sort();
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');
    for (const path of paths) {
      expect(path, `unexpected file in tarball: ${path}`).toMatch(
        /^(package\.json|README\.md|dist\/)/,
      );
      expect(path).not.toContain('src/');
      expect(path).not.toContain('.test.');
      expect(path).not.toContain('tsconfig');
      expect(path).not.toContain('tsup.config');
      expect(path).not.toMatch(/\.map$/);
    }
  });
});

describe('publishable manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('is public, ESM, dist-only, and Node 18+', () => {
    expect(manifest['name']).toBe('@videofy/server-sdk');
    expect(manifest['private']).toBeUndefined();
    expect(manifest['type']).toBe('module');
    expect(manifest['files']).toEqual(['dist']);
    expect((manifest['engines'] as Record<string, unknown>)['node']).toBe('>=18.0.0');
    expect(manifest['main']).toBe('./dist/index.js');
    expect(manifest['types']).toBe('./dist/index.d.ts');
    const exportsRoot = (manifest['exports'] as Record<string, Record<string, string>>)['.'];
    expect(exportsRoot).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
  });

  it('declares zero runtime dependencies (everything internal is bundled)', () => {
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['peerDependencies']).toBeUndefined();
    expect(manifest['optionalDependencies']).toBeUndefined();
  });
});
