/** @author masterzee001 */
/**
 * ENSURE-LIVE-CALL against the REAL @videofy/server-sdk with a fake /v1
 * behind its fetch seam: recreate on CALL_NOT_FOUND / CALL_ENDED, keep the
 * mapping on transient failures, and single-flight concurrent establishment
 * so one room can never mint two calls at once.
 */
import { describe, expect, it } from 'vitest';
import { createVideofyConnect } from '@videofy/server-sdk';
import { hashHostKey, mintHostKey, mintRoomId } from '../ids.js';
import { LiveCallDirectory } from '../live-calls.js';
import type { RoomRecord } from '../room-store.js';
import { callEndedError, callNotFoundError, FakeVideofy } from './fake-videofy.js';

const API_KEY = 'vfk_test_0123456789abcdef0123456789abcdef';

function harness() {
  const fake = new FakeVideofy();
  const connect = createVideofyConnect({
    apiKey: API_KEY,
    baseUrl: 'http://videofy.test',
    fetch: fake.fetch,
  });
  const directory = new LiveCallDirectory(connect);
  return { fake, directory };
}

function room(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    roomId: mintRoomId(),
    name: 'Recovery drills',
    mode: 'translated',
    createdAt: '2026-08-19T09:00:00.000Z',
    hostKeyHash: hashHostKey(mintHostKey()),
    transcriptDownloadAllowed: true,
    ended: false,
    ...overrides,
  };
}

describe('adversarial-review pins (directory)', () => {
  it('reconciles a drifted call mode on ensure', async () => {
    const { fake, directory } = harness();
    const record = room({ mode: 'translated' });
    const live = await directory.ensure(record);
    expect(fake.calls.get(live.publicCallId)?.mode).toBe('translated');
    // The host switched the room while nothing was establishing; the next
    // ensure heals the drift instead of seating members in the wrong mode.
    const switched = { ...record, mode: 'normal' as const };
    await directory.ensure(switched);
    expect(fake.calls.get(live.publicCallId)?.mode).toBe('normal');
  });

  it('frees a room\u2019s member indexes when the room ends', () => {
    const { directory } = harness();
    const record = room();
    expect(directory.memberIndex(record.roomId, 'guest_a')).toBe(0);
    expect(directory.memberIndex(record.roomId, 'guest_b')).toBe(1);
    directory.clear(record.roomId);
    // A fresh map: the ended room's indexes no longer occupy this process.
    expect(directory.memberIndex(record.roomId, 'guest_c')).toBe(0);
  });

  it('adopts a persisted live call across a directory restart', async () => {
    const fake = new FakeVideofy();
    const connect = createVideofyConnect({
      apiKey: API_KEY,
      baseUrl: 'http://videofy.test',
      fetch: fake.fetch,
    });
    const memory = new Map<string, string>();
    const persistence = {
      recall: (roomId: string) => memory.get(roomId),
      remember: async (roomId: string, publicCallId: string) => {
        memory.set(roomId, publicCallId);
      },
      forget: async (roomId: string) => {
        memory.delete(roomId);
      },
    };
    const record = room();
    const before = new LiveCallDirectory(connect, persistence);
    const live = await before.ensure(record);
    // "Restart": a fresh directory with empty memory but the same registry.
    const after = new LiveCallDirectory(connect, persistence);
    const adopted = await after.ensure(record);
    expect(adopted.publicCallId).toBe(live.publicCallId);
    expect(fake.createCount()).toBe(1);
  });

  it('recreates when the persisted call is gone, and re-persists the new id', async () => {
    const fake = new FakeVideofy();
    const connect = createVideofyConnect({
      apiKey: API_KEY,
      baseUrl: 'http://videofy.test',
      fetch: fake.fetch,
    });
    const memory = new Map<string, string>();
    const persistence = {
      recall: (roomId: string) => memory.get(roomId),
      remember: async (roomId: string, publicCallId: string) => {
        memory.set(roomId, publicCallId);
      },
      forget: async (roomId: string) => {
        memory.delete(roomId);
      },
    };
    const record = room();
    const before = new LiveCallDirectory(connect, persistence);
    const live = await before.ensure(record);
    fake.calls.get(live.publicCallId)!.ended = true;
    const after = new LiveCallDirectory(connect, persistence);
    const replacement = await after.ensure(record);
    expect(replacement.publicCallId).not.toBe(live.publicCallId);
    expect(memory.get(record.roomId)).toBe(replacement.publicCallId);
    expect(fake.createCount()).toBe(2);
  });
});

describe('ensure-live-call', () => {
  it('creates a conference call in the room mode when no mapping exists', async () => {
    const { fake, directory } = harness();
    const theRoom = room({ mode: 'normal' });

    const live = await directory.ensure(theRoom);

    expect(live.publicCallId).toMatch(/^vc_[A-Za-z0-9]{16}$/);
    const creates = fake.requestsOf('POST', /^\/v1\/calls$/);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({ type: 'conference', mode: 'normal' });
    expect(directory.peek(theRoom.roomId)).toEqual(live);
  });

  it('reuses a healthy mapping instead of creating again', async () => {
    const { fake, directory } = harness();
    const theRoom = room();

    const first = await directory.ensure(theRoom);
    const second = await directory.ensure(theRoom);

    expect(second).toEqual(first);
    expect(fake.createCount()).toBe(1);
    // The second ensure verified liveness through GET state.
    expect(fake.requestsOf('GET', /\/state$/)).toHaveLength(1);
  });

  it('recreates when the mapped call answers CALL_NOT_FOUND', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const first = await directory.ensure(theRoom);
    fake.forcedStateErrors.set(first.publicCallId, callNotFoundError());

    const second = await directory.ensure(theRoom);

    expect(second.publicCallId).not.toBe(first.publicCallId);
    expect(fake.createCount()).toBe(2);
    expect(directory.peek(theRoom.roomId)).toEqual(second);
  });

  it('recreates when the mapped call answers CALL_ENDED', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const first = await directory.ensure(theRoom);
    fake.forcedStateErrors.set(first.publicCallId, callEndedError());

    const second = await directory.ensure(theRoom);

    expect(second.publicCallId).not.toBe(first.publicCallId);
    expect(fake.createCount()).toBe(2);
  });

  it('does not recreate over a transient failure — the mapping survives', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const first = await directory.ensure(theRoom);

    fake.networkFail = true;
    await expect(directory.ensure(theRoom)).rejects.toThrow();
    expect(directory.peek(theRoom.roomId)).toEqual(first);

    fake.networkFail = false;
    const recovered = await directory.ensure(theRoom);
    expect(recovered).toEqual(first);
    expect(fake.createCount()).toBe(1);
  });

  it('single-flights concurrent establishment: one create for two joiners', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    let releaseCreate: () => void = () => {};
    fake.createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    const flightA = directory.ensure(theRoom);
    const flightB = directory.ensure(theRoom);
    // Let both callers attach before the create is allowed to answer.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseCreate();
    const [liveA, liveB] = await Promise.all([flightA, flightB]);

    expect(liveA.publicCallId).toBe(liveB.publicCallId);
    expect(fake.createCount()).toBe(1);
  });

  it('a rejected flight is shared too, then retried cleanly', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    fake.networkFail = true;

    const flightA = directory.ensure(theRoom).catch(() => 'failed');
    const flightB = directory.ensure(theRoom).catch(() => 'failed');
    expect(await flightA).toBe('failed');
    expect(await flightB).toBe('failed');

    fake.networkFail = false;
    const live = await directory.ensure(theRoom);
    expect(live.publicCallId).toMatch(/^vc_/);
  });

  it('stateIfLive degrades to null on outage and keeps the mapping', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const live = await directory.ensure(theRoom);

    fake.networkFail = true;
    expect(await directory.stateIfLive(theRoom.roomId)).toBeNull();
    expect(directory.peek(theRoom.roomId)).toEqual(live);

    fake.networkFail = false;
    expect(await directory.stateIfLive(theRoom.roomId)).not.toBeNull();
  });

  it('stateIfLive clears the mapping when the call is gone', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const live = await directory.ensure(theRoom);
    fake.forcedStateErrors.set(live.publicCallId, callNotFoundError());

    expect(await directory.stateIfLive(theRoom.roomId)).toBeNull();
    expect(directory.peek(theRoom.roomId)).toBeUndefined();
  });

  it('invalidate only forgets the exact mapping the caller saw', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const first = await directory.ensure(theRoom);
    fake.forcedStateErrors.set(first.publicCallId, callNotFoundError());
    const second = await directory.ensure(theRoom);

    // A stale failure report about the FIRST call must not clobber the fresh mapping.
    directory.invalidate(theRoom.roomId, first.publicCallId);
    expect(directory.peek(theRoom.roomId)).toEqual(second);

    directory.invalidate(theRoom.roomId, second.publicCallId);
    expect(directory.peek(theRoom.roomId)).toBeUndefined();
  });

  it('member indexes are stable per room and survive call re-creation', async () => {
    const { fake, directory } = harness();
    const theRoom = room();
    const first = await directory.ensure(theRoom);

    expect(directory.memberIndex(theRoom.roomId, 'guest_ana')).toBe(0);
    expect(directory.memberIndex(theRoom.roomId, 'guest_ben')).toBe(1);
    expect(directory.memberIndex(theRoom.roomId, 'guest_ana')).toBe(0);

    fake.forcedStateErrors.set(first.publicCallId, callEndedError());
    await directory.ensure(theRoom);
    expect(directory.memberIndex(theRoom.roomId, 'guest_ana')).toBe(0);
    // A different room counts from zero on its own.
    expect(directory.memberIndex('room_otherRoom99', 'guest_ana')).toBe(0);
  });
});
