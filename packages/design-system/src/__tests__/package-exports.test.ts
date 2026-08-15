/** @owner masterzee001 */
/**
 * The package manifest is part of the contract: an app writes
 * `import '@videofy-live/design-system/tokens.css'` and either it resolves or
 * the app silently renders unstyled. Nothing else in the toolchain checks that
 * an `exports` target points at a file that exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = new URL('../../', import.meta.url);

interface Manifest {
  readonly name: string;
  readonly type: string;
  readonly main: string;
  readonly types: string;
  readonly exports: Record<string, string | Record<string, string>>;
  readonly sideEffects?: readonly string[];
}

const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as Manifest;

function resolvesToAnExistingFile(relativePath: string): boolean {
  return existsSync(fileURLToPath(new URL(relativePath, packageRoot)));
}

/** Every leaf path in the exports map, with the subpath it is reached by. */
function exportTargets(): Array<[subpath: string, target: string]> {
  return Object.entries(manifest.exports).flatMap(([subpath, target]) =>
    typeof target === 'string'
      ? [[subpath, target] as [string, string]]
      : Object.values(target).map((condition) => [subpath, condition] as [string, string]),
  );
}

describe('package identity', () => {
  it('matches the workspace conventions', () => {
    expect(manifest.name).toBe('@videofy-live/design-system');
    expect(manifest.type).toBe('module');
  });
});

describe('exports map', () => {
  it('points every target at a file that exists', () => {
    // `dist` targets only exist after a build, which is why the package `test`
    // script builds first — the same convention the sibling contract packages
    // use.
    for (const [subpath, target] of exportTargets()) {
      expect(resolvesToAnExistingFile(target), `${subpath} → ${target}`).toBe(true);
    }
  });

  it('exposes both stylesheets as real files', () => {
    // CSS cannot go through tsc, so it is published straight from src rather
    // than from dist. If these ever start pointing into dist, the build has
    // silently started trying to compile stylesheets.
    for (const subpath of ['./tokens.css', './base.css']) {
      const target = manifest.exports[subpath];
      expect(typeof target, subpath).toBe('string');
      expect(target as string).toMatch(/^\.\/src\/.+\.css$/);
      expect(resolvesToAnExistingFile(target as string), subpath).toBe(true);
    }
  });

  it('never emits a stylesheet into the build output', () => {
    // tsc must not touch CSS. A .css file appearing in dist means someone
    // added a loader or a copy step and there are now two token files.
    expect(existsSync(fileURLToPath(new URL('dist/tokens.css', packageRoot)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL('dist/base.css', packageRoot)))).toBe(false);
  });

  it('marks stylesheets as side-effectful', () => {
    // Without this, a production bundler is entitled to tree-shake
    // `import '.../base.css'` away entirely — the import has no binding, so it
    // looks dead. The app then ships with no design system at all.
    expect(manifest.sideEffects).toContain('*.css');
  });

  it('keeps the JS entry pointing at the compiled output', () => {
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
  });
});
