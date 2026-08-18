/** @owner masterzee001 */
/**
 * This package is PUBLIC vocabulary ONLY. Internal wire and runtime terms must
 * be unrepresentable here, so the scan covers the source modules, the emitted
 * declaration files, and the generated OpenAPI document.
 *
 * The wire-event check looks for the internal event-name prefix as a QUOTED
 * string only: the locked CallSnapshot shape has a `call` property, which
 * legitimately emits `call:` in declaration output, so a bare-substring check
 * would outlaw the very shape the spec requires. A quoted occurrence is what a
 * leaked wire event name would actually look like.
 *
 * Forbidden tokens are assembled by concatenation so this file itself never
 * contains them.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = join(packageRoot, 'src');
const distDir = join(packageRoot, 'dist');

const FORBIDDEN_CASE_SENSITIVE = [
  'media' + 'Revision',
  'ingest' + 'Session',
  'resume' + 'Token',
  'voice' + 'OwnerId',
];
const FORBIDDEN_CASE_INSENSITIVE = ['s' + 'lot'];
const QUOTED_WIRE_EVENT_PREFIX = new RegExp(`["'\`]${'call'}:`);

function collectFiles(dir: string, keep: (fileName: string) => boolean): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFiles(full, keep));
    } else if (keep(entry.name)) {
      collected.push(full);
    }
  }
  return collected;
}

function scanTargets(): string[] {
  if (!existsSync(join(distDir, 'index.d.ts'))) {
    throw new Error(
      'dist/index.d.ts is missing — the emitted declarations are part of this assertion. ' +
        'Run the package test script (it builds first) or `npm run build`.',
    );
  }
  const sources = collectFiles(srcDir, (name) => name.endsWith('.ts'));
  const declarations = collectFiles(distDir, (name) => name.endsWith('.d.ts'));
  return [...sources, ...declarations, join(packageRoot, 'openapi.json')];
}

describe('public vocabulary purity', () => {
  const targets = scanTargets();

  it('actually scans the full surface, not an empty directory', () => {
    expect(targets.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).length,
    ).toBeGreaterThanOrEqual(6);
    expect(targets.filter((file) => file.endsWith('.d.ts')).length).toBeGreaterThanOrEqual(6);
    expect(targets.some((file) => file.endsWith('openapi.json'))).toBe(true);
  });

  it('contains no internal runtime vocabulary anywhere on the emitted surface', () => {
    for (const file of targets) {
      const content = readFileSync(file, 'utf8');
      const lowered = content.toLowerCase();
      for (const token of FORBIDDEN_CASE_SENSITIVE) {
        expect(content.includes(token), `${file} leaks "${token}"`).toBe(false);
      }
      for (const token of FORBIDDEN_CASE_INSENSITIVE) {
        expect(lowered.includes(token), `${file} leaks "${token}"`).toBe(false);
      }
      expect(
        QUOTED_WIRE_EVENT_PREFIX.test(content),
        `${file} leaks a quoted wire event name`,
      ).toBe(false);
    }
  });
});
