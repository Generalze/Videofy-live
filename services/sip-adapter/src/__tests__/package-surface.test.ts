/** @author masterzee001 */
/**
 * The package must be what its manifest says it is.
 *
 * This package declared `main: dist/index.js`, `dev: tsx watch src/index.ts`
 * and `start: node dist/index.js` while `src/index.ts` did not exist. `tsc`
 * compiled the files that were present and `--noEmit` was satisfied, so
 * typecheck, build and the whole test suite passed green — and `npm start`
 * would have died on a missing file.
 *
 * Nothing checked the claim, so nothing caught it. These tests check the
 * claim: whatever the manifest advertises must resolve, and the entrypoint
 * must carry the surface another package would import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('the package manifest describes something that exists', () => {
  it('PIN: every script that names a source file names one that is there', () => {
    const scripts = (manifest()['scripts'] ?? {}) as Record<string, string>;
    const missing: string[] = [];
    for (const [name, command] of Object.entries(scripts)) {
      for (const match of command.matchAll(/(?:^|\s)(src\/[\w./-]+\.ts)/g)) {
        const referenced = match[1]!;
        if (!existsSync(resolve(packageRoot, referenced))) missing.push(`${name} -> ${referenced}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('PIN: the declared entrypoint is built from a source file that exists', () => {
    const main = manifest()['main'];
    expect(typeof main).toBe('string');
    // dist/ is a build artefact and is not in the repository, so the check
    // that survives a clean checkout is on the SOURCE the entrypoint is built
    // from — which is the file that was missing.
    const source = String(main).replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    expect(existsSync(resolve(packageRoot, source))).toBe(true);
  });

  it('PIN: this package advertises no runtime it does not have', () => {
    // It is a LIBRARY. There is no service to start, because there is nothing
    // for a running SIP process to deliver audio to until the Adapter Ingress
    // Binding exists. Claiming otherwise in the manifest is how the missing
    // entrypoint went unnoticed in the first place.
    const scripts = (manifest()['scripts'] ?? {}) as Record<string, string>;
    expect(scripts['start']).toBeUndefined();
    expect(scripts['dev']).toBeUndefined();
  });

  it('the entrypoint carries the surface another package would import', async () => {
    const surface = await import('../index.js');
    for (const name of [
      'SipCall',
      'CallLifecycle',
      'JitterBuffer',
      'SipDialog',
      'parseRtpPacket',
      'serializeRtpPacket',
      'maySendMediaTo',
      'CODECS',
      'buildSdp',
      'parseSdp',
    ]) {
      expect(surface, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
