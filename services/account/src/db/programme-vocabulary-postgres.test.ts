/** @author masterzee001 */
/**
 * Durable vocabulary: atomicity, serialization, and honest revisions.
 *
 * WHY A MODELLED POOL RATHER THAN A REAL DATABASE. These tests must run in CI
 * without Postgres, and the property under test is not "does SQL work" -- it is
 * whether THIS CODE takes the lock before it reads, bumps inside the same
 * transaction, and rolls both back together. The fake below implements exactly
 * the two behaviours the invariant depends on:
 *
 *   - `FOR UPDATE` on a programme's state row blocks a second writer for that
 *     SAME programme until the first COMMITs, and blocks nobody else
 *   - ROLLBACK discards every write made since BEGIN
 *
 * A fake that did not block would let the lost-revision bug pass, which is the
 * one thing these tests exist to catch. The real behaviour of `FOR UPDATE` is
 * Postgres's to guarantee; using it correctly is ours.
 */
import { describe, expect, it } from 'vitest';
import { createPostgresVocabulary } from './programme-vocabulary-postgres.js';
import type { VocabularyRecord } from '@videofy-live/programme-vocabulary/store';

interface Row {
  programme_id: string; entry_id: string; term: string;
  canonical_rendering: string; language: string; pronunciation_hint: string;
  do_not_translate: boolean; stt_keyterm: boolean; kind: string;
  notes: string; enabled: boolean; updated_at: string;
}

/**
 * A Postgres-shaped fake.
 *
 * `serialize: false` models a database WITHOUT the FOR UPDATE lock, which is
 * how the atomic-increment property gets tested on its own. Two experiments
 * established that this matters: with the lock working, a naive read-then-write
 * bump still passes everything; with an atomic bump, removing the lock still
 * passes everything. The defect needs BOTH protections gone, so a test suite
 * that only ever exercises both together cannot catch either being removed.
 */
function fakePool(options: {
  failOn?: RegExp;
  serialize?: boolean;
  /**
   * Hold the first statement matching this pattern until the returned latch is
   * released. Interleaving in a single-threaded fake is otherwise
   * scheduler-dependent, which produces a test that passes or fails by luck --
   * worse than no test. This makes the race deterministic.
   */
  pauseFirst?: RegExp;
} = {}) {
  const serialize = options.serialize !== false;
  let paused: { promise: Promise<void>; release: () => void } | null = null;
  let pauseArmed = options.pauseFirst !== undefined;
  const state = new Map<string, number>();
  const entries = new Map<string, Row>();
  const locks = new Map<string, Promise<void>>();
  // A REAL delimiter. Joining with nothing lets ("ab","c") and ("a","bc") land
  // on one entry, which in a test fake means two programmes silently sharing a
  // row -- the exact isolation failure these tests exist to detect. The same
  // slip already had to be fixed once in the billing key.
  const key = (p: string, e: string) => `${p}::${e}`;

  class Client {
    private inTx = false;
    private snapshot: { state: Map<string, number>; entries: Map<string, Row> } | null = null;
    private release_: (() => void) | null = null;

    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
      if (options.failOn?.test(sql)) throw new Error('injected failure');
      if (pauseArmed && options.pauseFirst?.test(sql)) {
        pauseArmed = false;
        let release!: () => void;
        const promise = new Promise<void>((r) => { release = r; });
        paused = { promise, release };
        await promise;
      }
      const text = sql.trim().toUpperCase();

      if (text.startsWith('BEGIN')) {
        this.inTx = true;
        this.snapshot = { state: new Map(state), entries: new Map(entries) };
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('COMMIT')) {
        this.inTx = false; this.snapshot = null;
        this.release_?.(); this.release_ = null;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('ROLLBACK')) {
        if (this.snapshot) {
          state.clear(); for (const [k, v] of this.snapshot.state) state.set(k, v);
          entries.clear(); for (const [k, v] of this.snapshot.entries) entries.set(k, v);
        }
        this.inTx = false; this.snapshot = null;
        this.release_?.(); this.release_ = null;
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('INSERT INTO PROGRAMME_VOCABULARY_STATE')) {
        const p = String(params[0]);
        if (!state.has(p)) state.set(p, 0);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('FROM PROGRAMME_VOCABULARY_STATE') && text.includes('FOR UPDATE')) {
        const p = String(params[0]);
        // Serialize: wait for any holder of THIS programme's lock, then take it.
        if (serialize) { while (locks.has(p)) await locks.get(p); }
        let release!: () => void;
        locks.set(p, new Promise<void>((r) => { release = () => { locks.delete(p); r(); }; }));
        this.release_ = release;
        return { rows: [{ revision: String(state.get(p) ?? 0) }], rowCount: 1 };
      }

      if (text.includes('FROM PROGRAMME_VOCABULARY_STATE') && text.includes('FOR SHARE')) {
        const p = String(params[0]);
        while (locks.has(p)) await locks.get(p);
        return { rows: [{ revision: String(state.get(p) ?? 0) }], rowCount: 1 };
      }

      if (text.startsWith('SELECT REVISION FROM PROGRAMME_VOCABULARY_STATE')) {
        return { rows: [{ revision: String(state.get(String(params[0])) ?? 0) }], rowCount: 1 };
      }

      if (text.includes('UPDATE PROGRAMME_VOCABULARY_STATE')) {
        const p = String(params[0]);
        // HONOUR THE SQL. An earlier version of this fake always incremented,
        // whatever the statement said -- so it modelled `SET revision =
        // revision + 1` even when the implementation wrote `SET revision = $2`,
        // and could never have caught a read-then-write bump. A fake that
        // silently corrects the code under test proves nothing about it.
        const next = text.includes('REVISION = REVISION + 1')
          ? (state.get(p) ?? 0) + 1
          : Number(params[1]);
        state.set(p, next);
        return { rows: [{ revision: String(next) }], rowCount: 1 };
      }

      if (text.includes('INSERT INTO PROGRAMME_VOCABULARY_ENTRIES')) {
        const [pid, eid, term, canon, lang, hint, dnt, stt, kind, notes, enabled] =
          params as [string, string, string, string, string, string, boolean, boolean, string, string, boolean];
        const k = key(pid, eid);
        const row: Row = {
          programme_id: pid, entry_id: eid, term, canonical_rendering: canon,
          language: lang, pronunciation_hint: hint, do_not_translate: dnt,
          stt_keyterm: stt, kind, notes, enabled,
          updated_at: new Date().toISOString(),
        };
        const existing = entries.get(k);
        const same =
          existing !== undefined &&
          existing.term === term && existing.canonical_rendering === canon &&
          existing.language === lang && existing.pronunciation_hint === hint &&
          existing.do_not_translate === dnt && existing.stt_keyterm === stt &&
          existing.kind === kind && existing.notes === notes &&
          existing.enabled === enabled;
        if (same) return { rows: [], rowCount: 0 };   // IS DISTINCT FROM: no change
        entries.set(k, row);
        return { rows: [{ changed: true }], rowCount: 1 };
      }

      if (text.startsWith('DELETE FROM PROGRAMME_VOCABULARY_ENTRIES')) {
        const k = key(String(params[0]), String(params[1]));
        const had = entries.delete(k);
        return { rows: [], rowCount: had ? 1 : 0 };
      }

      if (text.includes('FROM PROGRAMME_VOCABULARY_ENTRIES')) {
        const p = String(params[0]);
        return {
          rows: [...entries.values()].filter((r) => r.programme_id === p)
            .sort((a, b) => a.term.localeCompare(b.term)),
          rowCount: 0,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    release(): void {
      // A client returned to the pool while still holding a lock would deadlock
      // the next writer; releasing here mirrors what COMMIT/ROLLBACK did.
      this.release_?.(); this.release_ = null;
    }
  }

  return {
    pool: {
      connect: async () => new Client(),
      query: async (sql: string, params?: unknown[]) => new Client().query(sql, params),
    } as never,
    /** Block until a statement is parked. Releasing is a SEPARATE step, so the
     *  test can run the second writer while the first is genuinely held. */
    async waitUntilPaused(): Promise<void> {
      for (let i = 0; i < 5_000 && paused === null; i += 1) await Promise.resolve();
      if (paused === null) throw new Error('nothing ever paused; the hook did not fire');
    },
    release: () => paused?.release(),
    peekRevision: (p: string) => state.get(p) ?? 0,
    peekEntries: () => [...entries.values()],
  };
}

/** Asserts the mutation succeeded and returns its revision. */
function ok(outcome: { ok: boolean; revision?: number }): number {
  if (!outcome.ok) throw new Error('expected the mutation to succeed');
  return outcome.revision ?? -1;
}

function record(over: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    programmeId: 'prog_A', id: 'v1', term: 'Adéyẹmí', canonicalRendering: '',
    language: '*', pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'person', notes: '', enabled: true, updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('revision advances once per semantic change', () => {
  it('a create bumps exactly one', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    expect(ok(await db.upsert(record({ id: 'a' })))).toBe(1);
  });

  it('a real edit bumps exactly one', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ id: 'a', term: 'Lagos' }));
    expect(ok(await db.upsert(record({ id: 'a', term: 'Lagos', canonicalRendering: 'Èkó' }))))
      .toBe(2);
  });

  it('a NO-OP update bumps zero', async () => {
    // Telling every running session it is stale for a change that changed
    // nothing is a lie with a cost.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ id: 'a', term: 'Lagos' }));
    expect(ok(await db.upsert(record({ id: 'a', term: 'Lagos' })))).toBe(1);
  });

  it('one API call changing several fields is ONE revision', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ id: 'a', term: 'Lagos' }));
    const after = ok(await db.upsert(record({
      id: 'a', term: 'Lagos', canonicalRendering: 'Èkó',
      doNotTranslate: true, sttKeyterm: true, notes: 'agreed with the producer',
    })));
    expect(after).toBe(2);
  });

  it('a delete that removed something bumps one; a no-op delete bumps zero', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ id: 'a' }));
    expect(ok(await db.remove('prog_A', 'a'))).toBe(2);
    expect(ok(await db.remove('prog_A', 'a'))).toBe(2);
  });
});

describe('atomicity', () => {
  it('a failed mutation leaves NEITHER the row nor the revision', async () => {
    const f = fakePool({ failOn: /UPDATE programme_vocabulary_state/u });
    const db = createPostgresVocabulary(f.pool);
    await expect(db.upsert(record({ id: 'a' }))).rejects.toThrow(/injected failure/u);
    // A bumped revision over a rolled-back row would tell every running session
    // it is stale for a change that never landed.
    expect(f.peekRevision('prog_A')).toBe(0);
    expect(f.peekEntries()).toEqual([]);
  });
});

describe('concurrency serializes on the programme, and only on it', () => {
  it('two concurrent writers to ONE programme both land, revision reaches 2', async () => {
    // The lost-revision bug: both read 17, both write 18, both commit, and a
    // snapshot labelled 18 is missing one of the changes.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await Promise.all([
      db.upsert(record({ id: 'x', term: 'Adéyẹmí' })),
      db.upsert(record({ id: 'y', term: 'Chinelo' })),
    ]);
    const snap = await db.snapshotRead('prog_A');
    expect(snap.revision).toBe(2);
    expect(snap.entries.map((e) => e.id).sort()).toEqual(['x', 'y']);
  });

  it('three concurrent writers reach revision 3 with no lost mutation', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await Promise.all([
      db.upsert(record({ id: 'x' , term: 'X' })),
      db.upsert(record({ id: 'y', term: 'Y' })),
      db.upsert(record({ id: 'z', term: 'Z' })),
    ]);
    const snap = await db.snapshotRead('prog_A');
    expect(snap.revision).toBe(3);
    expect(snap.entries).toHaveLength(3);
  });

  it('a mutation on programme A does not block programme B', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await Promise.all([
      db.upsert(record({ programmeId: 'prog_A', id: 'a' })),
      db.upsert(record({ programmeId: 'prog_B', id: 'b' })),
    ]);
    // Each programme's revision moved once, independently.
    expect((await db.snapshotRead('prog_A')).revision).toBe(1);
    expect((await db.snapshotRead('prog_B')).revision).toBe(1);
  });

  it("programme A's mutation never increments programme B", async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ programmeId: 'prog_B', id: 'b' }));
    await db.upsert(record({ programmeId: 'prog_A', id: 'a1' }));
    await db.upsert(record({ programmeId: 'prog_A', id: 'a2' }));
    expect((await db.snapshotRead('prog_B')).revision).toBe(1);
    expect((await db.snapshotRead('prog_A')).revision).toBe(2);
  });
});

describe('the increment is atomic on its own, without the lock', () => {
  it('a DETERMINISTIC interleave still yields one revision per change', async () => {
    // Writer A is parked immediately before it bumps. Writer B runs to
    // completion in that window. A then resumes and bumps.
    //
    // With `SET revision = revision + 1` the database computes from the CURRENT
    // value, so A's bump lands on top of B's and the total is 2. With a
    // read-then-write bump, A read 0 before parking, stores 1, and B's change is
    // erased -- one revision for two committed edits, which is exactly the state
    // that makes a snapshot label a lie.
    const f = fakePool({ serialize: false, pauseFirst: /UPDATE programme_vocabulary_state/u });
    const db = createPostgresVocabulary(f.pool);

    const writerA = db.upsert(record({ id: 'x', term: 'X' }));
    await f.waitUntilPaused();          // A is now parked at its bump
    await db.upsert(record({ id: 'y', term: 'Y' }));   // B runs to completion
    f.release();                        // A resumes and bumps
    await writerA;

    expect(f.peekEntries()).toHaveLength(2);
    expect(f.peekRevision('prog_A')).toBe(2);
  });

  it('concurrent writers still reach one revision per change with NO serialization', async () => {
    // Isolates `SET revision = revision + 1` from the FOR UPDATE lock. This is
    // the test that fails if somebody rewrites the bump as read-then-write:
    // both writers would read the same value and both store it, losing one.
    const f = fakePool({ serialize: false });
    const db = createPostgresVocabulary(f.pool);
    await Promise.all([
      db.upsert(record({ id: 'x', term: 'X' })),
      db.upsert(record({ id: 'y', term: 'Y' })),
      db.upsert(record({ id: 'z', term: 'Z' })),
    ]);
    expect(f.peekRevision('prog_A')).toBe(3);
    expect(f.peekEntries()).toHaveLength(3);
  });

  it('and the rows and revision still agree afterwards', async () => {
    const f = fakePool({ serialize: false });
    const db = createPostgresVocabulary(f.pool);
    await Promise.all([
      db.upsert(record({ id: 'x', term: 'X' })),
      db.upsert(record({ id: 'y', term: 'Y' })),
    ]);
    const snap = await db.snapshotRead('prog_A');
    expect(snap.revision).toBe(snap.entries.length);
  });
});

describe('snapshot reads are internally consistent', () => {
  it('revision and rows come from one read', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ id: 'a', term: 'Lagos', doNotTranslate: true }));
    const snap = await db.snapshotRead('prog_A');
    expect(snap.revision).toBe(1);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.doNotTranslate).toBe(true);
  });

  it('restart and readback agree: the committed vocabulary is exactly what N holds', async () => {
    const f = fakePool();
    const first = createPostgresVocabulary(f.pool);
    await first.upsert(record({ id: 'a', term: 'Abéòkúta', canonicalRendering: 'Abeokuta' }));
    await first.upsert(record({ id: 'b', term: 'Chinelo', sttKeyterm: true }));

    // A NEW port over the same storage: what a process restart looks like.
    const afterRestart = createPostgresVocabulary(f.pool);
    const snap = await afterRestart.snapshotRead('prog_A');
    expect(snap.revision).toBe(2);
    expect(snap.entries.map((e) => e.term).sort()).toEqual(['Abéòkúta', 'Chinelo']);
    expect(snap.entries.find((e) => e.id === 'a')?.canonicalRendering).toBe('Abeokuta');
    expect(snap.entries.find((e) => e.id === 'b')?.sttKeyterm).toBe(true);
  });
});

describe('optimistic revision gate: a stale operator changes nothing', () => {
  it('runs the full A/B sequence', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);

    // Programme reaches revision 1 with one entry, which both operators open.
    ok(await db.upsert(record({ id: 'lagos', term: 'Lagos' })));
    const opened = (await db.snapshotRead('prog_A')).revision;
    expect(opened).toBe(1);

    // A edits from revision 1 and succeeds.
    const a = await db.upsert(
      record({ id: 'lagos', term: 'Lagos', canonicalRendering: 'Èkó' }), opened);
    expect(a.ok).toBe(true);
    expect(ok(a)).toBe(2);

    // B, still looking at revision 1, edits ANOTHER field of the same entry.
    // Without the gate this lands and silently erases A's canonical rendering.
    const b = await db.upsert(
      record({ id: 'lagos', term: 'Lagos', notes: 'B was here' }), opened);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.conflict).toBe('revision-conflict');
      expect(b.expectedRevision).toBe(1);
      expect(b.currentRevision).toBe(2);
    }

    // Nothing of B's landed, the revision did not move, A's value is intact.
    const after = await db.snapshotRead('prog_A');
    expect(after.revision).toBe(2);
    expect(after.entries[0]?.canonicalRendering).toBe('Èkó');
    expect(after.entries[0]?.notes).toBe('');

    // B reloads and retries against the current revision.
    const retry = await db.upsert(
      record({ id: 'lagos', term: 'Lagos', canonicalRendering: 'Èkó', notes: 'B was here' }),
      after.revision);
    expect(ok(retry)).toBe(3);
    const final = await db.snapshotRead('prog_A');
    expect(final.entries[0]?.canonicalRendering).toBe('Èkó');
    expect(final.entries[0]?.notes).toBe('B was here');
  });

  it('a stale DELETE is refused too', async () => {
    // A delete decided from a stale view discards whatever was edited since.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    ok(await db.upsert(record({ id: 'lagos', term: 'Lagos' })));
    const opened = 1;
    ok(await db.upsert(record({ id: 'lagos', term: 'Lagos', canonicalRendering: 'Èkó' }), opened));

    const stale = await db.remove('prog_A', 'lagos', opened);
    expect(stale.ok).toBe(false);
    expect((await db.snapshotRead('prog_A')).entries).toHaveLength(1);
  });

  it('a NO-OP with the CORRECT revision succeeds and does not bump', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    ok(await db.upsert(record({ id: 'lagos', term: 'Lagos' })));
    expect(ok(await db.upsert(record({ id: 'lagos', term: 'Lagos' }), 1))).toBe(1);
  });

  it('a NO-OP with a STALE revision is still a conflict', async () => {
    // The client is stale even when its requested end-state happens to match.
    // Accepting it would tell somebody their view was current when it was not,
    // and the next edit they make from that view would be wrong.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    ok(await db.upsert(record({ id: 'lagos', term: 'Lagos' })));
    ok(await db.upsert(record({ id: 'other', term: 'Kano' }), 1));   // revision 2

    const noop = await db.upsert(record({ id: 'lagos', term: 'Lagos' }), 1);
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.currentRevision).toBe(2);
  });

  it('omitting expectedRevision still works, for machine-initiated writes', async () => {
    // Operator paths must always send it; a seed or migration legitimately has
    // nothing to have looked at.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    expect(ok(await db.upsert(record({ id: 'seeded' })))).toBe(1);
  });

  it('a conflict performs NO mutation and NO bump', async () => {
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    ok(await db.upsert(record({ id: 'a', term: 'A' })));
    const before = f.peekEntries().length;
    await db.upsert(record({ id: 'b', term: 'B' }), 99);
    expect(f.peekEntries()).toHaveLength(before);
    expect(f.peekRevision('prog_A')).toBe(1);
  });
});

describe('programme scope is mandatory on every operation', () => {
  it.each(['revision', 'list', 'snapshotRead'] as const)('%s refuses an empty scope', async (op) => {
    const db = createPostgresVocabulary(fakePool().pool);
    await expect(db[op]('  ')).rejects.toThrow(/programmeId/u);
  });

  it('upsert refuses an empty scope', async () => {
    const db = createPostgresVocabulary(fakePool().pool);
    await expect(db.upsert(record({ programmeId: '' }))).rejects.toThrow(/programmeId/u);
  });

  it('remove refuses an empty scope', async () => {
    const db = createPostgresVocabulary(fakePool().pool);
    await expect(db.remove('', 'a')).rejects.toThrow(/programmeId/u);
  });

  it('delete keys on BOTH programme and entry id', async () => {
    // Deleting on entry_id alone would take the same id out of every programme
    // that happens to use it.
    const f = fakePool();
    const db = createPostgresVocabulary(f.pool);
    await db.upsert(record({ programmeId: 'prog_A', id: 'shared' }));
    await db.upsert(record({ programmeId: 'prog_B', id: 'shared' }));
    await db.remove('prog_A', 'shared');
    expect((await db.snapshotRead('prog_A')).entries).toEqual([]);
    expect((await db.snapshotRead('prog_B')).entries).toHaveLength(1);
  });
});
