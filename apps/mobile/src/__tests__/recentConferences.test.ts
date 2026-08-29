/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  RECENT_CONFERENCES_KEY,
  RECENT_CONFERENCES_MAX,
  addRecent,
  createRecentConferences,
  parseRecent,
  type RecentConference,
} from '../conference/recentConferences';

const entry = (callId: string, atMs: number, title: string | null = null): RecentConference => ({
  callId,
  title,
  atMs,
  role: 'joined',
});

function fakeStorage(initial: string | null = null) {
  const cells = new Map<string, string>();
  if (initial !== null) cells.set(RECENT_CONFERENCES_KEY, initial);
  return {
    cells,
    async getItemAsync(key: string) {
      return cells.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
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

  it('round-trips through the injected storage under the one key', async () => {
    const storage = fakeStorage();
    const recent = createRecentConferences(storage);
    await recent.remember({ callId: 'bright-harbour-77', title: 'Town hall', atMs: 10, role: 'started' });
    await recent.remember({ callId: 'quiet-meadow-31', title: null, atMs: 20, role: 'joined' });
    expect(storage.cells.has(RECENT_CONFERENCES_KEY)).toBe(true);
    expect((await recent.read()).map((row) => row.callId)).toEqual(['quiet-meadow-31', 'bright-harbour-77']);
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
