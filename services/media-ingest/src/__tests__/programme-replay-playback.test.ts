/** @author masterzee001 */
/**
 * A broadcast, recorded, and then played back from material it owns.
 *
 * THE DEFINING PROOF OF THE WHOLE REPLAY LANE is here, and it is one line long:
 * the live spool is deleted before anything is played. Everything before this
 * wave could have been satisfied by an archive that wrote down where somebody
 * else kept the bytes, and that archive would have worked in every test until
 * the day retention ran -- which is the day a replay starts being useful.
 *
 * So these tests run the real producer, the real capture wiring, the real
 * durable archive and the real HTTP door, then destroy the spool, restart the
 * archive, and ask a player's questions: give me the playlist, give me the
 * initialisation object, give me that fragment, give me those bytes from the
 * middle of it.
 */
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initFileName } from '@videofy-live/programme-contribution';
import type { MediaOriginOptions, OriginRunResult } from '@videofy-live/programme-contribution';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import type { ReplayInitialisation } from '@videofy-live/programme-replay';
import {
  ProgrammeMediaOrigin,
  type OriginProcess,
  type OriginSpawner,
} from '../programme-media-origin.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import { registerProgrammeReplayRoutes } from '../programme-replay-routes.js';
import { FilesystemReplayDelivery } from '../programme-replay-delivery.js';

const STARTED = 1_700_000_000_000;
const RUN: ProgrammeRunIdentity = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const PLAYLIST = `/replays/${RUN.runId}/playlist.m3u8`;

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

async function request(app: express.Express, path: string, init?: RequestInit): Promise<Reply> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      text: new TextDecoder().decode(buffer),
      bytes: buffer,
      headers: response.headers,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 1));
  }
}

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.length = 0;
});

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

/** An express app serving whatever archive is currently open over `root`. */
function door(root: string, current: () => FilesystemReplayArchive): express.Express {
  const app = express();
  registerProgrammeReplayRoutes(app, {
    archive: {
      begin: (r) => current().begin(r),
      retainInitialisation: (runId, init) => current().retainInitialisation(runId, init),
      retainSegment: (runId, s) => current().retainSegment(runId, s),
      finalise: (runId) => current().finalise(runId),
      fail: (runId, reason, detail) => current().fail(runId, reason, detail),
      expire: (runId, nowMs) => current().expire(runId, nowMs),
      delete: (runId) => current().delete(runId),
      describe: (runId) => current().describe(runId),
    },
    access: { mayView: () => 'allow' },
    delivery: new FilesystemReplayDelivery(root),
  });
  return app;
}

/* ================================ the real producer, recorded and played back */

function fakeSpawner(): OriginSpawner {
  const process: OriginProcess = {
    exited: new Promise<OriginRunResult>(() => undefined),
    stop: () => undefined,
  };
  return { start: (_options: MediaOriginOptions) => process };
}

function playlistOf(count: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2'];
  for (let index = 0; index < count; index += 1) {
    lines.push('#EXTINF:2.000000,');
    lines.push(`seg_${String(index).padStart(5, '0')}.m4s`);
  }
  return `${lines.join('\n')}\n`;
}

describe('a broadcast captured by the live producer, then played back', () => {
  it('records through the real capture path and serves what it owns', async () => {
    const spool = scratch('videofy-e2e-spool-');
    const root = scratch('videofy-e2e-archive-');
    mkdirSync(join(spool, RUN.runId), { recursive: true });

    let opened = await FilesystemReplayArchive.open(root, () => STARTED);
    const begun = await opened.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    expect(begun.ok).toBe(true);

    const timelines = new ProgrammeTimelineRegistry(32, 45_000, undefined, undefined, {
      metadata: true,
      media: true,
    });
    timelines.open(RUN);
    const media = new ProgrammeMediaStore();
    let playlist: string | null = null;
    const origin = new ProgrammeMediaOrigin({
      media,
      timelines,
      egress: new ProgrammeEgressAuthority(timelines, media),
      spoolRoot: spool,
      spawner: fakeSpawner(),
      pollMs: 3_600_000,
      readPlaylist: async () => playlist,
      replay: opened.archive,
    });

    await origin.start(RUN.runId, 'rtmp://source/live');
    writeFileSync(join(spool, RUN.runId, initFileName(0)), Buffer.from('INIT-BYTES'));
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(
        join(spool, RUN.runId, `seg_${String(index).padStart(5, '0')}.m4s`),
        Buffer.from(`SEGMENT-${index}-`.padEnd(160, '.')),
      );
    }
    playlist = playlistOf(3);
    expect(await origin.collect(RUN.runId)).toBe(3);
    await waitFor(async () => ((await opened.archive.describe(RUN.runId))?.segments.length ?? 0) === 3);
    await origin.stop(RUN.runId);

    const held = await opened.archive.describe(RUN.runId);
    expect(held?.status).toBe('available');

    /*
     * THE SPOOL GOES. Everything from here is served from material the archive
     * copied and owns.
     */
    rmSync(spool, { recursive: true, force: true });

    // And the process restarts, so nothing can be answered from a capture cache.
    opened = await FilesystemReplayArchive.open(root, () => STARTED);
    const app = door(root, () => opened.archive);

    const manifest = await request(app, PLAYLIST);
    expect(manifest.status).toBe(200);
    expect(manifest.text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(manifest.text).toContain('#EXT-X-ENDLIST');
    expect(manifest.text).not.toContain(spool);
    expect(manifest.text).not.toContain(root);

    const init = await request(app, `/replays/${RUN.runId}/init/0`);
    expect(init.status).toBe(200);
    expect(new TextDecoder().decode(init.bytes)).toBe('INIT-BYTES');

    const first = await request(app, `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00000`);
    expect(first.status).toBe(200);
    expect(new TextDecoder().decode(first.bytes)).toContain('SEGMENT-0-');

    // Seeking, after all of that.
    const middle = await request(app, `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00001`, {
      headers: { Range: 'bytes=8-15' },
    });
    expect(middle.status).toBe(206);
    expect(middle.bytes.byteLength).toBe(8);
  });
});

/* ============================================== two generations, end to end */

describe('a broadcast whose encoder restarted, played back whole', () => {
  interface Fixture {
    readonly root: string;
    readonly spool: string;
    archive: FilesystemReplayArchive;
    readonly app: express.Express;
  }

  async function twoGenerations(): Promise<Fixture> {
    const spool = scratch('videofy-gen-spool-');
    const root = scratch('videofy-gen-archive-');
    let opened = await FilesystemReplayArchive.open(root, () => STARTED);

    const source = (name: string, body: string): string => {
      const path = join(spool, name);
      writeFileSync(path, Buffer.from(body));
      return path;
    };
    const init = (generation: number): ReplayInitialisation => {
      const path = source(`init.${generation}.mp4`, `INIT-GEN-${generation}-`.padEnd(64, '#'));
      return { runId: RUN.runId, generation, storageReference: path, bytes: statSync(path).size };
    };
    const segment = (index: number, generation: number): ProgrammeMediaSegment => {
      const path = source(
        `g${generation}-seg${index}.m4s`,
        `MEDIA-G${generation}-S${index}-`.padEnd(160, '.'),
      );
      return {
        runId: RUN.runId,
        segmentId: `${RUN.runId}.g${generation}.${String(index).padStart(5, '0')}`,
        startProgrammeTimeMs: index * 2000,
        endProgrammeTimeMs: index * 2000 + 2000,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: path,
        bytes: statSync(path).size,
        initGeneration: generation,
      };
    };

    await opened.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    await opened.archive.retainInitialisation(RUN.runId, init(0));
    await opened.archive.retainSegment(RUN.runId, segment(0, 0));
    await opened.archive.retainSegment(RUN.runId, segment(1, 0));
    await opened.archive.retainInitialisation(RUN.runId, init(1));
    await opened.archive.retainSegment(RUN.runId, segment(2, 1));
    await opened.archive.retainSegment(RUN.runId, segment(3, 1));
    const finalised = await opened.archive.finalise(RUN.runId);
    if (!finalised.ok) throw new Error(`could not finalise: ${finalised.failure.detail}`);

    // Spool destroyed, archive reopened: a different process, and no spool.
    rmSync(spool, { recursive: true, force: true });
    opened = await FilesystemReplayArchive.open(root, () => STARTED);

    const fixture: Fixture = {
      root,
      spool,
      archive: opened.archive,
      app: door(root, () => fixture.archive),
    };
    return fixture;
  }

  it('describes both generations, in order, with the break announced', async () => {
    const fixture = await twoGenerations();
    const manifest = await request(fixture.app, PLAYLIST);
    expect(manifest.status).toBe(200);

    const lines = manifest.text.split('\n').filter((line) => line.length > 0);
    const firstMap = lines.indexOf(`#EXT-X-MAP:URI="/replays/${RUN.runId}/init/0"`);
    const secondMap = lines.indexOf(`#EXT-X-MAP:URI="/replays/${RUN.runId}/init/1"`);
    const discontinuity = lines.indexOf('#EXT-X-DISCONTINUITY');
    const lastOld = lines.indexOf(`/replays/${RUN.runId}/segments/${RUN.runId}.g0.00001`);
    const firstNew = lines.indexOf(`/replays/${RUN.runId}/segments/${RUN.runId}.g1.00002`);

    expect(firstMap).toBeGreaterThanOrEqual(0);
    expect(lastOld).toBeGreaterThan(firstMap);
    expect(discontinuity).toBeGreaterThan(lastOld);
    expect(secondMap).toBeGreaterThan(discontinuity);
    expect(firstNew).toBeGreaterThan(secondMap);
    expect(lines[lines.length - 1]).toBe('#EXT-X-ENDLIST');
  });

  it('serves both initialisation objects independently', async () => {
    const fixture = await twoGenerations();
    const zero = await request(fixture.app, `/replays/${RUN.runId}/init/0`);
    const one = await request(fixture.app, `/replays/${RUN.runId}/init/1`);

    expect(zero.status).toBe(200);
    expect(one.status).toBe(200);
    expect(new TextDecoder().decode(zero.bytes)).toContain('INIT-GEN-0-');
    expect(new TextDecoder().decode(one.bytes)).toContain('INIT-GEN-1-');
    // Two distinct objects, not one served twice.
    expect(zero.bytes).not.toEqual(one.bytes);
  });

  it('serves media from both generations', async () => {
    const fixture = await twoGenerations();
    const old = await request(
      fixture.app,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00000`,
    );
    const fresh = await request(
      fixture.app,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g1.00003`,
    );

    expect(old.status).toBe(200);
    expect(fresh.status).toBe(200);
    expect(new TextDecoder().decode(old.bytes)).toContain('MEDIA-G0-S0-');
    expect(new TextDecoder().decode(fresh.bytes)).toContain('MEDIA-G1-S3-');
  });

  it('seeks inside a second-generation fragment after the restart', async () => {
    const fixture = await twoGenerations();
    const path = `/replays/${RUN.runId}/segments/${RUN.runId}.g1.00002`;
    const whole = await request(fixture.app, path);
    const part = await request(fixture.app, path, { headers: { Range: 'bytes=20-39' } });

    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 20-39/${whole.bytes.byteLength}`);
    expect(part.bytes).toEqual(whole.bytes.slice(20, 40));
  });

  it('consults no live spool anywhere in the process', async () => {
    /*
     * The spool directory does not exist any more. If any route reached for it
     * -- for a playlist, an init object, a fragment or a byte range -- one of
     * these would fail.
     */
    const fixture = await twoGenerations();
    expect(() => statSync(fixture.spool)).toThrow();

    const paths = [
      PLAYLIST,
      `/replays/${RUN.runId}/init/0`,
      `/replays/${RUN.runId}/init/1`,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00000`,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00001`,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g1.00002`,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g1.00003`,
    ];
    for (const path of paths) {
      const reply = await request(fixture.app, path);
      expect(reply.status, path).toBe(200);
      expect(reply.text).not.toContain(fixture.spool);
    }
  });

  it('still refuses everything the moment the recording is deleted', async () => {
    const fixture = await twoGenerations();
    expect((await request(fixture.app, PLAYLIST)).status).toBe(200);

    await fixture.archive.delete(RUN.runId);

    for (const path of [
      PLAYLIST,
      `/replays/${RUN.runId}/init/0`,
      `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00000`,
    ]) {
      const reply = await request(fixture.app, path);
      expect(reply.status).toBe(410);
      expect(reply.text).not.toContain('MEDIA-G0');
    }
  });
});
