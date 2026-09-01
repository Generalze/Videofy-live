/** @author masterzee001 */
/**
 * The operator vocabulary API, over HTTP, as a console actually receives it.
 *
 * The three properties worth testing are the ones whose absence is invisible:
 * a body-supplied programmeId being preferred over the authorised one, a
 * missing precondition quietly behaving like last-write-wins, and a 409 that
 * nevertheless changed something.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerVocabularyRoutes } from '../vocabulary-routes.js';
import type { DurableVocabularyPort } from '../db/programme-vocabulary-postgres.js';
import type { VocabularyRecord } from '@videofy-live/programme-vocabulary/store';

/** Records every call, so the test can see what the route actually asked for. */
function fakePort() {
  const entries = new Map<string, VocabularyRecord>();
  const calls: { op: string; programmeId: string; expectedRevision?: number | undefined }[] = [];
  let revision = 7;
  let conflictOn: number | null = null;

  const port: DurableVocabularyPort = {
    async revision() { return revision; },
    async list() { return [...entries.values()]; },
    async snapshotRead(programmeId) {
      calls.push({ op: 'snapshotRead', programmeId });
      return { revision, entries: [...entries.values()] };
    },
    async upsert(record, expectedRevision) {
      calls.push({ op: 'upsert', programmeId: record.programmeId, expectedRevision });
      if (conflictOn !== null && expectedRevision !== conflictOn) {
        return {
          ok: false, conflict: 'revision-conflict',
          expectedRevision: expectedRevision ?? -1, currentRevision: revision,
        };
      }
      entries.set(record.id, record);
      revision += 1;
      return { ok: true, record, revision };
    },
    async remove(programmeId, entryId, expectedRevision) {
      calls.push({ op: 'remove', programmeId, expectedRevision });
      if (conflictOn !== null && expectedRevision !== conflictOn) {
        return {
          ok: false, conflict: 'revision-conflict',
          expectedRevision: expectedRevision ?? -1, currentRevision: revision,
        };
      }
      const removed = entries.delete(entryId);
      if (removed) revision += 1;
      return { ok: true, removed, revision };
    },
  };
  return {
    port, calls, entries,
    get revision() { return revision; },
    forceConflictUnless: (expected: number) => { conflictOn = expected; },
  };
}

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly fake: ReturnType<typeof fakePort>;
}

async function harness(options: {
  signedIn?: boolean;
  mayAdminister?: boolean;
} = {}): Promise<Harness> {
  const fake = fakePort();
  const app = express();
  app.use(express.json());
  registerVocabularyRoutes(app, {
    vocabulary: fake.port,
    callerAccountId: () =>
      options.signedIn === false ? null : { accountId: 'acct_1' },
    mayAdminister: async () => options.mayAdminister !== false,
  });
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    fake,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function call(h: Harness, method: string, path: string, body?: unknown) {
  const response = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}

const ENTRY = { term: 'Lagos', canonicalRendering: 'Èkó', doNotTranslate: true };

describe('GET returns revision and entries together', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('answers with the programme, revision and entries', async () => {
    h = await harness();
    const r = await call(h, 'GET', '/operator/programmes/prog_A/vocabulary');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ programmeId: 'prog_A', revision: 7 });
    expect(Array.isArray(r.body.entries)).toBe(true);
  });

  it('reads from ONE consistent snapshot, not two queries', async () => {
    h = await harness();
    await call(h, 'GET', '/operator/programmes/prog_A/vocabulary');
    expect(h.fake.calls.map((c) => c.op)).toEqual(['snapshotRead']);
  });
});

describe('expectedRevision is required at the operator boundary', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it.each([
    ['missing', {}],
    ['null', { expectedRevision: null }],
    ['empty string', { expectedRevision: '' }],
    ['fractional', { expectedRevision: 3.5 }],
    ['negative', { expectedRevision: -1 }],
    ['nonsense', { expectedRevision: 'soon' }],
  ])('%s is a 400 and touches nothing', async (_label, extra) => {
    h = await harness();
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, ...extra });
    expect(r.status).toBe(400);
    // Nothing reached the port at all.
    expect(h.fake.calls.filter((c) => c.op === 'upsert')).toHaveLength(0);
    expect(h.fake.revision).toBe(7);
  });

  it('a numeric string is accepted, because HTTP carries strings', async () => {
    h = await harness();
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: '7' });
    expect(r.status).toBe(200);
  });

  it('DELETE has the identical precondition', async () => {
    h = await harness();
    const r = await call(h, 'DELETE', '/operator/programmes/prog_A/vocabulary/lagos', {});
    expect(r.status).toBe(400);
    expect(h.fake.calls.filter((c) => c.op === 'remove')).toHaveLength(0);
  });

  it('NEVER uses the port allowance to omit it', async () => {
    // The durable port permits omitting expectedRevision for machine writes.
    // If that leaked into this API it would quietly restore last-write-wins.
    h = await harness();
    await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });
    await call(h, 'DELETE', '/operator/programmes/prog_A/vocabulary/lagos',
      { expectedRevision: 8 });
    for (const c of h.fake.calls.filter((x) => x.op !== 'snapshotRead')) {
      expect(c.expectedRevision).toBeTypeOf('number');
    }
  });
});

describe('the programme comes from the authenticated route, never the body', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('ignores a programmeId supplied in the payload', async () => {
    h = await harness();
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7, programmeId: 'prog_VICTIM' });
    expect(r.status).toBe(200);
    expect(r.body.programmeId).toBe('prog_A');
    // The write went to the authorised programme, not the one asked for.
    expect(h.fake.calls.find((c) => c.op === 'upsert')?.programmeId).toBe('prog_A');
    expect(h.fake.entries.get('lagos')?.programmeId).toBe('prog_A');
  });

  it('a caller without authority over the programme gets 404, not 403', async () => {
    // Whether a programme exists is itself information.
    h = await harness({ mayAdminister: false });
    const r = await call(h, 'GET', '/operator/programmes/prog_OTHER/vocabulary');
    expect(r.status).toBe(404);
  });

  it('an unauthenticated caller gets 401 and reaches no port method', async () => {
    h = await harness({ signedIn: false });
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });
    expect(r.status).toBe(401);
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('a conflict is an answer, not a retry', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('returns 409 with both revisions and changes nothing', async () => {
    h = await harness();
    h.fake.forceConflictUnless(999);
    const before = h.fake.revision;

    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: 'revision-conflict', expectedRevision: 7, currentRevision: before,
    });
    expect(h.fake.revision).toBe(before);
    expect(h.fake.entries.size).toBe(0);
  });

  it('does NOT retry after a conflict', async () => {
    // One attempt. A route that retried would resolve the conflict by
    // overwriting, which is the behaviour the precondition exists to prevent.
    h = await harness();
    h.fake.forceConflictUnless(999);
    await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });
    expect(h.fake.calls.filter((c) => c.op === 'upsert')).toHaveLength(1);
  });

  it('DELETE conflicts the same way', async () => {
    h = await harness();
    h.fake.forceConflictUnless(999);
    const r = await call(h, 'DELETE', '/operator/programmes/prog_A/vocabulary/lagos',
      { expectedRevision: 7 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('revision-conflict');
  });
});

describe('a successful mutation returns the new revision', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('so the console can continue from authoritative state', async () => {
    h = await harness();
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });
    expect(r.status).toBe(200);
    expect(r.body.revision).toBe(8);
    expect(r.body.entry).toMatchObject({ term: 'Lagos', canonicalRendering: 'Èkó' });
  });

  it('DELETE returns the new revision too', async () => {
    h = await harness();
    await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { ...ENTRY, expectedRevision: 7 });
    const r = await call(h, 'DELETE', '/operator/programmes/prog_A/vocabulary/lagos',
      { expectedRevision: 8 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ revision: 9, removed: true });
  });

  it('refuses an entry with no term rather than storing a blank one', async () => {
    h = await harness();
    const r = await call(h, 'PUT', '/operator/programmes/prog_A/vocabulary/lagos',
      { term: '   ', expectedRevision: 7 });
    expect(r.status).toBe(400);
  });
});
