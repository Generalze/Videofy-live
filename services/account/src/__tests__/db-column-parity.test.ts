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

/**
 * The tariff port cannot have the accounts bug, because both statements
 * interpolate ONE `COLUMNS` constant -- there is no second list to drift from.
 * So this checks the two seams that constant still has: the table it claims to
 * describe, and the placeholders it is bound against.
 */
describe('billing tariffs', () => {
  const sql = source('tariff-records-postgres.ts');

  /** The shared constant, which both the SELECT and the INSERT interpolate. */
  function sharedColumns(): string[] {
    const match = /const COLUMNS =\s*([\s\S]*?);/u.exec(sql);
    if (match === null) throw new Error('no COLUMNS constant found');
    return splitColumns(match[1]!.replace(/['`\n]/g, ' '));
  }

  /** Columns the migration actually creates. */
  function migrationColumns(): string[] {
    const migrations = readFileSync(join(here, '..', 'db', 'migrations.ts'), 'utf8');
    const start = migrations.indexOf('CREATE TABLE IF NOT EXISTS billing_tariffs (');
    if (start < 0) throw new Error('billing_tariffs is not created by any migration');
    const open = migrations.indexOf('(', start);
    const close = migrations.indexOf(');', open);
    return migrations
      .slice(open + 1, close)
      .split('\n')
      .map((line) => line.trim().replace(/--.*$/u, '').trim())
      .map((line) => /^([a-z_]+)\s+(integer|bigint|text|jsonb)/u.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0);
  }

  it('names only columns the table has', () => {
    const declared = migrationColumns();
    expect(sharedColumns().filter((column) => !declared.includes(column))).toEqual([]);
  });

  /*
   * The other direction. A column added to the migration and forgotten here is
   * exactly the accounts bug -- written by nothing, read by nothing, and
   * invisible until someone needs the value.
   */
  it('reads every column the table has', () => {
    const used = sharedColumns();
    expect(migrationColumns().filter((column) => !used.includes(column))).toEqual([]);
  });

  /*
   * A column list and a VALUES list of different lengths is a runtime error on
   * the first publish, which is a poor place to find out.
   */
  it('binds exactly one placeholder per column', () => {
    const placeholders = [...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(sharedColumns().length);
  });
});

/** Same one-list guarantee as the tariff port; same two seams left to check. */
describe('devices', () => {
  const sql = source('device-records-postgres.ts');

  function sharedColumns(): string[] {
    const match = /const COLUMNS =\s*([\s\S]*?);/u.exec(sql);
    if (match === null) throw new Error('no COLUMNS constant found');
    return splitColumns(match[1]!.replace(/['`\n]/g, ' '));
  }

  function migrationColumns(): string[] {
    const migrations = readFileSync(join(here, '..', 'db', 'migrations.ts'), 'utf8');
    const start = migrations.indexOf('CREATE TABLE IF NOT EXISTS devices (');
    if (start < 0) throw new Error('devices is not created by any migration');
    const open = migrations.indexOf('(', start);
    const close = migrations.indexOf(');', open);
    return migrations
      .slice(open + 1, close)
      .split('\n')
      .map((line) => line.trim().replace(/--.*$/u, '').trim())
      .map((line) => /^([a-z_]+)\s+(integer|bigint|text|jsonb)/u.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0);
  }

  /* Guard against a vacuous pass: empty lists would satisfy both filters. */
  it('actually found columns to compare', () => {
    expect(sharedColumns().length).toBeGreaterThan(0);
    expect(migrationColumns().length).toBeGreaterThan(0);
  });

  it('names only columns the table has', () => {
    const declared = migrationColumns();
    expect(sharedColumns().filter((column) => !declared.includes(column))).toEqual([]);
  });

  it('reads every column the table has', () => {
    const used = sharedColumns();
    expect(migrationColumns().filter((column) => !used.includes(column))).toEqual([]);
  });

  it('binds exactly one placeholder per column on insert', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO devices'), sql.indexOf('ON CONFLICT'));
    const placeholders = [...insert.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(sharedColumns().length);
  });
});

/** Same one-list guarantee as tariffs and devices. */
describe('messages', () => {
  const sql = source('message-records-postgres.ts');

  function sharedColumns(): string[] {
    const match = /const COLUMNS =\s*([\s\S]*?);/u.exec(sql);
    if (match === null) throw new Error('no COLUMNS constant found');
    return splitColumns(match[1]!.replace(/['`\n]/g, ' '));
  }

  function migrationColumns(): string[] {
    const migrations = readFileSync(join(here, '..', 'db', 'migrations.ts'), 'utf8');
    const start = migrations.indexOf('CREATE TABLE IF NOT EXISTS messages (');
    if (start < 0) throw new Error('messages is not created by any migration');
    const open = migrations.indexOf('(', start);
    const close = migrations.indexOf(');', open);
    return migrations
      .slice(open + 1, close)
      .split('\n')
      .map((line) => line.trim().replace(/--.*$/u, '').trim())
      .map((line) => /^([a-z_]+)\s+(integer|bigint|text|jsonb)/u.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0);
  }

  it('actually found columns to compare', () => {
    expect(sharedColumns().length).toBeGreaterThan(0);
    expect(migrationColumns().length).toBeGreaterThan(0);
  });

  it('names only columns the table has', () => {
    const declared = migrationColumns();
    expect(sharedColumns().filter((column) => !declared.includes(column))).toEqual([]);
  });

  it('reads every column the table has', () => {
    const used = sharedColumns();
    expect(migrationColumns().filter((column) => !used.includes(column))).toEqual([]);
  });

  it('binds exactly one placeholder per column on insert', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO messages'), sql.indexOf('async conversation'));
    const placeholders = [...insert.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(sharedColumns().length);
  });
});
