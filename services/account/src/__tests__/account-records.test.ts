/**
 * Account records on disk.
 *
 * These pin a data-loss path rather than a feature. `load` used to catch every
 * error and return an empty list, so one transient read failure hydrated zero
 * accounts and the next mutation persisted that emptiness over the real file --
 * every account gone, permanently, without corruption being involved.
 *
 * The rule now: a MISSING file is empty; an UNREADABLE one refuses to start.
 */
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileAccountRecords } from '../account-records.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'c7-records-'));
}

describe('loading account records', () => {
  it('treats a missing file as no accounts, which is a normal first run', async () => {
    const dir = await scratch();
    const port = createFileAccountRecords(join(dir, 'does-not-exist.json'));
    await expect(port.load()).resolves.toEqual([]);
  });

  it('round-trips what it saved', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    const port = createFileAccountRecords(target);
    const record = {
      accountId: 'acc_1',
      email: 'someone@example.com',
      passwordHash: 'not-a-real-hash',
      tokenVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await port.upsert(record as never);
    await expect(port.load()).resolves.toHaveLength(1);
  });

  /*
   * The defect. Previously this resolved to [], and the next save wrote an
   * empty snapshot over a file full of real accounts.
   */
  it('refuses to start when the file exists but is not valid JSON', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    await writeFile(target, '{ this is not json', 'utf8');

    const port = createFileAccountRecords(target);
    await expect(port.load()).rejects.toThrow(/not valid JSON/);
  });

  it('refuses to start on a file that parses but is not a snapshot', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    await writeFile(target, JSON.stringify({ version: 99, accounts: 'nope' }), 'utf8');

    const port = createFileAccountRecords(target);
    await expect(port.load()).rejects.toThrow(/not a recognised snapshot/);
  });

  /*
   * A truncated write from an interrupted deploy is the realistic version of
   * this, and it must not be mistaken for "no accounts yet".
   */
  it('refuses to start on a truncated file rather than reporting no accounts', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    await writeFile(target, '{"version":1,"accounts":[{"accountId":"acc_1"', 'utf8');

    const port = createFileAccountRecords(target);
    await expect(port.load()).rejects.toThrow();
  });

  it('names the file it refused, so the failure is actionable', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    await writeFile(target, 'garbage', 'utf8');

    const port = createFileAccountRecords(target);
    // Plain containment rather than a regex: the path is a Windows path and
    // escaping it into a pattern is its own source of false failures.
    const error = await port.load().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain(target);
  });

  it('explains why it refuses rather than merely failing', async () => {
    const dir = await scratch();
    const target = join(dir, 'accounts.json');
    await writeFile(target, 'garbage', 'utf8');

    const port = createFileAccountRecords(target);
    await expect(port.load()).rejects.toThrow(/Refusing to start/);
  });
});
