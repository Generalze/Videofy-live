/** @owner masterzee001 */
/**
 * The emitted public surface must be pure and self-contained:
 *  - no internal vocabulary (P6.5 spec list: mediaRevision, "call:", slot,
 *    ingestSession, resumeToken, voiceOwnerId — plus jti from the privacy
 *    invariants) in dist/index.d.ts;
 *  - no import of zod or any @videofy-live/* workspace package anywhere in
 *    the shipped files: the contracts package is bundled and the SDK has
 *    zero runtime dependencies;
 *  - no console usage anywhere: an SDK that logs is an SDK that can leak.
 *
 * The wire-event check looks for the internal event-name prefix as a QUOTED
 * string only (a leaked wire event name is what a quoted occurrence would
 * look like); property names such as `personalCall:` are legitimate.
 * Forbidden tokens are assembled by concatenation so this file itself never
 * contains them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const dtsPath = join(packageRoot, 'dist', 'index.d.ts');
const jsPath = join(packageRoot, 'dist', 'index.js');

function readDist(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing — the emitted bundle is part of this assertion. ` +
        'Run the package test script (it builds first) or `npm run build`.',
    );
  }
  return readFileSync(path, 'utf8');
}

const FORBIDDEN_CASE_SENSITIVE = [
  'media' + 'Revision',
  'ingest' + 'Session',
  'resume' + 'Token',
  'voice' + 'OwnerId',
];
const FORBIDDEN_CASE_INSENSITIVE = ['s' + 'lot', 'j' + 'ti'];
const QUOTED_WIRE_EVENT_PREFIX = new RegExp(`["'\`]${'call'}:`);

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

describe('emitted .d.ts purity', () => {
  it('contains none of the forbidden internal vocabulary', () => {
    const dts = readDist(dtsPath);
    for (const token of FORBIDDEN_CASE_SENSITIVE) {
      expect(dts, `d.ts must not contain "${token}"`).not.toContain(token);
    }
    const lowered = dts.toLowerCase();
    for (const token of FORBIDDEN_CASE_INSENSITIVE) {
      expect(lowered, `d.ts must not contain "${token}" (any case)`).not.toContain(
        token.toLowerCase(),
      );
    }
    expect(dts).not.toMatch(QUOTED_WIRE_EVENT_PREFIX);
  });

  it('is fully self-contained: no imports of zod, workspace packages, or anything else', () => {
    const dts = readDist(dtsPath);
    expect(dts).not.toContain('@videofy-live');
    const external = importSpecifiers(dts).filter(
      (specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'),
    );
    expect(external).toEqual([]);
  });

  it('still exports the real surface (sanity that the scan target is the SDK)', () => {
    const dts = readDist(dtsPath);
    for (const name of [
      'createVideofyConnect',
      'VideofyApiError',
      'VideofyContractError',
      'VideofyInputError',
      'VideofyConnectClient',
      'VideofyErrorCode',
    ]) {
      expect(dts).toContain(name);
    }
  });
});

describe('emitted bundle purity', () => {
  it('bundles all internals: no imports of zod or @videofy-live packages survive', () => {
    const js = readDist(jsPath);
    expect(js).not.toContain('@videofy-live');
    const external = importSpecifiers(js).filter(
      (specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'),
    );
    expect(external).toEqual([]);
  });

  it('carries no forbidden vocabulary and never touches console', () => {
    const js = readDist(jsPath);
    for (const token of FORBIDDEN_CASE_SENSITIVE) {
      expect(js, `bundle must not contain "${token}"`).not.toContain(token);
    }
    expect(js).not.toMatch(QUOTED_WIRE_EVENT_PREFIX);
    expect(js).not.toContain('console.');
  });
});

describe('source hygiene', () => {
  it('the SDK source itself never logs', () => {
    const srcDir = join(packageRoot, 'src');
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const content = readFileSync(join(srcDir, entry.name), 'utf8');
      expect(content, `${entry.name} must not use console`).not.toContain('console.');
    }
  });
});
