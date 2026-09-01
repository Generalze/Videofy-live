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

/** The columns a `CREATE TABLE` in the migration declares. */
function tableColumns(table: string): string[] {
  const start = migrations.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`no CREATE TABLE for ${table}`);
  const body = migrations.slice(start, migrations.indexOf('\n    );', start));
  return body
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/--[^\n]*/gu, '').trim())
    /*
     * `[a-z0-9_]+`, with the digits. Without them `sha256` and
     * `consent_text_sha256` were invisible to this reader, and the parity check
     * silently stopped covering the two columns that matter most.
     */
    .map((line) => /^([a-z0-9_]+)\s+(text|bigint|integer|boolean|jsonb|double)\b/u.exec(line)?.[1])
    .filter((column): column is string => column !== undefined);
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
    expect(order.trimEnd().endsWith('LANGUAGE_SPECIALISTS,\n];')).toBe(true);
  });

  it('carries a name that has not been used before', () => {
    const names = [...migrations.matchAll(/name: '([0-9]{3}_[a-z_]+)'/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('021_language_specialists');
  });
});
