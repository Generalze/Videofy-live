/** @author masterzee001 */
/**
 * The Postgres-shaped fake, shared with the durable-persistence tests.
 *
 * EXPORTED RATHER THAN COPIED. A second model of the database in the E2E would
 * be a second set of assumptions about locking, revisions and rollback -- and
 * the day they diverged, one suite would pass on behaviour the other forbids.
 * This is the same fake, including the correction that made it honour the
 * statement instead of always incrementing.
 */
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
export function makeFakePool(options: {
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

    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
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
