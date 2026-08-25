/** @author masterzee001 */
/**
 * Per-account critical sections for multi-step flows.
 *
 * MFA enrolment and verified email change span an await between reading a
 * record and writing it back. The lock ensures that read and write are not
 * interleaved with another operation.
 */
import { describe, expect, it } from 'vitest';
import { AccountStore, type AccountRecordPort } from '../account-store.js';

const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';

function store(records?: AccountRecordPort, now: () => number = () => 1_760_000_000_000) {
  let serial = 0;
  return new AccountStore(records, now, () => `000000000000000${++serial}`.slice(-16));
}

function memoryRecords(): AccountRecordPort & { rows: unknown[] } {
  const state: { rows: any[] } = { rows: [] };
  return {
    get rows() {
      return state.rows;
    },
    load: async () => state.rows,
    upsert: async (record: unknown) => {
      // Mirrors the real port: replace the row if present, append if not.
      const next = state.rows.filter(
        (row) => (row as { accountId?: string }).accountId !==
          (record as { accountId?: string }).accountId,
      );
      next.push(record);
      state.rows = next;
    },
  };
}

describe('account lock', () => {
  describe('serialisation', () => {
    it('two same-account operations serialise: an interleaved read cannot see half-applied state', async () => {
      const records = memoryRecords();
      const accounts = store(records);

      // Register an account.
      const result = await accounts.register({ email: EMAIL, password: PASSWORD });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const accountId = result.account.accountId;

      // Track the order of operations.
      const sequence: string[] = [];

      // Start two operations that both read, do async work, then write.
      const promise1 = accounts.withMutationLock(accountId, async (record) => {
        sequence.push('op1-read');
        // Interleave an async gap.
        await Promise.resolve();
        sequence.push('op1-write');
        return {
          record: record
            ? {
                ...record,
                voiceGender: 'male' as const,
              }
            : null,
          result: 'op1-complete',
        };
      });

      const promise2 = accounts.withMutationLock(accountId, async (record) => {
        sequence.push('op2-read');
        // Interleave an async gap.
        await Promise.resolve();
        sequence.push('op2-write');
        return {
          record: record
            ? {
                ...record,
                voiceGender: 'female' as const,
              }
            : null,
          result: 'op2-complete',
        };
      });

      await Promise.all([promise1, promise2]);

      // Verify that the operations did not interleave: one read-write pair
      // completed before the other read started.
      expect(sequence).toEqual(['op1-read', 'op1-write', 'op2-read', 'op2-write']);

      // Verify that the final state reflects the last operation.
      const final = records.rows[0] as any;
      expect(final.voiceGender).toBe('female');
    });

    it('different accounts run concurrently and do not block each other', async () => {
      const records = memoryRecords();
      const accounts = store(records);

      // Register two accounts.
      const result1 = await accounts.register({ email: 'alice@example.com', password: PASSWORD });
      const result2 = await accounts.register({ email: 'bob@example.com', password: PASSWORD });
      expect(result1.ok && result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      const accountId1 = result1.account.accountId;
      const accountId2 = result2.account.accountId;

      const sequence: string[] = [];

      // Start an operation on account1.
      const promise1 = accounts.withMutationLock(accountId1, async (record) => {
        sequence.push('acc1-start');
        // Long async gap.
        await new Promise((resolve) => setTimeout(resolve, 10));
        sequence.push('acc1-end');
        return {
          record: record
            ? {
                ...record,
                voiceGender: 'male' as const,
              }
            : null,
          result: 'acc1',
        };
      });

      // Immediately start an operation on account2; it should not wait.
      const promise2 = accounts.withMutationLock(accountId2, async (record) => {
        sequence.push('acc2-start');
        // No async gap; this should complete while account1 is waiting.
        sequence.push('acc2-end');
        return {
          record: record
            ? {
                ...record,
                voiceGender: 'female' as const,
              }
            : null,
          result: 'acc2',
        };
      });

      await Promise.all([promise1, promise2]);

      // Account2 should have started and ended while account1 was in its async gap.
      // The sequence should show account2 completing between account1's start and end.
      expect(sequence).toEqual(['acc1-start', 'acc2-start', 'acc2-end', 'acc1-end']);
    });
  });

  describe('failure handling', () => {
    it('a rejection does not wedge the chain: a later operation on the same account still runs', async () => {
      const records = memoryRecords();
      const accounts = store(records);

      // Register an account.
      const result = await accounts.register({ email: EMAIL, password: PASSWORD });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const accountId = result.account.accountId;

      const sequence: string[] = [];

      // Start an operation that rejects.
      const promise1 = accounts
        .withMutationLock(accountId, async () => {
          sequence.push('op1-start');
          // Simulate an async failure.
          await Promise.resolve();
          sequence.push('op1-reject');
          throw new Error('op1 failed');
        })
        .catch((e) => {
          sequence.push('op1-caught');
          return 'op1-error';
        });

      // Wait for the first operation to reject, then start a second one.
      await promise1;

      const promise2 = accounts.withMutationLock(accountId, async (record) => {
        sequence.push('op2-start');
        await Promise.resolve();
        sequence.push('op2-end');
        return {
          record,
          result: 'op2-complete',
        };
      });

      await promise2;

      // Verify that op2 ran despite op1's rejection.
      expect(sequence).toEqual([
        'op1-start',
        'op1-reject',
        'op1-caught',
        'op2-start',
        'op2-end',
      ]);
    });
  });

  describe('completion', async () => {
    it('the lock releases so a long sequence completes', async () => {
      const records = memoryRecords();
      const accounts = store(records);

      // Register an account.
      const result = await accounts.register({ email: EMAIL, password: PASSWORD });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const accountId = result.account.accountId;

      const completions: string[] = [];

      // Run a sequence of operations on the same account.
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await accounts.withMutationLock(accountId, async (record) => {
          completions.push(`op${i}`);
          // Simulate async work.
          await Promise.resolve();
          return {
            record,
            result: `result${i}`,
          };
        });
      }

      // All operations completed in order.
      expect(completions).toEqual(['op0', 'op1', 'op2', 'op3', 'op4']);
    });
  });
});
