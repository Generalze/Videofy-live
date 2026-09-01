/** @author masterzee001 */
/**
 * Durable programme vocabulary, where a revision means one coherent state.
 *
 * TRANSACTION ATOMICITY IS NOT ENOUGH, and that is the whole reason this file
 * is longer than a set of queries. Two operators editing one programme can each
 * read revision 17, each change a different term, and each write 18. Both
 * commits succeed, both terms land, and the revision advanced once -- so a
 * snapshot labelled 18 is missing a change that is actually in the rows, and
 * every consumer trusting that number is wrong without any error anywhere.
 *
 * So mutations SERIALIZE on the programme's state row: `SELECT ... FOR UPDATE`
 * before the write, release at COMMIT. The second writer waits, re-reads, and
 * produces 19. The lock is keyed by programme, so A never blocks B.
 *
 * SNAPSHOT READS ARE ALSO A TRANSACTION, taking `FOR SHARE` on the same row.
 * Reading the revision and then the rows as two independent statements lets a
 * writer commit between them, and the caller would label the NEW rows with the
 * OLD revision -- the same inconsistency from the other direction. `FOR SHARE`
 * lets many readers proceed together while excluding a writer, which is exactly
 * the asymmetry wanted.
 *
 * THE REVISION ADVANCES ONCE PER SEMANTIC CHANGE. Not per statement: one API
 * call editing four fields of one term is one revision. Not on a no-op: an
 * UPDATE whose values match what is already stored leaves it alone, because
 * telling every running session it is stale for a change that changed nothing
 * is a lie with a cost.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  VocabularyRecord,
} from '@videofy-live/programme-vocabulary/store';

/**
 * What an operator's mutation returns.
 *
 * A CONFLICT is not an error in the software; it is the software noticing that
 * two people edited the same thing and refusing to pick a winner silently.
 */
export type MutationOutcome<T> =
  | ({ ok: true; revision: number } & T)
  | { ok: false; conflict: 'revision-conflict'; expectedRevision: number; currentRevision: number };

export interface DurableVocabularyPort {
  revision(programmeId: string): Promise<number>;
  list(programmeId: string): Promise<readonly VocabularyRecord[]>;
  /** Revision and rows from ONE consistent read. */
  snapshotRead(programmeId: string): Promise<{
    revision: number;
    entries: readonly VocabularyRecord[];
  }>;
  /**
   * @param expectedRevision the revision the operator was LOOKING AT.
   *
   * Database serialization orders concurrent writes; it cannot tell that the
   * second writer decided from stale information. Two operators both open
   * revision 17, A commits 18, and B -- still reading 17 -- submits a change to
   * the same entry built on a value A has already replaced. Both writes are
   * orderly and one person's work is gone.
   *
   * Omitted means "I did not look first", which is only legitimate for
   * machine-initiated writes. Operator paths must always send it.
   */
  upsert(
    record: VocabularyRecord,
    expectedRevision?: number,
  ): Promise<MutationOutcome<{ record: VocabularyRecord }>>;
  remove(
    programmeId: string,
    entryId: string,
    expectedRevision?: number,
  ): Promise<MutationOutcome<{ removed: boolean }>>;
}

function requireProgramme(programmeId: string, operation: string): void {
  if (programmeId.trim() === '') {
    // The invariant, enforced here rather than trusted from callers: no
    // application-level vocabulary read or write without an explicit scope.
    throw new Error(`${operation} requires a non-empty programmeId`);
  }
}

function toRecord(row: Record<string, unknown>): VocabularyRecord {
  return {
    programmeId: String(row['programme_id']),
    id: String(row['entry_id']),
    term: String(row['term']),
    canonicalRendering: String(row['canonical_rendering'] ?? ''),
    language: String(row['language'] ?? '*'),
    pronunciationHint: String(row['pronunciation_hint'] ?? ''),
    doNotTranslate: row['do_not_translate'] === true,
    sttKeyterm: row['stt_keyterm'] === true,
    kind: String(row['kind'] ?? 'programme-term') as VocabularyRecord['kind'],
    notes: String(row['notes'] ?? ''),
    enabled: row['enabled'] !== false,
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

const SELECT_COLUMNS = `
  programme_id, entry_id, term, canonical_rendering, language,
  pronunciation_hint, do_not_translate, stt_keyterm, kind, notes,
  enabled, updated_at
`;

/** Ensure the state row exists, then lock it. Every mutation starts here. */
async function lockProgramme(client: PoolClient, programmeId: string): Promise<number> {
  await client.query(
    `INSERT INTO programme_vocabulary_state (programme_id, revision)
     VALUES ($1, 0) ON CONFLICT (programme_id) DO NOTHING`,
    [programmeId],
  );
  const { rows } = await client.query<{ revision: string }>(
    `SELECT revision FROM programme_vocabulary_state
     WHERE programme_id = $1 FOR UPDATE`,
    [programmeId],
  );
  return Number(rows[0]?.revision ?? 0);
}

async function bump(client: PoolClient, programmeId: string): Promise<number> {
  const { rows } = await client.query<{ revision: string }>(
    `UPDATE programme_vocabulary_state
     SET revision = revision + 1, updated_at = now()
     WHERE programme_id = $1
     RETURNING revision`,
    [programmeId],
  );
  return Number(rows[0]?.revision ?? 0);
}

export function createPostgresVocabulary(pool: Pool): DurableVocabularyPort {
  return {
    async revision(programmeId) {
      requireProgramme(programmeId, 'revision');
      const { rows } = await pool.query<{ revision: string }>(
        'SELECT revision FROM programme_vocabulary_state WHERE programme_id = $1',
        [programmeId],
      );
      return Number(rows[0]?.revision ?? 0);
    },

    async list(programmeId) {
      requireProgramme(programmeId, 'list');
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM programme_vocabulary_entries
         WHERE programme_id = $1 ORDER BY term`,
        [programmeId],
      );
      return rows.map(toRecord);
    },

    async snapshotRead(programmeId) {
      requireProgramme(programmeId, 'snapshotRead');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // FOR SHARE: readers proceed together, a writer cannot cross the
        // snapshot while it is being assembled. Without this the revision and
        // the rows can come from either side of somebody's commit.
        const state = await client.query<{ revision: string }>(
          `SELECT revision FROM programme_vocabulary_state
           WHERE programme_id = $1 FOR SHARE`,
          [programmeId],
        );
        const entries = await client.query(
          `SELECT ${SELECT_COLUMNS} FROM programme_vocabulary_entries
           WHERE programme_id = $1 ORDER BY term`,
          [programmeId],
        );
        await client.query('COMMIT');
        return {
          revision: Number(state.rows[0]?.revision ?? 0),
          entries: entries.rows.map(toRecord),
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async upsert(record, expectedRevision) {
      requireProgramme(record.programmeId, 'upsert');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const currentRevision = await lockProgramme(client, record.programmeId);

        // THE OPTIMISTIC GATE, checked after the lock and before any write.
        // Rolling back here means no entry mutation and no bump -- a stale
        // operator changes nothing at all, rather than changing something on
        // top of work they never saw.
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          await client.query('ROLLBACK');
          return {
            ok: false as const,
            conflict: 'revision-conflict' as const,
            expectedRevision,
            currentRevision,
          };
        }

        // `IS DISTINCT FROM` across every semantic column, so a write whose
        // values match what is stored reports no change and the revision holds.
        // ONE statement for the whole term: an API call editing four fields is
        // one semantic change, not four.
        const { rows } = await client.query<{ changed: boolean }>(
          `INSERT INTO programme_vocabulary_entries (
             programme_id, entry_id, term, canonical_rendering, language,
             pronunciation_hint, do_not_translate, stt_keyterm, kind, notes,
             enabled, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           ON CONFLICT (programme_id, entry_id) DO UPDATE SET
             term = EXCLUDED.term,
             canonical_rendering = EXCLUDED.canonical_rendering,
             language = EXCLUDED.language,
             pronunciation_hint = EXCLUDED.pronunciation_hint,
             do_not_translate = EXCLUDED.do_not_translate,
             stt_keyterm = EXCLUDED.stt_keyterm,
             kind = EXCLUDED.kind,
             notes = EXCLUDED.notes,
             enabled = EXCLUDED.enabled,
             updated_at = now()
           WHERE (
             programme_vocabulary_entries.term,
             programme_vocabulary_entries.canonical_rendering,
             programme_vocabulary_entries.language,
             programme_vocabulary_entries.pronunciation_hint,
             programme_vocabulary_entries.do_not_translate,
             programme_vocabulary_entries.stt_keyterm,
             programme_vocabulary_entries.kind,
             programme_vocabulary_entries.notes,
             programme_vocabulary_entries.enabled
           ) IS DISTINCT FROM (
             EXCLUDED.term, EXCLUDED.canonical_rendering, EXCLUDED.language,
             EXCLUDED.pronunciation_hint, EXCLUDED.do_not_translate,
             EXCLUDED.stt_keyterm, EXCLUDED.kind, EXCLUDED.notes, EXCLUDED.enabled
           )
           RETURNING true AS changed`,
          [
            record.programmeId, record.id, record.term, record.canonicalRendering,
            record.language, record.pronunciationHint, record.doNotTranslate,
            record.sttKeyterm, record.kind, record.notes, record.enabled,
          ],
        );

        const changed = rows.length > 0;
        const revision = changed
          ? await bump(client, record.programmeId)
          : Number(
              (await client.query<{ revision: string }>(
                'SELECT revision FROM programme_vocabulary_state WHERE programme_id = $1',
                [record.programmeId],
              )).rows[0]?.revision ?? 0,
            );

        await client.query('COMMIT');
        return { ok: true as const, record, revision };
      } catch (error) {
        // Neither the row nor the revision survives. A bumped revision over a
        // rolled-back row would tell every running session it is stale for a
        // change that never landed.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async remove(programmeId, entryId, expectedRevision) {
      requireProgramme(programmeId, 'remove');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const currentRevision = await lockProgramme(client, programmeId);
        // A delete decided from a stale view is the same hazard: the entry may
        // have been edited since, and removing it discards that edit too.
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          await client.query('ROLLBACK');
          return {
            ok: false as const,
            conflict: 'revision-conflict' as const,
            expectedRevision,
            currentRevision,
          };
        }
        const { rowCount } = await client.query(
          // BOTH keys. Deleting on entry_id alone would take the same id out of
          // every programme that happens to use it.
          'DELETE FROM programme_vocabulary_entries WHERE programme_id = $1 AND entry_id = $2',
          [programmeId, entryId],
        );
        const removed = (rowCount ?? 0) > 0;
        const revision = removed
          ? await bump(client, programmeId)
          : Number(
              (await client.query<{ revision: string }>(
                'SELECT revision FROM programme_vocabulary_state WHERE programme_id = $1',
                [programmeId],
              )).rows[0]?.revision ?? 0,
            );
        await client.query('COMMIT');
        return { ok: true as const, removed, revision };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
