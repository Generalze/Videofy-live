/** @author masterzee001 */
/**
 * The fixtures are TEST-ONLY, and this is what makes that a fact rather than
 * an intention.
 *
 * Founder directive 30 Aug 2026, SS13: the deterministic render fixtures
 * "must NOT leak into production business logic". Two ways they could, and
 * both are refused here:
 *
 *   1. a file under src/ importing visual/fixtures (or anything else under
 *      visual/), which would put fixture values in the shipped bundle;
 *   2. a file under src/ branching on a fixture flag -- if (FIXTURES) ... --
 *      which is the same leak wearing a different hat, and the one that
 *      survives review because it "only runs in the harness".
 *
 * The production Vite build starts at index.html -> src/main.tsx, so proving
 * src/ is clean proves the bundle is. The harness asserts the same thing
 * before it builds, so a green test suite is not the only thing standing
 * between a fixture and a deployment.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** An import of anything under visual/, however it is spelled. */
const IMPORTS_VISUAL = /\bfrom\s+['"][^'"]*\bvisual\/[^'"]*['"]|\bimport\s*\(\s*['"][^'"]*\bvisual\/[^'"]*['"]/;
/** A branch on a fixture/mock/golden-master switch. */
const FIXTURE_FLAG = /\b(?:VITE_)?(?:USE_)?(?:FIXTURES?|VISUAL_FIXTURES?|MOCK_STATE|GOLDEN_MASTER)\b/;

describe('the visual fixtures cannot reach production', () => {
  const files = sourceFiles(SRC);

  it('finds the console source to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no file under src/ importing visual/', () => {
    const offenders = files.filter((file) => IMPORTS_VISUAL.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('has no file under src/ branching on a fixture flag', () => {
    const offenders = files
      .filter((file) => !file.endsWith('fixtureIsolation.test.ts'))
      .filter((file) => FIXTURE_FLAG.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the production entry on the app, not the fixture console', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toContain("from './App'");
    expect(main).not.toMatch(/fixture/i);
  });
});
