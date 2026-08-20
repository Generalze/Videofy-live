/** @author masterzee001 */
/**
 * The suite that checks the suite actually runs.
 *
 * This service names its test files ONE BY ONE in `package.json` rather than
 * letting vitest glob them. That is a deliberate choice — the integration
 * suites need a built workspace and are kept out of the fast chain — but it
 * has a failure mode that cost this wave a real gap:
 *
 * vitest treats those arguments as FILTERS, not as paths. A name that matches
 * no file selects nothing and exits 0. So when the WebRTC-to-media rename
 * changed two filenames, the script kept the old names, the chunker and bridge
 * suites silently stopped running, and every gate stayed green for it. Two of
 * the most load-bearing suites in the pipeline were guarding nothing, and
 * nothing said so.
 *
 * Both directions are checked, because each hides a different lie:
 *
 *   a file that no script names   — a suite believed to be running, isn't
 *   a name that matches no file   — a suite believed to exist, doesn't
 *
 * The second is the one that actually happened, and it is invisible precisely
 * because it looks like success.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> };

const SCRIPTS = ['test', 'test:integration'] as const;

function namedIn(script: string): string[] {
  return [...(manifest.scripts[script] ?? '').matchAll(/src\/__tests__\/([\w.-]+\.test\.ts)/g)].map(
    (match) => match[1]!,
  );
}

const onDisk = readdirSync(fileURLToPath(new URL('.', import.meta.url)))
  .filter((entry) => entry.endsWith('.test.ts'))
  .sort();

const named = new Set(SCRIPTS.flatMap(namedIn));

describe('every test file in this service is actually run', () => {
  it('PIN: no suite exists that no script names', () => {
    const orphans = onDisk.filter((file) => !named.has(file));
    expect(orphans, `these suites are never executed: ${orphans.join(', ')}`).toEqual([]);
  });

  it('PIN: no script names a suite that does not exist', () => {
    // The rename failure. vitest filters silently, so a stale name is a suite
    // that stopped running while the exit code kept saying it had passed.
    const present = new Set(onDisk);
    for (const script of SCRIPTS) {
      const ghosts = namedIn(script).filter((file) => !present.has(file));
      expect(ghosts, `"${script}" names missing suites: ${ghosts.join(', ')}`).toEqual([]);
    }
  });

  it('PIN: this guard is itself in the fast chain', () => {
    // Otherwise the check that everything runs is the one thing that doesn't.
    expect(namedIn('test')).toContain('test-manifest.test.ts');
  });
});
