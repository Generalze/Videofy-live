/** @author masterzee001 */
/**
 * The durable half of the product model: room records must survive process
 * restarts, land atomically (temp-then-rename, no leftover temp files), and
 * treat a damaged registry as empty rather than half-trusted.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashHostKey, mintHostKey, mintRoomId } from '../ids.js';
import { createFileRoomStore, type RoomRecord } from '../room-store.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function tempRegistryPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ref-rooms-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'connect-reference-rooms.json');
}

function sampleRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    roomId: mintRoomId(),
    name: 'Weekly sync',
    mode: 'translated',
    createdAt: '2026-08-19T09:00:00.000Z',
    hostKeyHash: hashHostKey(mintHostKey()),
    transcriptDownloadAllowed: true,
    ended: false,
    ...overrides,
  };
}

describe('room store', () => {
  it('creates, reads, and lists rooms', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    const room = sampleRoom({ scheduledFor: '2026-08-20T15:00:00.000Z' });

    await store.create(room);

    expect(store.get(room.roomId)).toEqual(room);
    expect(store.list()).toEqual([room]);
    expect(store.get('room_missingRoom')).toBeUndefined();
  });

  it('persists across store instances (a restart)', async () => {
    const registry = await tempRegistryPath();
    const first = await createFileRoomStore(registry);
    const room = sampleRoom();
    await first.create(room);

    const second = await createFileRoomStore(registry);
    expect(second.get(room.roomId)).toEqual(room);
  });

  it('persists updates to mode and ended', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    const room = sampleRoom({ mode: 'normal' });
    await store.create(room);

    const changed = await store.update(room.roomId, { mode: 'translated' });
    expect(changed.mode).toBe('translated');
    await store.update(room.roomId, { ended: true });

    const reloaded = await createFileRoomStore(registry);
    const survivor = reloaded.get(room.roomId);
    expect(survivor?.mode).toBe('translated');
    expect(survivor?.ended).toBe(true);
    // Untouched fields ride along unchanged.
    expect(survivor?.hostKeyHash).toBe(room.hostKeyHash);
  });

  it('writes atomically: valid JSON on disk and no leftover temp files', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    await store.create(sampleRoom());
    await store.create(sampleRoom({ name: 'Second room' }));

    const entries = await readdir(path.dirname(registry));
    expect(entries).toEqual(['connect-reference-rooms.json']);
    const onDisk = JSON.parse(await readFile(registry, 'utf8')) as { version: number; rooms: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.rooms).toHaveLength(2);
  });

  it('serializes concurrent saves without losing rooms', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    const rooms = Array.from({ length: 10 }, (_, i) => sampleRoom({ name: `Room ${i}` }));

    await Promise.all(rooms.map((room) => store.create(room)));

    const reloaded = await createFileRoomStore(registry);
    expect(reloaded.list()).toHaveLength(10);
    for (const room of rooms) {
      expect(reloaded.get(room.roomId)).toEqual(room);
    }
  });

  it('treats a damaged registry as empty and recovers on the next save', async () => {
    const registry = await tempRegistryPath();
    await writeFile(registry, '{ this is not JSON', 'utf8');

    const store = await createFileRoomStore(registry);
    expect(store.list()).toEqual([]);

    const room = sampleRoom();
    await store.create(room);
    const reloaded = await createFileRoomStore(registry);
    expect(reloaded.get(room.roomId)).toEqual(room);
  });

  it('lists newest first', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    const older = sampleRoom({ createdAt: '2026-08-18T09:00:00.000Z', name: 'Older' });
    const newer = sampleRoom({ createdAt: '2026-08-19T09:00:00.000Z', name: 'Newer' });
    await store.create(older);
    await store.create(newer);

    expect(store.list().map((room) => room.name)).toEqual(['Newer', 'Older']);
  });

  it('refuses duplicate room ids and unknown updates', async () => {
    const registry = await tempRegistryPath();
    const store = await createFileRoomStore(registry);
    const room = sampleRoom();
    await store.create(room);

    await expect(store.create(room)).rejects.toThrow(/already exists/);
    await expect(store.update('room_missingRoom', { ended: true })).rejects.toThrow(/does not exist/);
  });
});
