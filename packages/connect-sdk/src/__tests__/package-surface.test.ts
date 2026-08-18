/** @owner masterzee001 */
/**
 * Purity of the emitted declarations and packability of the tarball.
 *
 * The package test script builds dist before vitest runs, so these read the
 * real emitted artifacts, not source.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(__dirname, '..', '..');

/**
 * Internal vocabulary that must never appear in the public declarations.
 * `call:` is checked in QUOTED form only: the contract-locked CallSnapshot
 * `call` property necessarily emits the bare substring `call:` in declaration
 * output (`call: { id: ... }`), while a quoted 'call:' would mean a wire
 * event name leaked into a public type — the same rationale the contracts
 * package documents for its own purity test.
 */
const BANNED_BARE = [/mediaRevision/i, /ingestSession/i, /resumeToken/i, /voiceOwnerId/i, /slot/i];
const BANNED_QUOTED_WIRE_PREFIX = /['"`]call:/;

describe('emitted declaration purity', () => {
  const dtsPath = join(packageRoot, 'dist', 'index.d.ts');

  it('emits a declaration bundle', () => {
    expect(existsSync(dtsPath)).toBe(true);
  });

  it('contains none of the internal vocabulary', () => {
    const dts = readFileSync(dtsPath, 'utf8');
    for (const pattern of BANNED_BARE) {
      expect(dts).not.toMatch(pattern);
    }
    expect(dts).not.toMatch(BANNED_QUOTED_WIRE_PREFIX);
  });

  it('bundles every internal module: the only import left in dist is socket.io-client', () => {
    const js = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');
    const specifiers = new Set<string>();
    for (const match of js.matchAll(/^\s*import\s[^'"\n]*['"]([^'"]+)['"];?\s*$/gm)) {
      specifiers.add(match[1]!);
    }
    for (const match of js.matchAll(/from\s*['"]([^'".][^'"]*)['"]/g)) {
      if (!match[1]!.startsWith('.')) specifiers.add(match[1]!);
    }
    expect([...specifiers].filter((s) => !s.startsWith('.'))).toEqual(['socket.io-client']);

    const dts = readFileSync(dtsPath, 'utf8');
    // No workspace alias may survive into the public artifacts.
    expect(dts).not.toContain('@videofy-live/');
    expect(js).not.toContain('@videofy-live/');
    // The declarations stand fully alone: no type-level imports either
    // (the finalize-dts build step shims the one zod type import away).
    expect(dts).not.toMatch(/^import\s/m);
    expect(dts).not.toMatch(/from\s+['"]zod['"]/);
  });
});

describe('npm pack', () => {
  it('produces a tarball containing only dist, package.json, README and LICENSE', () => {
    const destination = mkdtempSync(join(tmpdir(), 'videofy-connect-pack-'));
    try {
      // --ignore-scripts keeps the prepack build's console output out of the
      // --json stream; the package test script has already built dist.
      const output = execSync(`npm pack --json --ignore-scripts --pack-destination "${destination}"`, {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const report = JSON.parse(output) as { filename: string; files: { path: string }[] }[];
      expect(report).toHaveLength(1);
      const entry = report[0]!;
      expect(entry.filename).toContain('videofy-connect-0.1.0');

      const files = entry.files.map((file) => file.path);
      const allowed = /^(package\.json|README\.md|LICENSE|dist\/.+)$/;
      for (const file of files) {
        expect(file).toMatch(allowed);
      }
      expect(files).toContain('package.json');
      expect(files).toContain('README.md');
      expect(files).toContain('LICENSE');
      expect(files).toContain('dist/index.js');
      expect(files).toContain('dist/index.d.ts');
      // Nothing from src, tests, or configs may ship.
      expect(files.some((file) => file.includes('src/') || file.includes('__tests__'))).toBe(
        false,
      );
      expect(existsSync(join(destination, entry.filename))).toBe(true);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
