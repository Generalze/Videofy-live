/** @author masterzee001 */
/**
 * Account records on disk — DEVELOPMENT PROTOTYPE.
 *
 * Same construction as the voice profile records: atomic temp-then-rename so a
 * crash cannot truncate every account at once, one writer at a time so two
 * saves cannot land out of order.
 *
 * This file contains password hashes. It lives in a git-ignored directory and
 * must never be committed, copied into a fixture, or pasted into an issue. It
 * is not encrypted at rest, which is acceptable for a local prototype and is
 * not acceptable for anything else.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AccountRecord, AccountRecordPort } from './account-store.js';

interface Snapshot {
  readonly version: 1;
  readonly accounts: readonly AccountRecord[];
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Snapshot>;
  return candidate.version === 1 && Array.isArray(candidate.accounts);
}

export function createFileAccountRecords(filePath: string): AccountRecordPort {
  const target = resolve(filePath);
  let queue: Promise<void> = Promise.resolve();

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
        // A damaged file is treated as no file. Guessing at half a record could
        // resurrect an account somebody deleted, or worse, mangle a hash into
        // one that never matches and lock them out permanently.
        return isSnapshot(parsed) ? parsed.accounts : [];
      } catch {
        return [];
      }
    },

    async save(accounts) {
      const write = queue.then(async () => {
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        const snapshot: Snapshot = { version: 1, accounts: [...accounts] };
        await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
        await rename(temporary, target);
      });
      queue = write.catch(() => {});
      await write;
    },
  };
}
