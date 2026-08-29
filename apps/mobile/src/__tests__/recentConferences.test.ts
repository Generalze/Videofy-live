/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  RECENT_CONFERENCES_KEY,
  RECENT_CONFERENCES_MAX,
  addRecent,
  applyStatuses,
  createRecentConferences,
  parseRecent,
  similarSetup,
  type RecentConference,
} from '../conference/recentConferences';

const entry = (callId: string, atMs: number, title: string | null = null, status: RecentConference['status'] = 'unknown'): RecentConference => ({
  callId,
  title,
  atMs,
  role: 'joined',
  status,
});

function fakeStorage(initial: string | null = null) {
  const cells = new Map<string, string>();
  if (initial !== null) cells.set(RECENT_CONFERENCES_KEY, initial);
  let writes = 0;
  return {
    cells,
    get writes() {
      return writes;
    },
    async getItemAsync(key: string) {
      return cells.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      writes += 1;
      cells.set(key, value);
    },
  };
}

describe('recent conferences', () => {
  it('keeps newest first and one entry per code, the newest visit winning', () => {
    const list = addRecent([entry('calm-river-12', 100, 'Old title')], entry('calm-river-12', 200, 'New title'));
    expect(list).toEqual([entry('calm-river-12', 200, 'New title')]);
    const more = addRecent(list, entry('amber-summit-40', 150));
    expect(more.map((row) => row.callId)).toEqual(['calm-river-12', 'amber-summit-40']);
  });

  it('never grows past the maximum', () => {
    let list: RecentConference[] = [];
    for (let i = 0; i < RECENT_CONFERENCES_MAX + 3; i += 1) list = addRecent(list, entry(`code-${i}`, i));
    expect(list).toHaveLength(RECENT_CONFERENCES_MAX);
    expect(list[0]?.callId).toBe(`code-${RECENT_CONFERENCES_MAX + 2}`);
  });

  it('reads garbage as an empty list and drops malformed rows', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    const mixed = JSON.stringify([entry('good-code-1', 5), { callId: '', atMs: 1 }, { callId: 'x', atMs: 'soon', role: 'joined', title: null }]);
    expect(parseRecent(mixed)).toEqual([entry('good-code-1', 5)]);
  });

  it('reads rows written before status and setup existed as unknown, with no setup', () => {
    const old = JSON.stringify([{ callId: 'calm-river-12', title: 'Town hall', atMs: 5, role: 'started' }]);
    expect(parseRecent(old)).toEqual([{ callId: 'calm-river-12', title: 'Town hall', atMs: 5, role: 'started', status: 'unknown' }]);
  });

  it('keeps a remembered setup only when its privacy is a real tier, and a status only when it is a real word', () => {
    const stored = JSON.stringify([
      { callId: 'a-b-1', title: 'A', atMs: 1, role: 'started', status: 'ended', setup: { title: 'A', privacy: 'restricted' } },
      { callId: 'c-d-2', title: null, atMs: 2, role: 'started', status: 'finished', setup: { privacy: 'open' } },
      { callId: 'e-f-3', title: null, atMs: 3, role: 'started', status: 'active', setup: { privacy: 'public', title: '' } },
    ]);
    const rows = parseRecent(stored);
    expect(rows[0]).toEqual({ callId: 'a-b-1', title: 'A', atMs: 1, role: 'started', status: 'ended', setup: { title: 'A', privacy: 'restricted' } });
    expect(rows[1]).toEqual({ callId: 'c-d-2', title: null, atMs: 2, role: 'started', status: 'unknown' });
    expect(rows[2]).toEqual({ callId: 'e-f-3', title: null, atMs: 3, role: 'started', status: 'active', setup: { privacy: 'public' } });
  });

  it('round-trips through the injected storage under the one key', async () => {
    const storage = fakeStorage();
    const recent = createRecentConferences(storage);
    await recent.remember({ callId: 'bright-harbour-77', title: 'Town hall', atMs: 10, role: 'started', status: 'unknown', setup: { title: 'Town hall', privacy: 'public' } });
    await recent.remember({ callId: 'quiet-meadow-31', title: null, atMs: 20, role: 'joined', status: 'unknown' });
    expect(storage.cells.has(RECENT_CONFERENCES_KEY)).toBe(true);
    const rows = await recent.read();
    expect(rows.map((row) => row.callId)).toEqual(['quiet-meadow-31', 'bright-harbour-77']);
    expect(rows[1]?.setup).toEqual({ title: 'Town hall', privacy: 'public' });
  });

  it('survives storage that throws', async () => {
    const recent = createRecentConferences({
      async getItemAsync() {
        throw new Error('keystore unreadable');
      },
      async setItemAsync() {
        throw new Error('keystore unwritable');
      },
    });
    expect(await recent.read()).toEqual([]);
    expect(await recent.remember(entry('x-y-1', 1))).toEqual([entry('x-y-1', 1)]);
  });
});

describe('applyStatuses: an ended conference is terminal', () => {
  const list = [entry('a-b-1', 3, null, 'unknown'), entry('c-d-2', 2, null, 'ended'), entry('e-f-3', 1, null, 'active')];

  it("takes the gateway's word for rows it answered and leaves the rest", () => {
    const next = applyStatuses(list, { 'a-b-1': 'ended', 'e-f-3': 'ended' });
    expect(next.map((row) => row.status)).toEqual(['ended', 'ended', 'ended']);
    expect(applyStatuses(list, {}).map((row) => row.status)).toEqual(['unknown', 'ended', 'active']);
  });

  it('never brings an ended row back, whatever the gateway says later', () => {
    const next = applyStatuses(list, { 'c-d-2': 'active' });
    expect(next[1]?.status).toBe('ended');
    expect(applyStatuses(list, { 'c-d-2': 'unknown' })[1]?.status).toBe('ended');
  });

  it('returns the same row objects when nothing changed', () => {
    const next = applyStatuses(list, { 'c-d-2': 'ended', 'e-f-3': 'active' });
    expect(next[0]).toBe(list[0]);
    expect(next[1]).toBe(list[1]);
    expect(next[2]).toBe(list[2]);
  });

  it('persists through the store only when something moved', async () => {
    const storage = fakeStorage(JSON.stringify(list));
    const recent = createRecentConferences(storage);
    const unchanged = await recent.refreshStatuses({ 'e-f-3': 'active' });
    expect(unchanged.map((row) => row.status)).toEqual(['unknown', 'ended', 'active']);
    expect(storage.writes).toBe(0);
    const changed = await recent.refreshStatuses({ 'a-b-1': 'ended' });
    expect(changed[0]?.status).toBe('ended');
    expect(storage.writes).toBe(1);
    expect((await recent.read())[0]?.status).toBe('ended');
  });
});

describe('similarSetup: a NEW conference copying the old settings', () => {
  it('copies the remembered title and privacy when this phone started it', () => {
    const row: RecentConference = { ...entry('a-b-1', 1, 'Town hall', 'ended'), role: 'started', setup: { title: 'Town hall', privacy: 'restricted' } };
    expect(similarSetup(row)).toEqual({ title: 'Town hall', privacy: 'restricted', targetLanguages: [] });
  });

  it('falls back to the title it saw and the private tier for a room it only joined', () => {
    expect(similarSetup(entry('a-b-1', 1, 'Faith Live', 'ended'))).toEqual({ title: 'Faith Live', privacy: 'private', targetLanguages: [] });
    expect(similarSetup(entry('a-b-1', 1, null, 'ended'))).toEqual({ privacy: 'private', targetLanguages: [] });
  });

  it('never carries the old code or any target language', () => {
    const setup = similarSetup({ ...entry('old-code-9', 1, 'X', 'ended'), setup: { privacy: 'public' } });
    expect(JSON.stringify(setup)).not.toContain('old-code-9');
    expect(setup.targetLanguages).toEqual([]);
  });
});
