/** @author masterzee001 */
/**
 * Every EXPO_PUBLIC value must be read with DOT notation.
 *
 * WHAT THIS CAUGHT, on 5 Oct 2026. All sixteen reads in this app used
 * `process.env['EXPO_PUBLIC_X']`, and Expo's build step only substitutes
 * `process.env.EXPO_PUBLIC_X` -- a member expression, not an index. So not
 * one of them was ever replaced, every one fell through to its hard-coded
 * fallback, and every fallback in this app points at STAGING.
 *
 * The consequence was not a missing feature. `eas.json` sets the production
 * endpoints on the `production-apk` and `production` profiles, and none of
 * those values had ever reached a build: production APKs were talking to
 * staging, for the gateway, the account service, media ingest, the listener
 * and the web links alike. Nothing failed, nothing logged, and both
 * environments answer the same routes -- so it looked like it worked.
 *
 * It is a grep because that is what the defect was: a shape of expression,
 * invisible to the type checker, invisible to every other test, and silent
 * at runtime. A test that imported a module and checked a value would have
 * passed the whole time, because the fallback IS a valid value.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.expo', 'android', 'ios', 'dist', 'assets']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe('EXPO_PUBLIC configuration reaches the bundle', () => {
  it('is never read with bracket notation', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(APP_ROOT)) {
      // This test names the pattern itself, so it must not match its own
      // source and report a problem that is only its own description.
      if (file.endsWith(`__tests__${sep}publicEnvNotation.test.ts`)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (/process\.env\[\s*['"`]EXPO_PUBLIC_/.test(line)) {
          offenders.push(`${relative(APP_ROOT, file)}:${index + 1}`);
        }
      }
    }
    expect(
      offenders,
      `These read an EXPO_PUBLIC value with an index, which Expo does not substitute. ` +
        `They compile to their fallback -- which in this app means staging -- in every ` +
        `build, including production. Use process.env.EXPO_PUBLIC_NAME instead:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('still reads some, so this test cannot pass by there being nothing to check', () => {
    // A guard that would also pass against an app with no configuration at
    // all is a guard that stops meaning anything the day somebody moves it.
    const reads = sourceFiles(APP_ROOT)
      .filter((file) => !file.endsWith(`__tests__${sep}publicEnvNotation.test.ts`))
      .reduce(
        (total, file) =>
          total + (readFileSync(file, 'utf8').match(/process\.env\.EXPO_PUBLIC_/g) ?? []).length,
        0,
      );
    expect(reads).toBeGreaterThan(10);
  });
});
