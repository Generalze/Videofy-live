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
 *
 * READ FAILURES REFUSE TO START. See load(): treating an unreadable file as an
 * empty one turned a momentary read error into permanent, total account loss,
 * because the next write persisted the empty store over the real file.
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
      let raw: string;
      try {
        raw = await readFile(target, 'utf8');
      } catch (error) {
        /*
         * NO FILE is the only error that may resolve to "no accounts".
         *
         * Everything else -- a permission problem, a bad disk, a half-written
         * file from an interrupted deploy -- REFUSES TO START, and that refusal
         * is the whole point of this branch.
         *
         * Returning [] for any failure was a silent, total data-loss path, and
         * corruption was not even required to trigger it. One transient read
         * error would hydrate zero accounts, and the very next mutation would
         * call persist() and write an empty snapshot over the real file. Every
         * account, permanently, from a momentary failure to read.
         *
         * Refusing to start is loud, recoverable, and leaves the file intact
         * for somebody to inspect. Starting empty is quiet and unrecoverable.
         */
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw new Error(
          `account records at ${target} exist but could not be read: ` +
            `${(error as Error)?.message ?? 'unknown error'}. ` +
            'Refusing to start with an empty account store, because the first write ' +
            'would overwrite the file and destroy every account.',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A damaged file must not be guessed at. Half a record could resurrect
        // an account somebody deleted, or mangle a hash into one that never
        // matches and lock them out permanently.
        throw new Error(
          `account records at ${target} are not valid JSON. Refusing to start rather ` +
            'than overwriting them with an empty store. Restore from backup or move the ' +
            'file aside deliberately.',
        );
      }

      if (!isSnapshot(parsed)) {
        throw new Error(
          `account records at ${target} are not a recognised snapshot. Refusing to start.`,
        );
      }
      return parsed.accounts;
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
