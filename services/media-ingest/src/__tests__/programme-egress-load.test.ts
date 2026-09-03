/** @author masterzee001 */
/**
 * Many readers, one encoder, and a cursor that is moving while they read.
 *
 * The single-request tests prove the rule. They cannot prove it holds when the
 * rule is being evaluated hundreds of times against a cursor that advances
 * between the manifest and the fetch -- and that gap is exactly where a
 * protected broadcast would leak, because it is the one state a single-threaded
 * test never enters.
 *
 * THE INVARIANT UNDER LOAD IS THE SAME ONE: nothing ahead of the cursor is
 * ever served. What changes is that the cursor is a moving target, so a client
 * holding a manifest from a moment ago is holding a claim about the past. The
 * assertions here are about the two ways that can go wrong:
 *
 *   TOO GENEROUS  a request is served material the cursor had not reached,
 *                 because the check read a stale cursor. This is the failure
 *                 that hands an audience the future.
 *   TOO MEAN      a segment the manifest just offered is refused a millisecond
 *                 later, because the two answers were computed from different
 *                 states. This is the failure that makes a player stall.
 *
 * AND THE SHAPE: one producer per broadcast, however many people watch. An
 * encoder per viewer would be unscalable in the most expensive way there is,
 * so the reader count is raised and the spawn count is asserted to stay at one.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProgrammeEgressRoutes } from '../programme-egress-routes.js';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import {
  ProgrammeMediaOrigin,
  type OriginProcess,
  type OriginSpawner,
} from '../programme-media-origin.js';
import type { OriginRunResult } from '../media-origin-worker.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;
const SEGMENT_MS = 2_000;
/** Enough requests to interleave; small enough to stay a unit test. */
const READERS = 300;
/**
 * How many are in flight at once.
 *
 * Bounded on purpose. Three hundred simultaneous NEW tcp connections from one
 * client is not the shape a real audience has -- they arrive through a proxy
 * that pools connections -- and it tests the host's listen backlog rather than
 * anything in this service. What matters is that hundreds of requests are
 * evaluated while the cursor moves, which a pool achieves and a thundering
 * herd only obscures.
 */
const IN_FLIGHT = 24;
/** Two minutes of programme, which is 45 s withheld and the rest released. */
const TOTAL_SEGMENTS = 120;

let server: Server;
let base: string;
let spool: string;
let timelines: ProgrammeTimelineRegistry;
let origin: ProgrammeMediaOrigin;
let spawnCount = 0;
let playlistThrough = 0;

function playlist(count: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2'];
  for (let index = 0; index < count; index += 1) {
    lines.push('#EXTINF:2.000000,');
    lines.push(`seg_${String(index).padStart(5, '0')}.m4s`);
  }
  return `${lines.join('\n')}\n`;
}

beforeAll(async () => {
  spool = mkdtempSync(join(tmpdir(), 'videofy-load-'));
  mkdirSync(join(spool, 'run_1'), { recursive: true });
  writeFileSync(join(spool, 'run_1', 'init.mp4'), Buffer.from('INIT'));
  for (let index = 0; index < TOTAL_SEGMENTS; index += 1) {
    writeFileSync(
      join(spool, 'run_1', `seg_${String(index).padStart(5, '0')}.m4s`),
      Buffer.from(`SEGMENT-${index}`.padEnd(48, '.')),
    );
  }

  timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    media: true,
  });
  timelines.open(RUN);
  const media = new ProgrammeMediaStore();
  const egress = new ProgrammeEgressAuthority(timelines, media);

  const spawner: OriginSpawner = {
    start(): OriginProcess {
      spawnCount += 1;
      return {
        exited: new Promise<OriginRunResult>(() => undefined),
        stop: () => undefined,
      };
    },
  };
  origin = new ProgrammeMediaOrigin({
    media,
    timelines,
    egress,
    spoolRoot: spool,
    spawner,
    pollMs: 3_600_000,
    readPlaylist: async () => playlist(playlistThrough),
  });
  await origin.start('run_1', 'rtmp://source/live');

  const app = express();
  registerProgrammeEgressRoutes(app, {
    egress,
    access: { mayView: () => 'allow' },
    spoolRoot: spool,
  });
  server = createServer(app);
  // A generous backlog, so a burst is queued rather than refused.
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', 1_024, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Advance the broadcast by a few segments, as an encoder would. */
async function produce(segments: number): Promise<void> {
  playlistThrough = Math.min(TOTAL_SEGMENTS, playlistThrough + segments);
  await origin.collect('run_1');
}

function segmentUrl(id: string): string {
  return `${base}/programmes/run_1/segments/${encodeURIComponent(id)}`;
}

/** Run `count` requests through a bounded pool, keeping every result. */
async function pool<T>(count: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(IN_FLIGHT, count) }, async () => {
    for (let index = next++; index < count; index = next++) {
      results[index] = await work(index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

async function get(url: string): Promise<Reply> {
  try {
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
  } catch (error) {
    // Reported as data rather than an opaque "fetch failed": a transport
    // failure under load is a finding, and it should name itself.
    const cause = (error as { cause?: { code?: string } }).cause;
    return { status: -1, text: `transport failure: ${cause?.code ?? String(error)}` };
  }
}

describe('the cursor holds while it is moving and being read', () => {
  it('serves a stable broadcast to hundreds of readers without a single fault', async () => {
    await produce(60);

    /*
     * Readers arrive while the encoder keeps producing. The interleaving is
     * the point: half of these requests are evaluated against a cursor that
     * moved after the request began.
     */
    const advancing = (async () => {
      for (let step = 0; step < 10; step += 1) {
        await produce(3);
      }
    })();

    const replies = await pool(READERS, () => get(`${base}/programmes/run_1/playlist.m3u8`));
    await advancing;

    // Not one server fault, and not one refusal, across the whole load.
    const bad = replies.filter((reply) => reply.status !== 200);
    expect(bad.slice(0, 3)).toEqual([]);
    expect(bad).toHaveLength(0);
    expect(replies.every((reply) => reply.text.startsWith('#EXTM3U'))).toBe(true);
  });

  it('never offers a segment it would then refuse', async () => {
    /*
     * TOO MEAN is a real failure and a subtle one: if the manifest and the
     * fetch are computed from different states, a player is handed a segment
     * name and denied it a millisecond later, and it stalls with no
     * explanation. Every segment the manifest offers is fetched immediately,
     * while the cursor keeps advancing underneath.
     */
    const advancing = (async () => {
      for (let step = 0; step < 8; step += 1) await produce(2);
    })();

    const manifest = await fetch(`${base}/programmes/run_1/playlist.m3u8`);
    const offered = (await manifest.text())
      .split(/\r?\n/u)
      // Segment URIs only. The EXT-X-MAP line names the init segment and is
      // quoted, so a naive filter picks up a trailing quote and asks for a
      // segment id that cannot exist.
      .filter((line) => line.startsWith('/programmes/'))
      .map((line) => decodeURIComponent(line.split('/segments/')[1] ?? ''));
    expect(offered.length).toBeGreaterThan(10);

    const fetched = await pool(offered.length, (index) =>
      get(segmentUrl(offered[index] ?? '')),
    );
    await advancing;

    /*
     * Monotonic publication is what makes this safe to assert: the cursor only
     * moves forward, so anything offered a moment ago is still offered now.
     */
    expect(fetched.map((reply) => reply.status).filter((status) => status !== 200)).toEqual([]);
  });

  it('refuses the live edge on every attempt, throughout', async () => {
    const advancing = (async () => {
      for (let step = 0; step < 8; step += 1) await produce(2);
    })();

    /*
     * The last segment produced is always at least the safety delay ahead of
     * the audience, whatever the cursor has reached by the time each of these
     * lands. Guessing the newest name is the obvious move, and it must never
     * work once.
     */
    const edge = `run_1.g0.${String(TOTAL_SEGMENTS - 1).padStart(5, '0')}`;
    const attempts = await pool(READERS, () => get(segmentUrl(edge)));
    await advancing;

    const served = attempts.filter((reply) => reply.status === 200);
    expect(served).toHaveLength(0);
    // Refused because it is not yet public, not because it was not found:
    // the two are different faults and only one is worth alerting on.
    expect(new Set(attempts.map((reply) => reply.status))).toEqual(new Set([403]));
  });

  it('serves no segment body that the audience has not reached', async () => {
    await produce(120);
    const manifest = await fetch(`${base}/programmes/run_1/playlist.m3u8`);
    const text = await manifest.text();

    /*
     * The end of the broadcast, checked as content rather than as a name: a
     * bug that mapped ids to the wrong files would pass every name-based
     * assertion in this file and still hand out the future.
     */
    const withheldFrom = TOTAL_SEGMENTS - DELAY_MS / SEGMENT_MS;
    for (let index = withheldFrom; index < TOTAL_SEGMENTS; index += 1) {
      const id = `run_1.g0.${String(index).padStart(5, '0')}`;
      expect(text).not.toContain(id);
      const reply = await get(segmentUrl(id));
      expect(reply.status).not.toBe(200);
      expect(reply.text).not.toContain(`SEGMENT-${index}`);
    }
  });
});

describe('the shape of the thing', () => {
  it('runs one encoder for a broadcast however many people watch it', () => {
    // Hundreds of readers have been through the routes by now. An encoder per
    // viewer would be unscalable in the most expensive way available, and
    // would also give viewers different segment boundaries -- which quietly
    // destroys the single programme clock everything else is placed against.
    expect(spawnCount).toBe(1);
  });
});
