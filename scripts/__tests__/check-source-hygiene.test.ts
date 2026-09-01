/** @author masterzee001 */
/**
 * The hygiene gate's own regression.
 *
 * The emitted-artefact check has to be right in BOTH directions, and the second
 * one is what makes it usable: banning `.js` or `.d.ts` outright would fail on
 * authored JavaScript and on ambient declarations like `vite-env.d.ts`, both of
 * which are legitimate and both of which this repository contains. A guard that
 * cries wolf gets switched off, and then it protects nothing.
 *
 * So this drives the real script against real directory layouts rather than
 * asserting on its source.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'check-source-hygiene.mjs',
);

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway git repository containing exactly `files`.
 *
 * A real repository because the script asks git which paths exist -- running it
 * against a bare directory would exercise a different code path from the one
 * that runs in anger.
 */
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-'));
  made.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return dir;
}

/** Exit code and combined output of the real gate, run inside `dir`. */
function runGate(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('compiler output beside its source is refused', () => {
  it.each(['js', 'd.ts', 'js.map', 'd.ts.map'])(
    'catches a .%s emitted next to its .ts',
    (extension) => {
      const dir = repoWith({
        'pkg/src/thing.ts': 'export const a = 1;\n',
        [`pkg/src/thing.${extension}`]: '// emitted\n',
      });
      const { code, output } = runGate(dir);
      expect(code).toBe(1);
      expect(output).toMatch(/compiler artefact/u);
      expect(output).toMatch(/emitted from pkg\/src\/thing\.ts/u);
    },
  );

  it('catches output beside a .tsx source too', () => {
    const dir = repoWith({
      'app/src/pages/Page.tsx': 'export const P = 1;\n',
      'app/src/pages/Page.js': '// emitted\n',
    });
    expect(runGate(dir).code).toBe(1);
  });

  it('reports the source it came from, so the fix is obvious', () => {
    const dir = repoWith({
      'pkg/src/a.ts': 'export const a = 1;\n',
      'pkg/src/a.d.ts.map': '{}\n',
    });
    const { output } = runGate(dir);
    expect(output).toMatch(/pkg\/src\/a\.d\.ts\.map {2}<- emitted from pkg\/src\/a\.ts/u);
  });
});

describe('legitimate files are left alone', () => {
  it('allows an ambient declaration with no TypeScript source', () => {
    // vite-env.d.ts and hls-light.d.ts are exactly this, and both are real.
    const dir = repoWith({
      'app/src/vite-env.d.ts': '/// <reference types="vite/client" />\n',
      'app/src/main.ts': 'export const main = 1;\n',
    });
    expect(runGate(dir).code).toBe(0);
  });

  it('allows authored JavaScript with no TypeScript of the same name', () => {
    const dir = repoWith({
      'app/src/legacy-helper.js': 'export const help = () => 1;\n',
      'app/src/main.ts': 'export const main = 1;\n',
    });
    expect(runGate(dir).code).toBe(0);
  });

  it('allows build output in dist, which is where it belongs', () => {
    const dir = repoWith({
      'pkg/src/thing.ts': 'export const a = 1;\n',
      'pkg/dist/thing.js': '// built\n',
      'pkg/dist/thing.d.ts': 'export declare const a: number;\n',
    });
    expect(runGate(dir).code).toBe(0);
  });

  it('allows a script outside any src directory', () => {
    const dir = repoWith({
      'scripts/do-a-thing.mjs': 'export const go = 1;\n',
      'scripts/do-a-thing.ts': 'export const go = 1;\n',
    });
    // Not under src, so not the pattern being guarded. Deliberately permissive:
    // the check is about compiled copies shadowing source, not about naming.
    expect(runGate(dir).code).toBe(0);
  });
});

describe('the character checks still work', () => {
  it('refuses a literal NUL in source', () => {
    const dir = repoWith({
      'pkg/src/bad.ts': `export const sep = '${String.fromCharCode(0)}';\n`,
    });
    const { code, output } = runGate(dir);
    expect(code).toBe(1);
    expect(output).toMatch(/forbidden character/u);
  });

  it('passes a clean tree', () => {
    const dir = repoWith({ 'pkg/src/good.ts': 'export const a = 1;\n' });
    const { code, output } = runGate(dir);
    expect(code).toBe(0);
    expect(output).toMatch(/no compiler artefacts beside source/u);
  });
});
