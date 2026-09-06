/** @author masterzee001 */
/**
 * The expiry instant is the audience cutoff, over HTTP, on every route.
 *
 * THE FAILURE THIS CLOSES. A recording retained under `expire` stays
 * `available` until a background sweep moves it, and that sweep can be late,
 * wedged, restarting, or deliberately off during an incident. If access
 * depended on it, an operator's promise that "these are kept for thirty days"
 * would quietly mean "thirty days, or until somebody notices" -- and from
 * outside nothing would look wrong, because the playlist renders perfectly and
 * every fragment serves.
 *
 * So the clock decides, per request, on the playlist AND the initialisation AND
 * the segments. A manifest fetched a second before the instant names objects
 * that are refused a second after it, which is exactly right: the cutoff is not
 * a property of the manifest, it is a property of each request.
 *
 * AND A GET IS NOT A LIFECYCLE TRANSITION. Refusing an audience is not
 * authority to rewrite a record the archive committed, so the record is
 * inspected afterwards and must be untouched.
 */
import express from 'express';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ReplayInitialisation } from '@videofy-live/programme-replay';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import { FilesystemReplayDelivery } from '../programme-replay-delivery.js';
import { registerProgrammeReplayRoutes } from '../programme-replay-routes.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const EXPIRES = STARTED + 30 * DAY_MS;
const RUN = { channelId: 'main', programmeId: 'news', runId: 'run_a' };

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFile(spool: string, name: string, body: string): string {
  const path = join(spool, name);
  writeFileSync(path, Buffer.from(body));
  return path;
}

interface Rig {
  readonly url: string;
  readonly archive: FilesystemReplayArchive;
  setNow(at: number): void;
}

/** A finished, expiring recording behind live routes with a movable clock. */
async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'videofy-cutoff-'));
  const spool = mkdtempSync(join(tmpdir(), 'videofy-cutoff-spool-'));
  roots.push(root, spool);

  const { archive } = await FilesystemReplayArchive.open(root, () => STARTED);
  await archive.begin({
    identity: RUN,
    retention: { policy: 'expire', expiresAtMs: EXPIRES },
    visibility: 'public',
    startedAtMs: STARTED,
  });

  const initPath = sourceFile(spool, 'init.mp4', 'INIT-'.padEnd(64, '#'));
  const init: ReplayInitialisation = {
    runId: RUN.runId,
    generation: 0,
    storageReference: initPath,
    bytes: statSync(initPath).size,
  };
  await archive.retainInitialisation(RUN.runId, init);

  for (let index = 0; index < 2; index += 1) {
    const path = sourceFile(spool, `${index}.m4s`, `SEG-${index}-`.padEnd(256, '.'));
    const segment: ProgrammeMediaSegment = {
      runId: RUN.runId,
      segmentId: `run_a.g0.${String(index).padStart(5, '0')}`,
      startProgrammeTimeMs: index * 2000,
      endProgrammeTimeMs: index * 2000 + 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: path,
      bytes: statSync(path).size,
    };
    await archive.retainSegment(RUN.runId, segment);
  }
  const finalised = await archive.finalise(RUN.runId);
  if (!finalised.ok) throw new Error(`could not finalise: ${finalised.failure.detail}`);

  let now = STARTED;
  const app = express();
  registerProgrammeReplayRoutes(app, {
    archive,
    access: { mayView: () => 'allow' },
    delivery: new FilesystemReplayDelivery(root),
    now: () => now,
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    archive,
    setNow: (at) => {
      now = at;
    },
  };
}

const PATHS = [
  '/replays/run_a/playlist.m3u8',
  '/replays/run_a/init/0',
  '/replays/run_a/segments/run_a.g0.00000',
] as const;

describe('every playable route refuses at the expiry instant', () => {
  it('serves each of them a millisecond before', async () => {
    const r = await rig();
    r.setNow(EXPIRES - 1);
    for (const path of PATHS) {
      const response = await fetch(`${r.url}${path}`);
      expect(response.status, path).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('refuses each of them AT the instant, with 410', async () => {
    /*
     * 410, THE SAME ANSWER THE SWEPT RECORDING GETS. A viewer must not be able
     * to tell whether the worker has caught up: partly because it is none of
     * their business, and partly because a distinguishable answer would make
     * the cutoff look advisory. A player reading 410 stops rather than retrying
     * against something that is never coming back.
     */
    const r = await rig();
    r.setNow(EXPIRES);
    for (const path of PATHS) {
      const response = await fetch(`${r.url}${path}`);
      expect(response.status, path).toBe(410);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('This replay is no longer available.');
    }
  });

  it('refuses long after, while the archive still says available', async () => {
    const r = await rig();
    r.setNow(EXPIRES + 365 * DAY_MS);
    for (const path of PATHS) {
      expect((await fetch(`${r.url}${path}`)).status, path).toBe(410);
    }
    // The worker has never run. That is exactly the point.
    expect((await r.archive.describe(RUN.runId))?.status).toBe('available');
  });

  it('a range request is refused too, rather than serving 206 past the cutoff', async () => {
    // The route sets range headers only after admission; this proves admission
    // really does come first.
    const r = await rig();
    r.setNow(EXPIRES);
    const response = await fetch(`${r.url}/replays/run_a/segments/run_a.g0.00000`, {
      headers: { range: 'bytes=0-9' },
    });
    expect(response.status).toBe(410);
  });

  it('the refusal mutates nothing', async () => {
    /*
     * A GET IS NOT A LIFECYCLE TRANSITION. The archive committed this record;
     * refusing an audience is not authority to rewrite it, and a route that
     * expired something on read would be doing maintenance from an anonymous
     * request.
     */
    const r = await rig();
    const before = await r.archive.describe(RUN.runId);
    r.setNow(EXPIRES + DAY_MS);
    for (const path of PATHS) await fetch(`${r.url}${path}`);
    const after = await r.archive.describe(RUN.runId);
    expect(after?.status).toBe('available');
    expect(after?.history).toEqual(before?.history);
    expect(after?.segments).toHaveLength(2);
  });

  it('a manifest fetched before the cutoff does not license fragments after it', async () => {
    /*
     * THE CUTOFF IS PER REQUEST, NOT PER MANIFEST. A player that fetched a
     * playlist at 23:59 and asks for its fragments at 00:01 is refused, which
     * is the behaviour a retention promise actually requires.
     */
    const r = await rig();
    r.setNow(EXPIRES - 1000);
    const playlist = await fetch(`${r.url}/replays/run_a/playlist.m3u8`);
    expect(playlist.status).toBe(200);
    const body = await playlist.text();
    expect(body).toContain('/replays/run_a/segments/run_a.g0.00000');

    r.setNow(EXPIRES);
    expect((await fetch(`${r.url}/replays/run_a/segments/run_a.g0.00000`)).status).toBe(410);
  });

  it('a kept recording is never cut off, however long ago it aired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofy-cutoff-keep-'));
    const spool = mkdtempSync(join(tmpdir(), 'videofy-cutoff-keep-spool-'));
    roots.push(root, spool);
    const { archive } = await FilesystemReplayArchive.open(root, () => STARTED);
    await archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    const initPath = sourceFile(spool, 'init.mp4', 'INIT-'.padEnd(64, '#'));
    await archive.retainInitialisation(RUN.runId, {
      runId: RUN.runId,
      generation: 0,
      storageReference: initPath,
      bytes: statSync(initPath).size,
    });
    const path = sourceFile(spool, '0.m4s', 'SEG-'.padEnd(256, '.'));
    await archive.retainSegment(RUN.runId, {
      runId: RUN.runId,
      segmentId: 'run_a.g0.00000',
      startProgrammeTimeMs: 0,
      endProgrammeTimeMs: 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: path,
      bytes: statSync(path).size,
    });
    await archive.finalise(RUN.runId);

    const app = express();
    registerProgrammeReplayRoutes(app, {
      archive,
      access: { mayView: () => 'allow' },
      delivery: new FilesystemReplayDelivery(root),
      now: () => STARTED + 100 * 365 * DAY_MS,
    });
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/replays/run_a/playlist.m3u8`);
    expect(response.status).toBe(200);
    await response.text();
  });
});
