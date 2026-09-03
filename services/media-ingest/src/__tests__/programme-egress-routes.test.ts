/** @author masterzee001 */
/**
 * The public door, tested as an attacker would use it.
 *
 * These are HTTP tests on purpose. The authority underneath already has its
 * own unit tests, and they proved nothing about production for as long as no
 * route existed -- which was the actual state of this service until now. What
 * is asserted here is the composed thing: express, a real spool on disk, real
 * bytes, and the refusals that arrive when somebody asks for what is not
 * theirs.
 *
 * THE CENTRAL ASSERTION is that a segment which EXISTS ON DISK and has not
 * been published is refused. Everything the safety delay promises collapses if
 * guessing the next filename works, and the manifest alone can never prevent
 * that, because names are sequential and clients can count.
 */
import express from 'express';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProgrammeEgressRoutes,
  type AudienceVerdict,
} from '../programme-egress-routes.js';
import { ProgrammeEgressAuthority, initSegmentId } from '../programme-egress.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;
const SEGMENT_MS = 1500;

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
}

async function request(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<Reply> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, text: await response.text(), headers: response.headers };
  } finally {
    // Keep-alive sockets outlive the response; without this the close waits
    // out the idle timeout and every streamed body costs three seconds.
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

interface Rig {
  readonly app: express.Express;
  readonly timelines: ProgrammeTimelineRegistry;
  readonly spool: string;
  readonly futurePeeks: string[];
  /** Produce media up to a programme time, writing real bytes to the spool. */
  readonly produce: (throughMs: number) => void;
  readonly segmentIdAt: (startMs: number) => string;
}

const spools: string[] = [];

function rig(options: { verdict?: () => AudienceVerdict } = {}): Rig {
  const spool = mkdtempSync(join(tmpdir(), 'videofy-egress-'));
  spools.push(spool);
  mkdirSync(join(spool, 'run_1'), { recursive: true });
  writeFileSync(join(spool, 'run_1', 'init.mp4'), Buffer.from('INITSEGMENTBYTES'));

  const timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    media: true,
  });
  timelines.open(RUN);
  const media = new ProgrammeMediaStore();
  const egress = new ProgrammeEgressAuthority(timelines, media);
  egress.noteInitSegment('run_1', join(spool, 'run_1', 'init.mp4'));

  const futurePeeks: string[] = [];
  const app = express();
  registerProgrammeEgressRoutes(app, {
    egress,
    access: { mayView: () => options.verdict?.() ?? 'allow' },
    spoolRoot: spool,
    onFuturePeek: (runId) => futurePeeks.push(runId),
  });

  const segmentIdAt = (startMs: number): string => `run_1_seg_${startMs}`;
  let producedTo = 0;
  const produce = (throughMs: number): void => {
    const timeline = timelines.timeline('run_1');
    for (let ms = producedTo; ms < throughMs; ms += SEGMENT_MS) {
      const reference = join(spool, 'run_1', `${ms}.m4s`);
      // Real bytes: a route that streams from disk must be tested against disk.
      writeFileSync(reference, Buffer.from(`SEGMENT-${ms}`.padEnd(64, '.')));
      const segment: ProgrammeMediaSegment = {
        runId: 'run_1',
        segmentId: segmentIdAt(ms),
        startProgrammeTimeMs: ms,
        endProgrammeTimeMs: ms + SEGMENT_MS,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: reference,
        bytes: 64,
      };
      media.accept(segment);
      timeline?.append({
        programmeTimeMs: ms,
        kind: 'media',
        reference: segment.segmentId,
        durationMs: SEGMENT_MS,
      });
    }
    producedTo = Math.max(producedTo, throughMs);
    timelines.buffer('run_1')?.advance();
  };

  return { app, timelines, spool, futurePeeks, produce, segmentIdAt };
}

afterEach(() => {
  // Left in the OS temp directory rather than removed: a failing test's spool
  // is the only evidence of what was actually written.
  spools.length = 0;
});

describe('a viewer who may not watch is told nothing about the broadcast', () => {
  it('answers a private programme exactly as it answers one that does not exist', async () => {
    const forbidden = rig({ verdict: () => 'forbidden' });
    forbidden.produce(180_000);
    const refused = await request(forbidden.app, '/programmes/run_1/playlist.m3u8');

    const absent = rig();
    const missing = await request(absent.app, '/programmes/run_absent/playlist.m3u8');

    // Different answers here would let anybody enumerate which run ids are
    // real, which is precisely what an unlisted broadcast must not reveal.
    expect(refused.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('asks for a sign-in when that is what is missing', async () => {
    const anonymous = rig({ verdict: () => 'sign-in' });
    anonymous.produce(180_000);
    const reply = await request(anonymous.app, '/programmes/run_1/playlist.m3u8');
    expect(reply.status).toBe(401);
  });

  it('serves no bytes to a viewer refused at the segment', async () => {
    const forbidden = rig({ verdict: () => 'forbidden' });
    forbidden.produce(180_000);
    const reply = await request(
      forbidden.app,
      `/programmes/run_1/segments/${forbidden.segmentIdAt(0)}`,
    );
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('SEGMENT');
  });

  it('asks the policy again on every request rather than remembering a yes', async () => {
    let allowed = true;
    const changing = rig({ verdict: () => (allowed ? 'allow' : 'forbidden') });
    changing.produce(180_000);

    expect((await request(changing.app, '/programmes/run_1/playlist.m3u8')).status).toBe(200);
    // Access revoked mid-broadcast: the next request must feel it.
    allowed = false;
    expect((await request(changing.app, '/programmes/run_1/playlist.m3u8')).status).toBe(404);
  });
});

describe('the playlist describes the cursor, not the encoder', () => {
  it('lists published segments and stops at the audience', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, '/programmes/run_1/playlist.m3u8');

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('mpegurl');
    // Live is 180 000; the audience is at 135 000, and the playlist ends there.
    expect(reply.text).toContain(live.segmentIdAt(135_000 - SEGMENT_MS));
    expect(reply.text).not.toContain(live.segmentIdAt(178_500));
  });

  it('names segments by opaque id and never by a path on our disk', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, '/programmes/run_1/playlist.m3u8');

    // A path in a playlist is a map of the spool, and the spool holds the
    // next forty-five seconds of a protected broadcast.
    expect(reply.text).not.toContain(live.spool);
    expect(reply.text).not.toContain('.m4s');
    expect(reply.text).toContain('/programmes/run_1/segments/');
  });

  it('is never cacheable, because it describes a moving cursor', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, '/programmes/run_1/playlist.m3u8');
    // A cached playlist keeps an audience watching a withdrawn broadcast.
    expect(reply.headers.get('cache-control')).toBe('no-store');
  });

  it('stays open while the broadcast is live', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, '/programmes/run_1/playlist.m3u8');
    // ENDLIST tells a player to stop asking. A live programme must not.
    expect(reply.text).not.toContain('#EXT-X-ENDLIST');
  });

  it('is gone once output has stopped', async () => {
    const live = rig();
    live.produce(180_000);
    live.timelines.buffer('run_1')?.fail('storage lost');

    const reply = await request(live.app, '/programmes/run_1/playlist.m3u8');
    // 410 rather than 404: the broadcast was withdrawn, and a player should
    // stop rather than retry a run that may come back.
    expect(reply.status).toBe(410);
  });
});

describe('a segment on disk is not a segment the audience may have', () => {
  it('refuses one the cursor has not reached, and counts the attempt', async () => {
    const live = rig();
    live.produce(180_000);

    // It exists. Its bytes are on disk. It is 45 seconds ahead of the audience.
    const reply = await request(
      live.app,
      `/programmes/run_1/segments/${live.segmentIdAt(178_500)}`,
    );

    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain('SEGMENT-178500');
    // The only refusal worth an operator's attention: counting sequentially is
    // something somebody does deliberately.
    expect(live.futurePeeks).toEqual(['run_1']);
  });

  it('serves one the cursor has published', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, `/programmes/run_1/segments/${live.segmentIdAt(0)}`);

    expect(reply.status).toBe(200);
    expect(reply.text).toContain('SEGMENT-0');
  });

  it('serves the init segment, without which nothing published decodes', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(
      live.app,
      `/programmes/run_1/segments/${initSegmentId('run_1')}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('INITSEGMENTBYTES');
  });

  it('treats an invented segment as absent, and does not count it as peeking', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, '/programmes/run_1/segments/run_1_seg_invented');

    expect(reply.status).toBe(404);
    // A typo is not an attempt to see the future, and conflating them would
    // bury the signal that matters under ordinary client noise.
    expect(live.futurePeeks).toEqual([]);
  });

  it('never lets a segment id become a path', async () => {
    const live = rig();
    live.produce(180_000);
    for (const attempt of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'run_1%2F..%2Finit.mp4']) {
      const reply = await request(live.app, `/programmes/run_1/segments/${attempt}`);
      expect(reply.status).toBe(404);
    }
  });

  it('allows a byte range, because players ask for one', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, `/programmes/run_1/segments/${live.segmentIdAt(0)}`, {
      headers: { Range: 'bytes=0-6' },
    });

    expect(reply.status).toBe(206);
    expect(reply.text).toBe('SEGMENT');
    expect(reply.headers.get('content-range')).toBe('bytes 0-6/64');
  });

  it('is cacheable only privately, never by anything shared', async () => {
    const live = rig();
    live.produce(180_000);
    const reply = await request(live.app, `/programmes/run_1/segments/${live.segmentIdAt(0)}`);

    const cacheControl = reply.headers.get('cache-control') ?? '';
    // A shared cache would answer the NEXT viewer without the access check
    // ever running, which is how a private broadcast leaks.
    expect(cacheControl).toContain('private');
    expect(cacheControl).not.toContain('public');
  });
});

describe('the containment check that should never fire', () => {
  it('refuses a reference that resolves outside the spool', async () => {
    const spool = mkdtempSync(join(tmpdir(), 'videofy-egress-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'videofy-elsewhere-'));
    writeFileSync(join(elsewhere, 'secret.m4s'), Buffer.from('NOT-OURS-TO-SERVE'));

    const timelines = new ProgrammeTimelineRegistry(32, 0, undefined, undefined, {
      metadata: true,
      media: true,
    });
    timelines.open(RUN);
    const media = new ProgrammeMediaStore();
    media.accept({
      runId: 'run_1',
      segmentId: 'run_1_seg_0',
      startProgrammeTimeMs: 0,
      endProgrammeTimeMs: SEGMENT_MS,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      // A store handing out a reference it did not mint. Unreachable today.
      storageReference: join(elsewhere, 'secret.m4s'),
      bytes: 17,
    });
    timelines.timeline('run_1')?.append({
      programmeTimeMs: 0,
      kind: 'media',
      reference: 'run_1_seg_0',
      durationMs: SEGMENT_MS,
    });
    timelines.buffer('run_1')?.advance();

    const app = express();
    registerProgrammeEgressRoutes(app, {
      egress: new ProgrammeEgressAuthority(timelines, media),
      access: { mayView: () => 'allow' },
      spoolRoot: spool,
    });

    const reply = await request(app, '/programmes/run_1/segments/run_1_seg_0');
    expect(reply.status).toBe(500);
    expect(reply.text).not.toContain('NOT-OURS-TO-SERVE');
  });
});

/*
 * THE SEAM ITSELF. Everything above proves the routes behave; none of it
 * proves a running service ever registers them, and this repository's
 * recurring defect is exactly a correct component that nothing composes.
 * These read the composition root, because that is where the join either
 * exists or does not.
 */
describe('the running service composes this door', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf8',
  );

  it('registers the egress routes at boot', () => {
    expect(source).toContain('registerProgrammeEgressRoutes(app, {');
  });

  it('gives them a containment boundary rather than the whole disk', () => {
    expect(source).toContain('spoolRoot: programmeMediaSpool');
  });

  it('gives them the real access policy, not a permissive stand-in', () => {
    // A composition that answered 'allow' unconditionally would pass every
    // other test in this file and publish every locked broadcast.
    expect(source).toContain('access: createProgrammeAudienceAccess({');
    expect(source).toContain('channelOf: (runId) => programmeTimelines.channelOf(runId)');
  });

  it('falls back to refusing everybody when visibility cannot be resolved', () => {
    expect(source).toContain('VISIBILITY_UNRESOLVABLE');
  });
});
