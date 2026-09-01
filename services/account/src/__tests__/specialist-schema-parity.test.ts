/** @author masterzee001 */
/**
 * The seams between the specialist schema, its port and its domain rules.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTE TESTS. The defect this
 * repository keeps producing is not a wrong function -- it is two correct
 * halves that disagree. An accounts INSERT listing twenty-three columns beside a
 * SELECT listing eighteen; a build script naming a workspace nine positions
 * after the one that imports it. Both halves review cleanly on their own, and
 * only the seam is wrong.
 *
 * So these read the SQL and the TypeScript as TEXT and compare them. No
 * database, no connection, no skip: they run wherever the rest of the suite
 * runs, which is the whole point of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUALIFICATION_STATES,
  SPECIALIST_CAPABILITIES,
  VOICE_PARTICIPATION_STATES,
} from '@videofy-live/language-specialist';

const here = dirname(fileURLToPath(import.meta.url));
const port = readFileSync(join(here, '..', 'db', 'specialist-records-postgres.ts'), 'utf8');
const migrations = readFileSync(join(here, '..', 'db', 'migrations.ts'), 'utf8');

/** The column list a `const NAME_COLUMNS = '...'` declaration holds. */
function columnList(constant: string): string[] {
  const start = port.indexOf(`const ${constant} =`);
  if (start < 0) throw new Error(`no ${constant} in the port`);
  const open = port.indexOf("'", start);
  const close = port.indexOf("'", open + 1);
  return port
    .slice(open + 1, close)
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/**
 * The columns a table has AFTER every migration has run.
 *
 * CREATE TABLE IS NOT THE SCHEMA. It was, while there was one migration; the
 * moment a follow-up adds or drops a column, reading only the CREATE says the
 * table has a shape it has not had since. This reader replays the ALTERs in
 * file order, which is the order they actually run, so the parity check
 * compares the port against the table as it will exist rather than as it was
 * first written.
 */
function tableColumns(table: string): string[] {
  const start = migrations.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`no CREATE TABLE for ${table}`);
  const body = migrations.slice(start, migrations.indexOf('\n    );', start));
  const columns = body
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/--[^\n]*/gu, '').trim())
    /*
     * `[a-z0-9_]+`, with the digits. Without them `sha256` and
     * `consent_text_sha256` were invisible to this reader, and the parity check
     * silently stopped covering the two columns that matter most.
     */
    .map(
      (line) =>
        /^([a-z0-9_]+)\s+(text|bigint|integer|boolean|jsonb|double)\b/u.exec(line)?.[1],
    )
    .filter((column): column is string => column !== undefined);

  /* Then every ADD and DROP against this table, in the order they run. */
  const alters = [
    ...migrations.matchAll(
      new RegExp(
        `ALTER TABLE\\s+${table}\\s+(ADD COLUMN IF NOT EXISTS|DROP COLUMN IF EXISTS)\\s+([a-z0-9_]+)`,
        'gu',
      ),
    ),
  ];
  for (const [, action, column] of alters) {
    if (column === undefined) continue;
    if (action?.startsWith('ADD')) {
      if (!columns.includes(column)) columns.push(column);
    } else {
      const at = columns.indexOf(column);
      if (at !== -1) columns.splice(at, 1);
    }
  }
  return columns;
}

/**
 * The tables whose whole shape crosses the seam.
 *
 * `specialist_review_verdicts` is deliberately absent: its port list carries
 * `verdict_id`, which the store synthesises rather than storing on the domain
 * record, so the two lists are legitimately different lengths. It has its own
 * assertion below.
 */
const PAIRS: readonly [string, string][] = [
  ['PROFILE_COLUMNS', 'specialist_profiles'],
  ['TRACK_COLUMNS', 'specialist_languages'],
  ['CONSENT_COLUMNS', 'specialist_consents'],
  ['DRAFT_COLUMNS', 'specialist_elicitation_drafts'],
  ['CORPUS_COLUMNS', 'specialist_source_corpora'],
  ['ASSIGNMENT_COLUMNS', 'specialist_assignments'],
  ['CANDIDATE_COLUMNS', 'specialist_review_candidates'],
  ['CAPABILITY_COLUMNS', 'specialist_capabilities'],
  ['DECISION_COLUMNS', 'specialist_decisions'],
  ['VERDICT_COLUMNS', 'specialist_review_verdicts'],
  ['SOURCE_SET_COLUMNS', 'specialist_source_sets'],
  ['VALIDATED_SOURCE_COLUMNS', 'specialist_validated_sources'],
];

describe('the port reads every column it writes', () => {
  for (const [constant, table] of PAIRS) {
    it(`${table} names only columns the table has`, () => {
      const declared = tableColumns(table);
      expect(columnList(constant).filter((column) => !declared.includes(column))).toEqual([]);
    });

    it(`${table} reads every column the table has`, () => {
      const used = columnList(constant);
      expect(tableColumns(table).filter((column) => !used.includes(column))).toEqual([]);
    });
  }
});

describe('the controlled lists in SQL match the ones in code', () => {
  /** The quoted values inside a `CHECK (<column> IN (...))`. */
  function checkList(after: string): string[] {
    const start = migrations.indexOf(after);
    if (start < 0) throw new Error(`no ${after} in the migration`);
    const open = migrations.indexOf('(', start + after.length - 1);
    const close = migrations.indexOf(')', open);
    return [...migrations.slice(open + 1, close).matchAll(/'([A-Z_]+)'/gu)].map(
      (match) => match[1] ?? '',
    );
  }

  it('PIN: the qualification states in the CHECK are exactly the nine in code', () => {
    // A state added in TypeScript and not here is accepted by every validator
    // and refused by the database -- a 500 on the day an operator picks it.
    expect(checkList('CHECK (state IN (')).toEqual([...QUALIFICATION_STATES]);
  });

  it('PIN: the capability CHECK is exactly the six in code', () => {
    expect(checkList('CHECK (capability IN (')).toEqual([...SPECIALIST_CAPABILITIES]);
  });

  it('PIN: the voice states in the CHECK are exactly the seven in code', () => {
    // The states are modelled so the schema can hold them; the CHECK below is
    // what keeps the programme closed.
    const start = migrations.indexOf('CREATE TABLE IF NOT EXISTS specialist_voice_participation');
    const body = migrations.slice(start);
    const open = body.indexOf('CHECK (state IN (');
    const values = [
      ...body
        .slice(open, body.indexOf(')', body.indexOf('(', open + 16)))
        .matchAll(/'([A-Z_]+)'/gu),
    ].map((match) => match[1] ?? '');
    expect(values).toEqual([...VOICE_PARTICIPATION_STATES]);
  });
});

describe('the rules that live in the database', () => {
  it('PIN: a frozen corpus is unique per (account, language, revision)', () => {
    // Three layers say this: the domain refuses, the port refuses, and this
    // constraint refuses. A silent overwrite is the one failure in this system
    // that leaves no trace at all.
    expect(migrations).toContain('UNIQUE (account_id, language, revision)');
  });

  it('PIN: a corpus cannot exist without the consent it was collected under', () => {
    expect(migrations).toContain(
      'consent_id      text   NOT NULL REFERENCES specialist_consents (consent_id)',
    );
  });

  it('PIN: the consent a corpus cites must be its OWN (finding 4)', () => {
    // The single-column reference above was satisfied by ANY consent row in the
    // table: Alice's Yoruba corpus could cite Bob's consent, or her own Hausa
    // one, and the licence record for that material would be a lie that reads
    // perfectly well. The composite key makes it unrepresentable.
    expect(migrations).toContain(
      'UNIQUE (consent_id, account_id, language, consent_version)',
    );
    expect(migrations).toContain(
      'FOREIGN KEY (consent_id, account_id, language, consent_version)',
    );
    expect(migrations).toContain(
      'REFERENCES specialist_consents (consent_id, account_id, language, consent_version)',
    );
  });

  it('PIN: a verdict cannot cross an assignment (finding 5)', () => {
    // Both composite keys, and both targets they need. Application-level
    // lookups caught these; the database now refuses the INSERT outright.
    expect(migrations).toContain('UNIQUE (candidate_id, assignment_id)');
    expect(migrations).toContain('FOREIGN KEY (candidate_id, assignment_id)');
    expect(migrations).toContain(
      'REFERENCES specialist_review_candidates (candidate_id, assignment_id)',
    );

    expect(migrations).toContain('UNIQUE (assignment_id, account_id)');
    expect(migrations).toContain('FOREIGN KEY (assignment_id, account_id)');
    expect(migrations).toContain(
      'REFERENCES specialist_assignments (assignment_id, account_id)',
    );
  });

  it('PIN: evidence is keyed by ATTEMPT, not by person and language (finding 1)', () => {
    // A draft unique only on (account, language) is a draft attempt 2 inherits
    // -- which is how a reassessment reported itself complete before a word had
    // been written.
    expect(migrations).toContain('UNIQUE (account_id, language, attempt)');
    expect(migrations).toContain('qualification_attempt integer NOT NULL DEFAULT 1');
  });

  it('PIN: a packet records the source it was built from (finding 2)', () => {
    expect(migrations).toContain('source_revision integer');
    expect(migrations).toContain('source_sha256 text');
  });

  it('PIN: a validated source is append-only, like the corpus (finding 7)', () => {
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS specialist_validated_sources');
    expect(migrations).toContain(
      'BEFORE UPDATE OR DELETE ON specialist_validated_sources',
    );
    expect(migrations).toContain("'SOURCE_VALIDATION'");
  });

  it('PIN: the dead approval column is dropped, not merely ignored (finding 9)', () => {
    // Nothing wrote it, nothing read it, and it contradicted the language
    // tracks beside it. A column left in place would be read by the next person
    // who found it.
    expect(migrations).toContain('DROP COLUMN IF EXISTS application_state');
    expect(tableColumns('specialist_profiles')).not.toContain('application_state');
  });

  it('PIN: the observed-language answer has somewhere to live (finding 8)', () => {
    expect(migrations).toContain('observed_language text');
    expect(tableColumns('specialist_review_verdicts')).toContain('observed_language');
  });

  it('PIN: one verdict per candidate per assignment', () => {
    expect(migrations).toContain('UNIQUE (assignment_id, candidate_id)');
  });

  it('PIN: the four evidence tables refuse UPDATE and DELETE', () => {
    for (const table of [
      'specialist_consents',
      'specialist_source_corpora',
      'specialist_review_verdicts',
      'specialist_decisions',
    ]) {
      expect(migrations, table).toContain(`BEFORE UPDATE OR DELETE ON ${table}`);
    }
  });

  it('PIN: voice rights are pinned false by a named constraint', () => {
    // Opening a voice programme means writing a migration that drops this
    // constraint BY NAME, which is a decision with an author rather than a
    // side effect of somebody setting a boolean.
    expect(migrations).toContain(
      'CONSTRAINT specialist_voice_rights_not_granted CHECK (voice_rights_granted = false)',
    );
    expect(migrations).toContain('voice_agreement_version text    CHECK (voice_agreement_version IS NULL)');
  });

  it('PIN: the append-only tables carry no ON CONFLICT DO UPDATE in the port', () => {
    // An upsert is the friendly choice everywhere else in that directory. Here
    // it would silently rewrite the record somebody's standing rests on.
    for (const table of [
      'specialist_consents',
      'specialist_source_corpora',
      'specialist_review_verdicts',
      'specialist_decisions',
    ]) {
      const insert = port.slice(port.indexOf(`INSERT INTO ${table} (`));
      const statement = insert.slice(0, insert.indexOf('`', 1));
      expect(statement, table).not.toContain('ON CONFLICT');
    }
  });
});

describe('the migration is appended, never reordered', () => {
  it('runs last, after every migration that shipped before it', () => {
    const order = migrations.slice(migrations.indexOf('export const MIGRATIONS'));
    expect(order.trimEnd().endsWith('SPECIALIST_SOURCE_PROVENANCE,\n];')).toBe(true);
  });

  it('PIN: 025 follows 024, and 024 is not edited either', () => {
    // The same rule one migration further on: 024 has also run against a local
    // specialist database, so the source-provenance keys are a third file
    // rather than an amendment to the second.
    const order = migrations.slice(migrations.indexOf('export const MIGRATIONS'));
    expect(order.indexOf('SPECIALIST_INTEGRITY')).toBeLessThan(
      order.indexOf('SPECIALIST_SOURCE_PROVENANCE'),
    );
    const names = [...migrations.matchAll(/name: '([0-9]{3}_[a-z_]+)'/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('025_specialist_source_provenance');
  });

  it('PIN: source provenance is a composite key, not a bare set id', () => {
    // `set_id` alone pointed at ANY set: Alice's frozen French source could name
    // the set C7 supplied to Bob, or her own Spanish one, or the set from her
    // previous attempt -- and the row would read perfectly well while attesting
    // that a fluent speaker had checked sentences never shown to them.
    expect(migrations).toContain('UNIQUE (set_id, account_id, language, attempt)');
    expect(migrations).toContain('FOREIGN KEY (set_id, account_id, language, revision)');
    expect(migrations).toContain(
      'REFERENCES specialist_source_sets (set_id, account_id, language, attempt)',
    );
    // And the packet side: a SOURCE_VALIDATION assignment may only name its own.
    expect(migrations).toContain(
      'FOREIGN KEY (source_set_id, account_id, language, qualification_attempt)',
    );
  });

  it('PIN: 024 FOLLOWS 023 rather than editing it', () => {
    // 023 has already run against a local specialist database. Editing it would
    // mean two databases that agree about which migrations ran and disagree
    // about what they did -- the failure the header of migrations.ts forbids.
    // So the integrity work is a follow-up.
    const order = migrations.slice(migrations.indexOf('export const MIGRATIONS'));
    expect(order.indexOf('LANGUAGE_SPECIALISTS')).toBeLessThan(
      order.indexOf('SPECIALIST_INTEGRITY'),
    );

    // And 023's own SQL is untouched: it still only CREATEs. An ALTER inside it
    // would be a rewrite of a migration that has run.
    const original = migrations.slice(
      migrations.indexOf("name: '023_language_specialists'"),
      migrations.indexOf("name: '024_specialist_integrity'"),
    );
    expect(original).toContain('CREATE TABLE IF NOT EXISTS specialist_profiles');
    expect(original).not.toContain('ALTER TABLE');
  });

  it('PIN: the 021 and 022 from main are preserved, and run BEFORE the specialist set', () => {
    // The specialist migrations began life as 021-023 while main was moving. At
    // the one authorised rebase onto Checkpoint C, main held 021 and 022, so the
    // specialist set became 023-025. Both halves have to be true: main's two
    // still exist unrenamed, and they run first -- a specialist table that came
    // up before the programme vocabulary it does not reference would be
    // harmless today and a silent ordering bug the first time it did.
    const names = [...migrations.matchAll(/name: '([0-9]{3}_[a-z_]+)'/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(names).toContain('021_programme_vocabulary');
    expect(names).toContain('022_programme_sponsored_creative');

    const order = migrations.slice(migrations.indexOf('export const MIGRATIONS'));
    expect(order.indexOf('PROGRAMME_VOCABULARY')).toBeLessThan(
      order.indexOf('LANGUAGE_SPECIALISTS'),
    );
    expect(order.indexOf('PROGRAMME_SPONSORED_CREATIVE')).toBeLessThan(
      order.indexOf('LANGUAGE_SPECIALISTS'),
    );

    // And nothing kept an old specialist number, which would collide with main's.
    expect(names).not.toContain('021_language_specialists');
    expect(names).not.toContain('022_specialist_integrity');
    expect(names).not.toContain('023_specialist_source_provenance');
  });

  it('carries a name that has not been used before', () => {
    const names = [...migrations.matchAll(/name: '([0-9]{3}_[a-z_]+)'/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('023_language_specialists');
  });
});
