/**
 * Every column that is WRITTEN must also be READ.
 *
 * THE BUG THIS EXISTS FOR, found by deploying and looking rather than by any
 * test here: the accounts INSERT listed twenty-three columns and the SELECT
 * listed eighteen. `username`, `username_key`, `display_name`,
 * `discovery_mode` and `pending_identity_change` were written on every save and
 * silently dropped on every restart. Contacts survived a restart; the username
 * on the account they pointed at came back null.
 *
 * It passed every existing test because the Postgres suite skips without a live
 * database, and it looked correct in review because each half is correct on its
 * own -- the insert writes everything, the mapper maps everything. Only the seam
 * between them was wrong, which is the shape almost every real defect in this
 * repository has had.
 *
 * So this reads the SQL as TEXT and compares the two lists. No database, no
 * connection, no skip -- it runs everywhere the rest of the suite runs, which is
 * the entire point. A column added to one list and not the other fails here
 * immediately instead of on somebody's next restart.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(join(here, '..', 'db', file), 'utf8');
}

/** The column names between `INSERT INTO <table> (` and the closing paren. */
function insertColumns(sql: string, table: string): string[] {
  const start = sql.indexOf(`INSERT INTO ${table} (`);
  if (start < 0) throw new Error(`no INSERT INTO ${table} found`);
  const open = sql.indexOf('(', start);
  const close = sql.indexOf(')', open);
  return splitColumns(sql.slice(open + 1, close));
}

/** The column names between the first `SELECT` and its `FROM <table>`. */
function selectColumns(sql: string, table: string): string[] {
  const from = sql.indexOf(`FROM ${table}`);
  if (from < 0) throw new Error(`no FROM ${table} found`);
  const select = sql.lastIndexOf('SELECT', from);
  return splitColumns(sql.slice(select + 'SELECT'.length, from));
}

function splitColumns(fragment: string): string[] {
  return fragment
    // Comments inside the fragment would otherwise be read as column names.
    .replace(/--[^\n]*/g, ' ')
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0 && /^[a-z_]+$/.test(column));
}

describe('accounts', () => {
  const sql = source('account-records-postgres.ts');

  it('reads back every column it writes', () => {
    const written = insertColumns(sql, 'accounts');
    const read = selectColumns(sql, 'accounts');

    expect(written.length).toBeGreaterThan(15);
    const missing = written.filter((column) => !read.includes(column));
    expect(missing).toEqual([]);
  });

  /*
   * The reverse direction matters less but is still a mistake worth catching: a
   * column read and never written is one nothing can ever populate.
   */
  it('writes every column it reads back', () => {
    const written = insertColumns(sql, 'accounts');
    const read = selectColumns(sql, 'accounts');

    expect(read.filter((column) => !written.includes(column))).toEqual([]);
  });

  /*
   * The placeholders and the column list have to agree in COUNT, or the values
   * land in the wrong columns -- which is the same defect wearing a disguise
   * that no amount of reading catches.
   */
  it('has one placeholder for every column it writes', () => {
    const written = insertColumns(sql, 'accounts');
    const values = /VALUES \(([^)]+)\)/.exec(sql)?.[1] ?? '';
    const placeholders = values.split(',').filter((part) => part.trim().startsWith('$'));

    expect(placeholders).toHaveLength(written.length);
  });
});

describe('contacts', () => {
  const sql = source('contact-records-postgres.ts');

  it('reads back every column it writes', () => {
    const written = insertColumns(sql, 'contacts');
    const read = selectColumns(sql, 'contacts');

    expect(written.filter((column) => !read.includes(column))).toEqual([]);
  });

  it('reads back every column it writes for invites', () => {
    const written = insertColumns(sql, 'contact_invites');
    const read = selectColumns(sql, 'contact_invites');

    expect(written.filter((column) => !read.includes(column))).toEqual([]);
  });
});
