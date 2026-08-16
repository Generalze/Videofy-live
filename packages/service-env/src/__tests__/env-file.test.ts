/** @author masterzee001 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../index.js';

const dirs: string[] = [];
const applied: string[] = [];

afterEach(async () => {
  for (const name of applied) delete process.env[name];
  applied.length = 0;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'videofy-env-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

function track(...names: string[]): void {
  applied.push(...names);
}

describe('loading configuration from a file', () => {
  it('applies simple values', () => {
    track('VF_ONE', 'VF_TWO');
    const result = loadEnvFile(envFile('VF_ONE=first\nVF_TWO=second\n'));

    expect(process.env['VF_ONE']).toBe('first');
    expect(result.applied).toEqual(['VF_ONE', 'VF_TWO']);
  });

  it('lets the real environment win, so an explicit override still works', () => {
    // Also what stops a stray development file overriding a deployment.
    track('VF_SET');
    process.env['VF_SET'] = 'from the shell';

    const result = loadEnvFile(envFile('VF_SET=from the file\n'));

    expect(process.env['VF_SET']).toBe('from the shell');
    expect(result.skipped).toEqual(['VF_SET']);
  });

  it('survives a UTF-8 BOM instead of losing the first variable', () => {
    // A BOM otherwise becomes part of the first name, producing a variable
    // nobody can read and a service that fails closed for no visible reason.
    track('VF_FIRST');
    loadEnvFile(envFile('\ufeffVF_FIRST=present\n'));

    expect(process.env['VF_FIRST']).toBe('present');
  });

  it('takes values literally, because this repository is full of paths', () => {
    // A Windows path, a comma-separated registry and a hash that is part of the
    // value. Every "helpful" transformation here corrupts one of them.
    track('VF_PATH', 'VF_LIST', 'VF_HASH');
    loadEnvFile(
      envFile(
        'VF_PATH=C:/Users/someone/models/voice.onnx\n' +
          'VF_LIST=en|a|C:/a.onnx,es|b|C:/b.onnx\n' +
          'VF_HASH=abc#not-a-comment\n',
      ),
    );

    expect(process.env['VF_PATH']).toBe('C:/Users/someone/models/voice.onnx');
    expect(process.env['VF_LIST']).toBe('en|a|C:/a.onnx,es|b|C:/b.onnx');
    expect(process.env['VF_HASH']).toBe('abc#not-a-comment');
  });

  it('unwraps a quoted value exactly once', () => {
    track('VF_QUOTED');
    loadEnvFile(envFile('VF_QUOTED="spaced value"\n'));

    expect(process.env['VF_QUOTED']).toBe('spaced value');
  });

  it('ignores comments, blank lines and anything that is not an assignment', () => {
    track('VF_REAL');
    const result = loadEnvFile(envFile('# a comment\n\n   \nnot an assignment\nVF_REAL=yes\n'));

    expect(result.applied).toEqual(['VF_REAL']);
  });

  it('refuses a name that is not a variable name', () => {
    // A line like `9LIVES=x` or `A B=x` is a typo, not configuration.
    const result = loadEnvFile(envFile('9LIVES=x\nA B=x\n=x\n'));

    expect(result.applied).toEqual([]);
  });

  it('reports names but never values, so the result is safe to log', () => {
    track('VF_SECRET');
    const result = loadEnvFile(envFile('VF_SECRET=hunter2\n'));

    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.applied).toContain('VF_SECRET');
  });

  it('treats a missing file as silence, not an error', () => {
    // `.env` is a development convenience and a service must start without one.
    const result = loadEnvFile(join(tmpdir(), 'videofy-definitely-absent', '.env'));

    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
  });
});
