/** @author masterzee001 */
/**
 * A Postgres-shaped fake for the sponsored creative table.
 *
 * SEPARATE FROM THE VOCABULARY FAKE because it is a different schema, not a
 * different opinion: one row per programme rather than a state row plus
 * entries. Sharing one fake across both would mean a model that is wrong for
 * each in a different way.
 *
 * IT HONOURS THE STATEMENT. The vocabulary fake once incremented on every
 * UPDATE regardless of what the SQL said, which made three concurrency tests
 * pass while proving nothing. So this one actually implements the two clauses
 * the store depends on: `FOR UPDATE` serialises writers on a programme, and
 * `IS DISTINCT FROM` returns zero rows when nothing semantic changed -- which
 * is what makes a no-op leave the revision alone.
 */
interface CreativeRow {
    programme_id: string;
    revision: number;
    headline: string;
    body: string;
    cta: string;
    href: string | null;
    enabled: boolean;
    starts_at: Date | null;
    ends_at: Date | null;
}
export declare function makeCreativeFakePool(options?: {
    serialize?: boolean;
    /**
     * Hold the FIRST statement matching this pattern until the latch is released.
     *
     * Interleaving in a single-threaded fake is otherwise scheduler-dependent,
     * which produces a test that passes or fails by luck -- worse than no test.
     * This makes a chosen race deterministic.
     */
    pauseFirst?: RegExp;
}): {
    pool: never;
    /** Release a statement parked by `pauseFirst`. */
    resume(): void;
    /** Has the parked statement been reached yet? */
    isPaused(): boolean;
    /** For assertions that want to look straight at storage. */
    peek(programmeId: string): CreativeRow | undefined;
};
export {};
//# sourceMappingURL=sponsoredCreativeFakePool.d.ts.map