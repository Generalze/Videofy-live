/** @author masterzee001 */
/**
 * The product API proven end to end: Connect Reference route -> REAL
 * @videofy/server-sdk -> (fake) /v1 wire -> SDK response validation -> route
 * answer. The fake speaks the strict Connect v1 contract shapes, so every
 * test here exercises the SDK's own validation path.
 *
 * The two laws under test everywhere: rooms are durable while calls are
 * ephemeral-and-recoverable, and no vfk_ key or vc_ id ever leaves this
 * server — not in a response, not in a log line.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVideofyConnect } from '@videofy/server-sdk';
import { buildReferenceApp } from '../app.js';
import { createFileRoomStore, type RoomStore } from '../room-store.js';
import { callNotFoundError, fakeParticipant, FakeVideofy } from './fake-videofy.js';

const API_KEY = 'vfk_test_0123456789abcdef0123456789abcdef';
const START_AT = Date.parse('2026-08-19T12:00:00.000Z');

interface Harness {
  fake: FakeVideofy;
  url: string;
  registry: string;
  logLines: string[];
  clock: { now: number };
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

/**
 * Remove a directory that a just-closed process may still be letting go of.
 *
 * WINDOWS RELEASES A HANDLE SLIGHTLY AFTER THE OWNER LETS IT GO. Even with
 * every resource deterministically closed first, a removal issued in the same
 * tick can still see ENOTEMPTY or EBUSY for a few milliseconds. That is a
 * property of the filesystem, not a missing await, so it is retried with
 * backoff -- AFTER the deterministic close, never instead of it.
 *
 * The retry is bounded and the final attempt THROWS. Swallowing the error
 * would leave temporary directories accumulating in the runner's temp space
 * and would hide a genuine leak behind a green suite.
 */
async function removeWhenReleased(dir: string): Promise<void> {
  const delaysMs = [0, 10, 25, 50, 100, 250];
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt]! > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only the "still held" family is worth waiting on. Anything else is a
      // real failure and is raised immediately.
      const retryable = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
      if (!retryable || attempt === delaysMs.length - 1) throw error;
    }
  }
}

afterEach(async () => {
  /*
   * LIFO, and the ORDER IS THE FIX. Cleanups are pushed as the harness
   * acquires them -- directory, then store, then server -- so popping runs:
   *
   *   close the server        stop accepting work
   *   flush the store         await persistence still touching the file
   *   remove the directory    nothing holds it any more
   *
   * The registry is written temp-then-rename by a queued writer that outlives
   * the request causing it, so a teardown that only closed the server could
   * delete the directory while a write was still landing in it.
   */
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startApp(
  options: {
    registry?: string;
    /** Reuse a fake across app instances — the restart-adoption pins. */
    fake?: FakeVideofy;
    /** Wrap the store to stage persistence failures. */
    decorateStore?: (store: RoomStore) => RoomStore;
  } = {},
): Promise<Harness> {
  let registry = options.registry;
  if (registry === undefined) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ref-app-'));
    // Pushed FIRST so it is popped LAST, after the store and the server.
    cleanups.push(() => removeWhenReleased(dir));
    registry = path.join(dir, 'connect-reference-rooms.json');
  }
  const fake = options.fake ?? new FakeVideofy();
  const connect = createVideofyConnect({
    apiKey: API_KEY,
    baseUrl: 'http://videofy.test',
    fetch: fake.fetch,
  });
  const baseStore = await createFileRoomStore(registry);
  // Between the directory and the server: pending writes are awaited after the
  // server stops accepting work and before the directory goes.
  cleanups.push(() => baseStore.flush());
  const roomStore = options.decorateStore ? options.decorateStore(baseStore) : baseStore;
  const logLines: string[] = [];
  const clock = { now: START_AT };
  const app = buildReferenceApp({
    connect,
    roomStore,
    log: (line) => logLines.push(line),
    now: () => clock.now,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Idempotent: the restart test closes explicitly, then cleanup closes again.
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  cleanups.push(close);
  return { fake, url, registry, logLines, clock, close };
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

async function createRoom(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<{ roomId: string; hostKey: string }> {
  const answer = await request(harness.url, 'POST', '/api/rooms', {
    name: 'Kings review',
    mode: 'translated',
    ...overrides,
  });
  expect(answer.status).toBe(201);
  return { roomId: answer.body.room.roomId, hostKey: answer.body.hostKey };
}

function join(harness: Harness, roomId: string, overrides: Record<string, unknown> = {}) {
  return request(harness.url, 'POST', `/api/rooms/${roomId}/join-tokens`, {
    displayName: 'Ana',
    speakLanguage: 'es',
    hearLanguage: 'en',
    subject: 'guest_ana1',
    ...overrides,
  });
}

describe('adversarial-review pins', () => {
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('condition never became true');
  }

  it('a mint parked across the host ending the room cannot resurrect it', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    let release!: () => void;
    harness.fake.createGate = new Promise((resolve) => {
      release = resolve;
    });
    const minting = join(harness, roomId);
    await until(() => harness.fake.createCount() === 1);
    // The create is parked in flight; the host ends the room NOW.
    const ended = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });
    expect(ended.status).toBe(200);
    harness.fake.createGate = null;
    release();
    const answer = await minting;
    expect(answer.status).toBe(410);
    expect(answer.body.error.code).toBe('REF_ROOM_ENDED');
    // The call the parked establishment created was put down, not leaked as
    // an invisible, joinable phantom.
    expect(harness.fake.createCount()).toBe(1);
    expect(harness.fake.calls.get(harness.fake.latestCallId())?.ended).toBe(true);
  });

  it('a mint whose call died because the room ended refuses instead of re-creating', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    let release!: () => void;
    harness.fake.mintGate = new Promise((resolve) => {
      release = resolve;
    });
    const minting = join(harness, roomId, { subject: 'guest_bea1', displayName: 'Bea' });
    await until(() => harness.fake.requestsOf('POST', /join-tokens$/).length === 2);
    harness.fake.mintGate = null;
    const ended = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });
    expect(ended.status).toBe(200);
    release();
    const answer = await minting;
    expect(answer.status).toBe(410);
    expect(answer.body.error.code).toBe('REF_ROOM_ENDED');
    // The recovery path re-read the room and created NOTHING.
    expect(harness.fake.createCount()).toBe(1);
  });

  it('a mode switch during first-join establishment reaches the call being created', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness); // translated
    let release!: () => void;
    harness.fake.createGate = new Promise((resolve) => {
      release = resolve;
    });
    const minting = join(harness, roomId);
    await until(() => harness.fake.createCount() === 1);
    const switching = request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
      mode: 'normal',
      hostKey,
    });
    // Give the mode route time to reach the settled() wait, then let the
    // parked create finish.
    await new Promise((resolve) => setTimeout(resolve, 25));
    harness.fake.createGate = null;
    release();
    const [mintAnswer, modeAnswer] = await Promise.all([minting, switching]);
    expect(mintAnswer.status).toBe(201);
    expect(modeAnswer.status).toBe(200);
    // The switch reached the very call the join was creating: no lifetime
    // drift between the room record and the live call.
    expect(harness.fake.calls.get(harness.fake.latestCallId())?.mode).toBe('normal');
    const again = await join(harness, roomId, { subject: 'guest_bea1', displayName: 'Bea' });
    expect(again.status).toBe(201);
    expect(harness.fake.createCount()).toBe(1);
  });

  it('refuses a NEW member when the room is full, but seat replacement stays allowed', async () => {
    const harness = await startApp();
    harness.fake.limits = { personalParticipants: 2, conferenceParticipants: 3 };
    const { roomId } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    call!.participants = [
      fakeParticipant({ participantId: 'p1', subject: 'guest_a', displayName: 'Ana' }),
      fakeParticipant({ participantId: 'p2', subject: 'guest_b', displayName: 'Bea' }),
      fakeParticipant({ participantId: 'p3', subject: 'guest_c', displayName: 'Cia' }),
    ];
    const refused = await join(harness, roomId, { subject: 'guest_dan1', displayName: 'Dan' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('REF_ROOM_FULL');
    // A member already seated re-mints freely: recovery depends on it.
    const remint = await join(harness, roomId, { subject: 'guest_b', displayName: 'Bea' });
    expect(remint.status).toBe(201);
  });

  it('refuses a display name a DIFFERENT connected member already uses', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    call!.participants = [
      fakeParticipant({ participantId: 'p1', subject: 'guest_a', displayName: 'Ana' }),
    ];
    const clash = await join(harness, roomId, { subject: 'guest_zz1', displayName: '  ana ' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('REF_NAME_TAKEN');
    // The same member keeping their own name is not a clash.
    const same = await join(harness, roomId, { subject: 'guest_a', displayName: 'Ana' });
    expect(same.status).toBe(201);
  });

  it('rate limits unauthenticated room creation per address, per minute', async () => {
    const harness = await startApp();
    for (let i = 0; i < 10; i += 1) {
      const answer = await request(harness.url, 'POST', '/api/rooms', {
        name: `Court ${i}`,
        mode: 'normal',
      });
      expect(answer.status).toBe(201);
    }
    const eleventh = await request(harness.url, 'POST', '/api/rooms', {
      name: 'One too many',
      mode: 'normal',
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('REF_RATE_LIMITED');
    // The next window opens a fresh allowance.
    harness.clock.now += 60_000;
    const nextWindow = await request(harness.url, 'POST', '/api/rooms', {
      name: 'Patience rewarded',
      mode: 'normal',
    });
    expect(nextWindow.status).toBe(201);
  });

  it('re-adopts the persisted live call after a Connect Reference restart', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    expect(harness.fake.createCount()).toBe(1);
    await harness.close();
    // Same registry, same (still-running) platform, fresh KC process.
    const revived = await startApp({ registry: harness.registry, fake: harness.fake });
    const again = await join(revived, roomId, { subject: 'guest_bea1', displayName: 'Bea' });
    expect(again.status).toBe(201);
    // One call, adopted — the restart did not split the room in two.
    expect(harness.fake.createCount()).toBe(1);
  });

  it('keeps the persisted call id and every Connect id out of responses', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    const list = await request(harness.url, 'GET', '/api/rooms');
    const detail = await request(harness.url, 'GET', `/api/rooms/${roomId}`);
    for (const text of [list.text, detail.text]) {
      expect(text).not.toContain('liveCallId');
      expect(text).not.toContain('vc_');
    }
  });

  it('answers 500, not 200, when persisting the end fails after the upstream end', async () => {
    const harness = await startApp({
      decorateStore: (store) => ({
        ...store,
        update: async (roomId, patch) => {
          if (patch.ended === true) throw new Error('disk full (staged)');
          return store.update(roomId, patch);
        },
      }),
    });
    const { roomId, hostKey } = await createRoom(harness);
    expect((await join(harness, roomId)).status).toBe(201);
    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });
    // The upstream call ended but the durable record did not: claiming 200
    // would leave a room the registry still calls live. The route is
    // idempotent, so the host simply retries.
    expect(answer.status).toBe(500);
    expect(answer.body.error.code).toBe('REF_INTERNAL');
    expect(harness.fake.calls.get(harness.fake.latestCallId())?.ended).toBe(true);
  });
});

describe('room creation', () => {
  it('creates a room and shows the host_ host key exactly once', async () => {
    const harness = await startApp();
    const answer = await request(harness.url, 'POST', '/api/rooms', {
      name: 'All hands',
      mode: 'normal',
      scheduledFor: '2026-08-20T15:00:00.000Z',
    });

    expect(answer.status).toBe(201);
    expect(answer.body.hostKey).toMatch(/^host_[A-Za-z0-9]{24}$/);
    expect(answer.body.room).toEqual({
      roomId: expect.stringMatching(/^room_[A-Za-z0-9]{12}$/),
      name: 'All hands',
      mode: 'normal',
      scheduledFor: '2026-08-20T15:00:00.000Z',
      createdAt: '2026-08-19T12:00:00.000Z',
      transcriptDownloadAllowed: true,
      ended: false,
    });
    // Only the hash is stored, and not even the hash goes out.
    expect(answer.text).not.toContain('hostKeyHash');
    // No Connect call exists yet — rooms are cheap, calls are created on join.
    expect(harness.fake.createCount()).toBe(0);
  });

  it('rejects bad creation bodies with the KC envelope', async () => {
    const harness = await startApp();
    const cases = [
      { name: '', mode: 'translated' },
      { name: 'x'.repeat(81), mode: 'translated' },
      { name: 'ok', mode: 'sideways' },
      { name: 'ok', mode: 'normal', scheduledFor: 'tomorrow-ish' },
      { name: 'ok', mode: 'normal', surprise: true },
    ];
    for (const body of cases) {
      const answer = await request(harness.url, 'POST', '/api/rooms', body);
      expect(answer.status).toBe(400);
      expect(answer.body.error.code).toBe('REF_INVALID_REQUEST');
    }
  });

  it('rejects malformed JSON with the KC envelope', async () => {
    const harness = await startApp();
    const response = await fetch(`${harness.url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REF_INVALID_REQUEST');
  });

  it('persists rooms across a server restart', async () => {
    const first = await startApp();
    const { roomId } = await createRoom(first, { name: 'Survivor' });
    await first.close();

    const second = await startApp({ registry: first.registry });
    const listed = await request(second.url, 'GET', '/api/rooms');
    expect(listed.status).toBe(200);
    expect(listed.body.map((room: { roomId: string }) => room.roomId)).toContain(roomId);
  });
});

describe('room list and detail', () => {
  it('404s an unknown room with REF_ROOM_NOT_FOUND', async () => {
    const harness = await startApp();
    const answer = await request(harness.url, 'GET', '/api/rooms/room_missingRoom');
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe('REF_ROOM_NOT_FOUND');
  });

  it('shows live:false before any join, live+count after', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);

    const before = await request(harness.url, 'GET', '/api/rooms');
    expect(before.body[0]).toMatchObject({ roomId, live: false, participantCount: 0 });

    await join(harness, roomId);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    call?.participants.push(
      fakeParticipant({ participantId: 'p1', subject: 'guest_ana1', displayName: 'Ana' }),
      fakeParticipant({
        participantId: 'p2',
        subject: 'guest_ben2',
        displayName: 'Ben',
        connected: false,
      }),
    );

    const after = await request(harness.url, 'GET', '/api/rooms');
    // Only connected members count.
    expect(after.body[0]).toMatchObject({ roomId, live: true, participantCount: 1 });
  });

  it('detail maps members to displayName + stable index, no Videofy internals', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    call?.participants.push(
      fakeParticipant({ participantId: 'p1', subject: 'guest_ana1', displayName: 'Ana' }),
      fakeParticipant({
        participantId: 'p2',
        subject: 'guest_ben2',
        displayName: 'Ben',
        speakLanguage: 'fr',
        hearLanguage: 'es',
      }),
    );

    const detail = await request(harness.url, 'GET', `/api/rooms/${roomId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.live).toBe(true);
    expect(detail.body.participantCount).toBe(2);
    expect(detail.body.participants).toEqual([
      { index: 0, displayName: 'Ana', speakLanguage: 'es', hearLanguage: 'en', connected: true },
      { index: 1, displayName: 'Ben', speakLanguage: 'fr', hearLanguage: 'es', connected: true },
    ]);
    expect(detail.text).not.toContain('participantId');
    expect(detail.text).not.toContain('subject');
    expect(detail.text).not.toContain('vc_');
  });

  it('degrades to live:false when Connect is down — the list never errors', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);

    harness.fake.networkFail = true;
    const during = await request(harness.url, 'GET', '/api/rooms');
    expect(during.status).toBe(200);
    expect(during.body[0]).toMatchObject({ roomId, live: false, participantCount: 0 });
    const detail = await request(harness.url, 'GET', `/api/rooms/${roomId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.live).toBe(false);
    expect(detail.body.participants).toEqual([]);

    // The outage was transient: the mapping survived and no new call is made.
    harness.fake.networkFail = false;
    const after = await request(harness.url, 'GET', '/api/rooms');
    expect(after.body[0]).toMatchObject({ roomId, live: true });
    expect(harness.fake.createCount()).toBe(1);
  });
});

describe('join tokens', () => {
  it('mints a token via ensure-live-call and returns token+expiry only', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);

    const answer = await join(harness, roomId);

    expect(answer.status).toBe(201);
    expect(Object.keys(answer.body).sort()).toEqual(['expiresAt', 'token']);
    expect(answer.body.token).toBe('fake-single-use-1');

    const creates = harness.fake.requestsOf('POST', /^\/v1\/calls$/);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({ type: 'conference', mode: 'translated' });
    const mints = harness.fake.requestsOf('POST', /\/join-tokens$/);
    expect(mints).toHaveLength(1);
    // The SDK resolved the participant defaults before the wire.
    expect(mints[0]?.body).toEqual({
      participant: {
        subject: 'guest_ana1',
        displayName: 'Ana',
        speakLanguage: 'es',
        hearLanguage: 'en',
        audioMode: 'translated',
        captionsEnabled: true,
        voiceGender: 'female',
      },
    });
  });

  it('rejects non-member subjects and bad languages before any Connect traffic', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    const cases = [
      { subject: 'admin' },
      { subject: 'vc_notAGuest123' },
      { displayName: '' },
      { speakLanguage: 'not a language!' },
      { hearLanguage: '' },
    ];
    for (const overrides of cases) {
      const answer = await join(harness, roomId, overrides);
      expect(answer.status).toBe(400);
      expect(answer.body.error.code).toBe('REF_INVALID_REQUEST');
    }
    expect(harness.fake.requests).toHaveLength(0);
  });

  it('404s an unknown room and 410s an ended room', async () => {
    const harness = await startApp();
    const missing = await join(harness, 'room_missingRoom');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('REF_ROOM_NOT_FOUND');

    const { roomId, hostKey } = await createRoom(harness);
    await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });
    const ended = await join(harness, roomId);
    expect(ended.status).toBe(410);
    expect(ended.body.error.code).toBe('REF_ROOM_ENDED');
  });

  it('recreates the call when the gateway forgot it (restart recovery)', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);
    const firstCallId = harness.fake.latestCallId();

    // The gateway restarted: the old call id answers CALL_NOT_FOUND.
    harness.fake.forcedStateErrors.set(firstCallId, callNotFoundError());
    const answer = await join(harness, roomId, { subject: 'guest_ben2', displayName: 'Ben' });

    expect(answer.status).toBe(201);
    expect(harness.fake.createCount()).toBe(2);
    const mints = harness.fake.requestsOf('POST', /\/join-tokens$/);
    expect(mints[1]?.pathname).toContain(harness.fake.latestCallId());
  });

  it('recreates when the call had ended, one extra create only', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    if (call) call.ended = true;

    const answer = await join(harness, roomId, { subject: 'guest_ben2', displayName: 'Ben' });
    expect(answer.status).toBe(201);
    expect(harness.fake.createCount()).toBe(2);
  });

  it('recovers when the call vanishes between liveness check and mint', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);
    const firstCallId = harness.fake.latestCallId();

    // State still answers (healthy), but the mint itself says the call is gone.
    harness.fake.forcedMintErrors.set(firstCallId, callNotFoundError());
    const answer = await join(harness, roomId, { subject: 'guest_ben2', displayName: 'Ben' });

    expect(answer.status).toBe(201);
    expect(harness.fake.createCount()).toBe(2);
  });

  it('single-flights two simultaneous joiners onto one create', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    let releaseCreate: () => void = () => {};
    harness.fake.createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    const joinA = join(harness, roomId, { subject: 'guest_ana1', displayName: 'Ana' });
    const joinB = join(harness, roomId, { subject: 'guest_ben2', displayName: 'Ben' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseCreate();
    const [answerA, answerB] = await Promise.all([joinA, joinB]);

    expect(answerA.status).toBe(201);
    expect(answerB.status).toBe(201);
    expect(harness.fake.createCount()).toBe(1);
    // Both tokens were minted against the SAME call.
    const mints = harness.fake.requestsOf('POST', /\/join-tokens$/);
    expect(mints).toHaveLength(2);
    expect(mints[0]?.pathname).toBe(mints[1]?.pathname);
  });
});

describe('the leak rules', () => {
  it('no vfk_ or vc_ in any response on the happy path', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    const joined = await join(harness, roomId);
    const list = await request(harness.url, 'GET', '/api/rooms');
    const detail = await request(harness.url, 'GET', `/api/rooms/${roomId}`);

    for (const answer of [joined, list, detail]) {
      expect(answer.text).not.toContain('vfk_');
      expect(answer.text).not.toContain('vc_');
    }
  });

  it('no vfk_ or vc_ in error responses even when upstream messages carry them', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    harness.fake.forcedCreateError = {
      status: 500,
      code: 'INTERNAL',
      message: 'exploded near vc_secretSecret9999 holding vfk_test_deadbeefdeadbeef',
    };

    const answer = await join(harness, roomId);
    expect(answer.status).toBe(502);
    expect(answer.body.error.code).toBe('REF_UPSTREAM_UNAVAILABLE');
    expect(answer.text).not.toContain('vfk_');
    expect(answer.text).not.toContain('vc_');
  });

  it('no vfk_ or vc_ in any log line, including failure logs', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    await join(harness, roomId);
    harness.fake.forcedCreateError = {
      status: 500,
      code: 'INTERNAL',
      message: 'exploded near vc_secretSecret9999',
    };
    harness.fake.forcedStateErrors.set(harness.fake.latestCallId(), callNotFoundError());
    await join(harness, roomId, { subject: 'guest_ben2' });

    expect(harness.logLines.length).toBeGreaterThan(0);
    const wholeLog = harness.logLines.join('\n');
    expect(wholeLog).not.toContain('vfk_');
    expect(wholeLog).not.toContain('vc_');
    // The request log itself is present and speaks in routes and statuses.
    expect(wholeLog).toContain('POST /api/rooms 201');
  });
});

describe('host authorization', () => {
  it('refuses a wrong key constant-time-style: any length, same 403', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    for (const wrong of ['host_wrong', `${hostKey}x`, hostKey.slice(0, -1), 'a'.repeat(500)]) {
      const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
        mode: 'normal',
        hostKey: wrong,
      });
      expect(answer.status).toBe(403);
      expect(answer.body.error.code).toBe('REF_HOST_UNAUTHORIZED');
    }
    // Nothing was forwarded and nothing persisted.
    expect(harness.fake.requestsOf('PATCH', /^\/v1\/calls\//)).toHaveLength(0);
    const detail = await request(harness.url, 'GET', `/api/rooms/${roomId}`);
    expect(detail.body.mode).toBe('translated');
  });

  it('requires the key field at all', async () => {
    const harness = await startApp();
    const { roomId } = await createRoom(harness);
    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, {});
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe('REF_INVALID_REQUEST');
  });
});

describe('mode changes', () => {
  it('forwards to the live call and persists the room mode', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    await join(harness, roomId);

    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
      mode: 'normal',
      hostKey,
    });

    expect(answer.status).toBe(200);
    expect(answer.body.room.mode).toBe('normal');
    const patches = harness.fake.requestsOf('PATCH', /^\/v1\/calls\//);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ mode: 'normal' });

    // Persisted: a cold reader of the registry file sees the new mode.
    const reloaded = await createFileRoomStore(harness.registry);
    expect(reloaded.get(roomId)?.mode).toBe('normal');
  });

  it('persists without forwarding when no call is live', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);

    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
      mode: 'normal',
      hostKey,
    });

    expect(answer.status).toBe(200);
    expect(harness.fake.requestsOf('PATCH', /^\/v1\/calls\//)).toHaveLength(0);
    const reloaded = await createFileRoomStore(harness.registry);
    expect(reloaded.get(roomId)?.mode).toBe('normal');
    // The next join creates the call directly in the new mode.
    await join(harness, roomId);
    const creates = harness.fake.requestsOf('POST', /^\/v1\/calls$/);
    expect(creates[0]?.body).toEqual({ type: 'conference', mode: 'normal' });
  });

  it('treats a vanished call as fine and still persists', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    await join(harness, roomId);
    const call = harness.fake.calls.get(harness.fake.latestCallId());
    if (call) call.ended = true; // PATCH will answer CALL_ENDED

    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
      mode: 'normal',
      hostKey,
    });

    expect(answer.status).toBe(200);
    const reloaded = await createFileRoomStore(harness.registry);
    expect(reloaded.get(roomId)?.mode).toBe('normal');
    // Mapping was invalidated: the next join creates a fresh call.
    await join(harness, roomId, { subject: 'guest_ben2' });
    expect(harness.fake.createCount()).toBe(2);
  });

  it('does not persist a mode the live call never accepted', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    await join(harness, roomId);
    harness.fake.networkFail = true;

    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/mode`, {
      mode: 'normal',
      hostKey,
    });

    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('REF_UPSTREAM_UNAVAILABLE');
    harness.fake.networkFail = false;
    const reloaded = await createFileRoomStore(harness.registry);
    expect(reloaded.get(roomId)?.mode).toBe('translated');
  });
});

describe('ending a room', () => {
  it('ends the live call, clears the mapping, and keeps the room as history', async () => {
    const harness = await startApp();
    const { roomId, hostKey } = await createRoom(harness);
    await join(harness, roomId);

    const answer = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });

    expect(answer.status).toBe(200);
    expect(answer.body.room.ended).toBe(true);
    expect(harness.fake.requestsOf('POST', /\/end$/)).toHaveLength(1);

    // Durable history: the record survives on disk, marked ended.
    const reloaded = await createFileRoomStore(harness.registry);
    expect(reloaded.get(roomId)?.ended).toBe(true);

    // The list still shows it — never live again.
    const list = await request(harness.url, 'GET', '/api/rooms');
    expect(list.body[0]).toMatchObject({ roomId, ended: true, live: false });

    // Ending again is a calm no-op (mapping already cleared: no second upstream end).
    const again = await request(harness.url, 'POST', `/api/rooms/${roomId}/end`, { hostKey });
    expect(again.status).toBe(200);
    expect(harness.fake.requestsOf('POST', /\/end$/)).toHaveLength(1);
  });
});

describe('GET /api/config', () => {
  it('proxies languages and limits — and nothing else', async () => {
    const harness = await startApp();
    const answer = await request(harness.url, 'GET', '/api/config');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      languages: ['en', 'es', 'fr', 'de'],
      limits: { personalParticipants: 2, conferenceParticipants: 8 },
    });
    expect(answer.text).not.toContain('features');
  });

  it('caches for 60 seconds', async () => {
    const harness = await startApp();
    await request(harness.url, 'GET', '/api/config');
    await request(harness.url, 'GET', '/api/config');
    expect(harness.fake.capabilitiesServed).toBe(1);

    harness.clock.now += 61_000;
    await request(harness.url, 'GET', '/api/config');
    expect(harness.fake.capabilitiesServed).toBe(2);
  });

  it('serves the stale answer when a refresh fails — a lobby beats an error', async () => {
    const harness = await startApp();
    await request(harness.url, 'GET', '/api/config');
    harness.fake.capabilitiesFail = true;
    harness.clock.now += 61_000;

    const answer = await request(harness.url, 'GET', '/api/config');
    expect(answer.status).toBe(200);
    expect(answer.body.languages).toEqual(['en', 'es', 'fr', 'de']);
  });

  it('fails soft with REF_UPSTREAM_UNAVAILABLE only when it has never succeeded', async () => {
    const harness = await startApp();
    harness.fake.capabilitiesFail = true;
    const answer = await request(harness.url, 'GET', '/api/config');
    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('REF_UPSTREAM_UNAVAILABLE');
  });
});

describe('route hygiene', () => {
  it('unknown API routes answer the KC envelope, not an express default page', async () => {
    const harness = await startApp();
    const answer = await request(harness.url, 'GET', '/api/definitely-not-a-route');
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe('REF_NOT_FOUND');
  });
});
