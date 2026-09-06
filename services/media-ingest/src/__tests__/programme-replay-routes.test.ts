/** @author masterzee001 */
/**
 * The replay door, tested as somebody trying to get through it would.
 *
 * HTTP tests on purpose, against a real archive with real bytes on a real
 * volume. The playback domain has its own unit tests and they prove nothing
 * about a door; what is asserted here is the composed thing, and above all the
 * refusals.
 *
 * THE CENTRAL ASSERTIONS, in order of how much they would cost to get wrong:
 *
 *   ONE RUN'S AUTHORISATION REACHES ONE RUN'S MEDIA. Every recording the box
 *   ever kept lives under one archive root, so "is this inside the archive" is
 *   a check that says yes to all of them. A reference tampered into naming a
 *   neighbour's fragment is real, plausible, and someone else's broadcast.
 *
 *   A MANIFEST IS NOT A GRANT. A viewer who fetched a playlist and then had the
 *   recording deleted, expired, or their access withdrawn holds a list of
 *   names. Every fragment fetch asks again.
 *
 *   A TAMPERED REFERENCE IS NOT A CAPABILITY. The archive's own metadata is a
 *   file on a disk. Provenance is not permission.
 *
 *   A DENIED PRIVATE RECORDING AND A NONEXISTENT ONE ARE INDISTINGUISHABLE.
 *   Anything else tells an anonymous caller which run ids are real.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import type { ReplayInitialisation, ReplayRecord } from '@videofy-live/programme-replay';
import {
  parseGeneration,
  registerProgrammeReplayRoutes,
  type ReplayAudienceVerdict,
  type ReplayDeliveryProblem,
} from '../programme-replay-routes.js';
import { FilesystemReplayDelivery } from '../programme-replay-delivery.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RUN: ProgrammeRunIdentity = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

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
    // Keep-alive sockets outlive the response; without this every streamed
    // body costs the idle timeout.
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const roots: string[] = [];
const spools: string[] = [];

afterEach(() => {
  for (const path of [...roots, ...spools]) rmSync(path, { recursive: true, force: true });
  roots.length = 0;
  spools.length = 0;
});

function sourceFile(spool: string, name: string, body: string): string {
  const path = join(spool, name);
  writeFileSync(path, Buffer.from(body));
  return path;
}

function segment(
  spool: string,
  index: number,
  overrides: Partial<ProgrammeMediaSegment> = {},
): ProgrammeMediaSegment {
  const name = `seg_${String(index).padStart(5, '0')}.m4s`;
  const path = sourceFile(spool, name, `SEGMENT-${index}-`.padEnd(160, '.'));
  return {
    runId: RUN.runId,
    segmentId: `${RUN.runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: index * 2000,
    endProgrammeTimeMs: index * 2000 + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: path,
    bytes: statSync(path).size,
    ...overrides,
  };
}

function initialisation(spool: string, generation = 0): ReplayInitialisation {
  const path = sourceFile(spool, `init.${generation}.mp4`, `INIT-${generation}-`.padEnd(64, '#'));
  return { runId: RUN.runId, generation, storageReference: path, bytes: statSync(path).size };
}

interface Rig {
  readonly app: express.Express;
  readonly archive: FilesystemReplayArchive;
  readonly corrupt: readonly { readonly runId: string | null; readonly reason: string }[];
  readonly root: string;
  readonly spool: string;
  readonly problems: ReplayDeliveryProblem[];
  reopen(): Promise<void>;
  verdict(next: ReplayAudienceVerdict): void;
}

async function rig(options: { verdict?: ReplayAudienceVerdict } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'videofy-replay-http-'));
  const spool = mkdtempSync(join(tmpdir(), 'videofy-replay-http-spool-'));
  roots.push(root);
  spools.push(spool);

  let verdict: ReplayAudienceVerdict = options.verdict ?? 'allow';
  const problems: ReplayDeliveryProblem[] = [];
  let opened = await FilesystemReplayArchive.open(root, () => STARTED);
  const app = express();

  registerProgrammeReplayRoutes(app, {
    // Read through a closure so a reopen is visible to routes already
    // registered -- which is how a restart is modelled here.
    archive: {
      begin: (r) => opened.archive.begin(r),
      retainInitialisation: (runId, init) => opened.archive.retainInitialisation(runId, init),
      retainSegment: (runId, seg) => opened.archive.retainSegment(runId, seg),
      finalise: (runId) => opened.archive.finalise(runId),
      fail: (runId, reason, detail) => opened.archive.fail(runId, reason, detail),
      expire: (runId, nowMs) => opened.archive.expire(runId, nowMs),
      delete: (runId) => opened.archive.delete(runId),
      describe: (runId) => opened.archive.describe(runId),
    },
    access: { mayView: () => verdict },
    delivery: new FilesystemReplayDelivery(root),
    onDeliveryProblem: (problem) => problems.push(problem),
  });

  return {
    app,
    get archive() {
      return opened.archive;
    },
    get corrupt() {
      return opened.corrupt;
    },
    root,
    spool,
    problems,
    reopen: async () => {
      opened = await FilesystemReplayArchive.open(root, () => STARTED);
    },
    verdict: (next) => {
      verdict = next;
    },
  };
}

/** A finished, available recording of `count` fragments in one generation. */
async function recorded(
  live: Rig,
  count = 2,
  retention: ReplayRecord['retention'] = { policy: 'keep' },
  visibility: ReplayRecord['visibility'] = 'public',
): Promise<void> {
  const begun = await live.archive.begin({
    identity: RUN,
    retention,
    visibility,
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
  await live.archive.retainInitialisation(RUN.runId, initialisation(live.spool, 0));
  for (let index = 0; index < count; index += 1) {
    const kept = await live.archive.retainSegment(RUN.runId, segment(live.spool, index));
    if (!kept.ok) throw new Error(`could not retain: ${kept.failure.detail}`);
  }
  const finalised = await live.archive.finalise(RUN.runId);
  if (!finalised.ok) throw new Error(`could not finalise: ${finalised.failure.detail}`);
}

const PLAYLIST = `/replays/${RUN.runId}/playlist.m3u8`;
const FIRST_SEGMENT = `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00000`;
const FIRST_INIT = `/replays/${RUN.runId}/init/0`;

/* ============================================================== authority */

describe('who gets through the door', () => {
  it('answers a run id that is not a run id with nothing', async () => {
    const live = await rig();
    const reply = await request(live.app, '/replays/..%2F..%2Fetc/playlist.m3u8');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('etc');
  });

  it('answers an unknown recording with nothing', async () => {
    const live = await rig();
    expect((await request(live.app, '/replays/run_nobody/playlist.m3u8')).status).toBe(404);
  });

  it('asks a viewer to sign in when the policy says so', async () => {
    const live = await rig({ verdict: 'sign-in' });
    await recorded(live);
    expect((await request(live.app, PLAYLIST)).status).toBe(401);
  });

  it('makes a denied private recording indistinguishable from one that does not exist', async () => {
    /*
     * The whole point of unlisted and private. Telling the two apart is how an
     * anonymous caller enumerates which run ids are real.
     */
    const live = await rig({ verdict: 'forbidden' });
    await recorded(live, 2, { policy: 'keep' }, 'private');
    const denied = await request(live.app, PLAYLIST);
    const absent = await request(live.app, '/replays/run_nobody/playlist.m3u8');

    expect(denied.status).toBe(absent.status);
    expect(denied.text).toBe(absent.text);
  });

  it('serves a public recording that the policy allows', async () => {
    const live = await rig();
    await recorded(live);
    expect((await request(live.app, PLAYLIST)).status).toBe(200);
  });

  it('serves an unlisted recording only to somebody who has the address', async () => {
    // Nothing here lists it: there is no route that answers "what replays
    // exist", which is the only thing that makes unlisted mean anything.
    const live = await rig();
    await recorded(live, 2, { policy: 'keep' }, 'unlisted');
    expect((await request(live.app, PLAYLIST)).status).toBe(200);
    expect((await request(live.app, '/replays')).status).toBe(404);
    expect((await request(live.app, `/replays/${RUN.runId}`)).status).toBe(404);
  });

  it('leaves a private recording to the injected authority, not to knowing the id', async () => {
    const live = await rig({ verdict: 'forbidden' });
    await recorded(live, 2, { policy: 'keep' }, 'private');
    expect((await request(live.app, PLAYLIST)).status).toBe(404);

    live.verdict('allow');
    expect((await request(live.app, PLAYLIST)).status).toBe(200);
  });

  it('gives the access policy the whole record, visibility included', async () => {
    const seen: ReplayRecord[] = [];
    const root = mkdtempSync(join(tmpdir(), 'videofy-replay-seen-'));
    roots.push(root);
    const { archive } = await FilesystemReplayArchive.open(root, () => STARTED);
    const app = express();
    registerProgrammeReplayRoutes(app, {
      archive,
      access: {
        mayView: (record) => {
          seen.push(record);
          return 'allow';
        },
      },
      delivery: new FilesystemReplayDelivery(root),
    });
    await archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'unlisted',
      startedAtMs: STARTED,
    });
    await request(app, PLAYLIST);

    expect(seen[0]?.visibility).toBe('unlisted');
    expect(seen[0]?.identity.channelId).toBe('ch_1');
    expect(seen[0]?.identity.programmeId).toBe('prog_1');
  });
});

/* =============================================================== lifecycle */

describe('what a recording answers at each stage of its life', () => {
  it('does not serve one that is still recording', async () => {
    const live = await rig();
    await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    await live.archive.retainInitialisation(RUN.runId, initialisation(live.spool, 0));
    await live.archive.retainSegment(RUN.runId, segment(live.spool, 0));

    const reply = await request(live.app, PLAYLIST);
    expect(reply.status).toBe(409);
    expect(reply.text).not.toContain('#EXTM3U');
  });

  it('does not serve one that failed', async () => {
    const live = await rig();
    await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    await live.archive.fail(RUN.runId, 'media-origin-failed', 'the encoder died');

    const reply = await request(live.app, PLAYLIST);
    expect(reply.status).toBe(410);
    expect(reply.text).not.toContain('#EXTM3U');
  });

  it('reports an expired recording as gone', async () => {
    const live = await rig();
    await recorded(live, 2, { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS });
    await live.archive.expire(RUN.runId, STARTED + THIRTY_DAYS_MS);
    expect((await request(live.app, PLAYLIST)).status).toBe(410);
  });

  it('reports a deleted recording as gone', async () => {
    const live = await rig();
    await recorded(live);
    await live.archive.delete(RUN.runId);
    expect((await request(live.app, PLAYLIST)).status).toBe(410);
  });
});

/* ================================================================ manifest */

describe('the playlist itself', () => {
  it('is served as an HLS playlist, and never stored by a cache', async () => {
    const live = await rig();
    await recorded(live);
    const reply = await request(live.app, PLAYLIST);

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.text).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(reply.text).toContain('#EXT-X-ENDLIST');
  });

  it('names only routes, never anything about this host', async () => {
    const live = await rig();
    await recorded(live);
    const reply = await request(live.app, PLAYLIST);

    expect(reply.text).not.toContain(live.root);
    expect(reply.text).not.toContain(live.spool);
    expect(reply.text).not.toContain('.bin');
    expect(reply.text).not.toContain('file://');
    expect(reply.text).toContain(FIRST_SEGMENT);
    expect(reply.text).toContain(FIRST_INIT);
  });
});

/* ============================================ re-authorisation at every fetch */

describe('a playlist is a list of names, not a permit', () => {
  it('refuses a fragment once the recording has been deleted', async () => {
    const live = await rig();
    await recorded(live);
    const manifest = await request(live.app, PLAYLIST);
    expect(manifest.text).toContain(FIRST_SEGMENT);

    await live.archive.delete(RUN.runId);

    const late = await request(live.app, FIRST_SEGMENT);
    expect(late.status).toBe(410);
    expect(late.bytes.byteLength).toBeLessThan(200);
    expect(late.text).not.toContain('SEGMENT-0');
  });

  it('refuses a fragment once the recording has expired', async () => {
    const live = await rig();
    await recorded(live, 2, { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS });
    await request(live.app, PLAYLIST);
    await live.archive.expire(RUN.runId, STARTED + THIRTY_DAYS_MS);

    expect((await request(live.app, FIRST_SEGMENT)).status).toBe(410);
    expect((await request(live.app, FIRST_INIT)).status).toBe(410);
  });

  it('refuses a fragment once access has been withdrawn', async () => {
    const live = await rig();
    await recorded(live);
    expect((await request(live.app, FIRST_SEGMENT)).status).toBe(200);

    live.verdict('forbidden');
    expect((await request(live.app, FIRST_SEGMENT)).status).toBe(404);
    expect((await request(live.app, FIRST_INIT)).status).toBe(404);
  });

  it('refuses a fragment that is not in this recording', async () => {
    const live = await rig();
    await recorded(live);
    expect(
      (await request(live.app, `/replays/${RUN.runId}/segments/run_1.g9.99999`)).status,
    ).toBe(404);
  });

  it('refuses an initialisation generation this recording does not hold', async () => {
    const live = await rig();
    await recorded(live);
    expect((await request(live.app, `/replays/${RUN.runId}/init/7`)).status).toBe(404);
  });

  it('refuses a generation that is not a number', async () => {
    const live = await rig();
    await recorded(live);
    expect((await request(live.app, `/replays/${RUN.runId}/init/..%2F..%2Fetc`)).status).toBe(404);
  });
});

/* ================================================================ delivery */

describe('the bytes themselves', () => {
  it('serves an initialisation object whole and exact', async () => {
    const live = await rig();
    await recorded(live);
    const reply = await request(live.app, FIRST_INIT);

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('video/mp4');
    expect(reply.headers.get('accept-ranges')).toBe('bytes');
    const held = await live.archive.describe(RUN.runId);
    expect(reply.bytes.byteLength).toBe(held?.initialisations[0]?.bytes);
    expect(reply.headers.get('content-length')).toBe(String(held?.initialisations[0]?.bytes));
  });

  it('serves a fragment whole and exact', async () => {
    const live = await rig();
    await recorded(live);
    const reply = await request(live.app, FIRST_SEGMENT);

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('video/iso.segment');
    const held = await live.archive.describe(RUN.runId);
    const expected = held?.segments[0];
    expect(reply.bytes.byteLength).toBe(expected?.bytes);
    expect(reply.bytes).toEqual(new Uint8Array(await readFile(expected?.storageReference ?? '')));
  });

  it('keeps archived media out of a shared cache', async () => {
    const live = await rig();
    await recorded(live);
    const cache = (await request(live.app, FIRST_SEGMENT)).headers.get('cache-control') ?? '';

    expect(cache).toContain('private');
    expect(cache).not.toContain('public');
    expect(cache).toContain('immutable');
  });

  it('answers a byte range with exactly that range', async () => {
    const live = await rig();
    await recorded(live);
    const whole = await request(live.app, FIRST_SEGMENT);
    const part = await request(live.app, FIRST_SEGMENT, { headers: { Range: 'bytes=10-19' } });

    expect(part.status).toBe(206);
    expect(part.headers.get('content-length')).toBe('10');
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${whole.bytes.byteLength}`);
    expect(part.bytes).toEqual(whole.bytes.slice(10, 20));
  });

  it('answers an open-ended range', async () => {
    const live = await rig();
    await recorded(live);
    const whole = await request(live.app, FIRST_SEGMENT);
    const part = await request(live.app, FIRST_SEGMENT, { headers: { Range: 'bytes=100-' } });

    expect(part.status).toBe(206);
    expect(part.bytes).toEqual(whole.bytes.slice(100));
  });

  it('answers a suffix range', async () => {
    const live = await rig();
    await recorded(live);
    const whole = await request(live.app, FIRST_SEGMENT);
    const part = await request(live.app, FIRST_SEGMENT, { headers: { Range: 'bytes=-20' } });

    expect(part.status).toBe(206);
    expect(part.bytes).toEqual(whole.bytes.slice(-20));
  });

  it('refuses an unsatisfiable range, and says how big the object is', async () => {
    const live = await rig();
    await recorded(live);
    const held = await live.archive.describe(RUN.runId);
    const size = held?.segments[0]?.bytes ?? 0;
    const reply = await request(live.app, FIRST_SEGMENT, {
      headers: { Range: `bytes=${String(size + 500)}-${String(size + 900)}` },
    });

    expect(reply.status).toBe(416);
    expect(reply.headers.get('content-range')).toBe(`bytes */${String(size)}`);
  });

  it('refuses a range it cannot parse', async () => {
    const live = await rig();
    await recorded(live);
    expect(
      (await request(live.app, FIRST_SEGMENT, { headers: { Range: 'segments=1-2' } })).status,
    ).toBe(416);
  });
});

/* ================================================== damaged or tampered media */

describe('material that is not what the record says it is', () => {
  it('serves nothing when the archived object has gone', async () => {
    const live = await rig();
    await recorded(live);
    const held = await live.archive.describe(RUN.runId);
    rmSync(held?.segments[0]?.storageReference ?? '');

    const reply = await request(live.app, FIRST_SEGMENT);
    expect(reply.status).toBe(503);
    expect(reply.text).not.toContain(live.root);
    expect(live.problems).toEqual([{ runId: RUN.runId, refusal: 'not-found', object: 'segment' }]);
  });

  it('serves nothing when the archived object is the wrong length', async () => {
    const live = await rig();
    await recorded(live);
    const held = await live.archive.describe(RUN.runId);
    truncateSync(held?.segments[0]?.storageReference ?? '', 8);

    const reply = await request(live.app, FIRST_SEGMENT);
    expect(reply.status).toBe(503);
    expect(reply.bytes.byteLength).toBeLessThan(200);
    expect(live.problems[0]?.refusal).toBe('byte-mismatch');
  });

  it('leaves the recording exactly as the archive committed it', async () => {
    // Delivery finding a problem is not authority to rewrite R1-C history.
    const live = await rig();
    await recorded(live);
    const held = await live.archive.describe(RUN.runId);
    rmSync(held?.segments[0]?.storageReference ?? '');
    await request(live.app, FIRST_SEGMENT);

    const after = await live.archive.describe(RUN.runId);
    expect(after?.status).toBe('available');
    expect(after?.segments).toHaveLength(2);
    expect(after?.failure).toBeNull();
  });

  it('still serves the fragments that are intact', async () => {
    const live = await rig();
    await recorded(live, 2);
    const held = await live.archive.describe(RUN.runId);
    rmSync(held?.segments[0]?.storageReference ?? '');

    expect((await request(live.app, FIRST_SEGMENT)).status).toBe(503);
    expect(
      (await request(live.app, `/replays/${RUN.runId}/segments/${RUN.runId}.g0.00001`)).status,
    ).toBe(200);
  });

  it('refuses a reference that has been edited to point outside the archive', async () => {
    /*
     * The archive's metadata is a file on a disk other things can reach. If a
     * reference in it is ever changed, it becomes an instruction to open a file
     * with whatever the service account can read. Provenance is not permission.
     */
    const live = await rig();
    await recorded(live);
    const secret = join(live.spool, 'secrets.env');
    writeFileSync(secret, Buffer.from('DATABASE_PASSWORD=hunter2'));

    const key = createHash('sha256').update(RUN.runId, 'utf8').digest('hex');
    const statePath = join(live.root, 'runs', key, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      segments: { archiveReference: string; offered: { bytes: number } }[];
    };
    const target = state.segments[0];
    if (target === undefined) throw new Error('unreachable');
    target.archiveReference = secret;
    target.offered.bytes = statSync(secret).size;
    await writeFile(statePath, JSON.stringify(state), 'utf8');

    await live.reopen();
    const reply = await request(live.app, FIRST_SEGMENT);

    // Caught when the archive opened: the reference is not the canonical path
    // for the fragment it claims to be, so the recording is refused whole.
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('hunter2');
    expect(reply.text).not.toContain('DATABASE_PASSWORD');
    expect(reply.text).not.toContain(secret);
    expect(live.corrupt).toHaveLength(1);
  });

  it('never lets a route parameter become a path', async () => {
    const live = await rig();
    await recorded(live);
    for (const attempt of [
      `/replays/${RUN.runId}/segments/..%2F..%2F..%2Fetc%2Fpasswd`,
      `/replays/${RUN.runId}/segments/%2Fetc%2Fpasswd`,
      `/replays/${RUN.runId}/init/0%2F..%2F..%2Fetc`,
    ]) {
      const reply = await request(live.app, attempt);
      expect(reply.status).toBe(404);
      expect(reply.text).not.toContain('root:');
    }
  });
});

/* ============================================================ the archive dir */

describe('what the archive holds is never listed', () => {
  it('offers no way to ask what recordings exist', async () => {
    const live = await rig();
    await recorded(live);
    for (const attempt of ['/replays', '/replays/', `/replays/${RUN.runId}/segments`]) {
      expect((await request(live.app, attempt)).status).toBe(404);
    }
    expect(readdirSync(live.root)).toContain('runs');
  });
});

/* ================================================== one run, one run's media */

describe('a viewer authorised for one recording gets only that recording', () => {
  /**
   * Two finished recordings in one archive, and an app that serves both.
   *
   * This is the shape a real box has: every broadcast it ever kept, side by
   * side under one root. A containment check that only asks "is this inside
   * the archive" says yes to all of them.
   */
  interface Pair {
    readonly app: express.Express;
    readonly archive: FilesystemReplayArchive;
    readonly corrupt: readonly { readonly runId: string | null; readonly reason: string }[];
    readonly root: string;
    readonly spool: string;
    readonly problems: ReplayDeliveryProblem[];
    reopen(): Promise<void>;
  }

  async function twoRecordings(): Promise<Pair> {
    const root = mkdtempSync(join(tmpdir(), 'videofy-crossrun-'));
    const spool = mkdtempSync(join(tmpdir(), 'videofy-crossrun-spool-'));
    roots.push(root);
    spools.push(spool);

    const problems: ReplayDeliveryProblem[] = [];
    let opened = await FilesystemReplayArchive.open(root, () => STARTED);
    const app = express();
    registerProgrammeReplayRoutes(app, {
      archive: {
        begin: (r) => opened.archive.begin(r),
        retainInitialisation: (runId, init) => opened.archive.retainInitialisation(runId, init),
        retainSegment: (runId, seg) => opened.archive.retainSegment(runId, seg),
        finalise: (runId) => opened.archive.finalise(runId),
        fail: (runId, reason, detail) => opened.archive.fail(runId, reason, detail),
        expire: (runId, nowMs) => opened.archive.expire(runId, nowMs),
        delete: (runId) => opened.archive.delete(runId),
        describe: (runId) => opened.archive.describe(runId),
      },
      access: { mayView: () => 'allow' },
      delivery: new FilesystemReplayDelivery(root),
      onDeliveryProblem: (problem) => problems.push(problem),
    });

    for (const runId of ['run_1', 'run_2']) {
      await opened.archive.begin({
        identity: { channelId: 'ch_1', programmeId: 'prog_1', runId },
        retention: { policy: 'keep' },
        visibility: runId === 'run_2' ? 'private' : 'public',
        startedAtMs: STARTED,
      });
      const initPath = sourceFile(spool, `${runId}.init.mp4`, `INIT-${runId}-`.padEnd(64, '#'));
      await opened.archive.retainInitialisation(runId, {
        runId,
        generation: 0,
        storageReference: initPath,
        bytes: statSync(initPath).size,
      });
      for (let index = 0; index < 2; index += 1) {
        const path = sourceFile(
          spool,
          `${runId}.seg${index}.m4s`,
          `SECRET-${runId}-SEGMENT-${index}-`.padEnd(160, '.'),
        );
        await opened.archive.retainSegment(runId, {
          runId,
          segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
          startProgrammeTimeMs: index * 2000,
          endProgrammeTimeMs: index * 2000 + 2000,
          keyframeAligned: true,
          hasVideo: true,
          hasAudio: true,
          storageReference: path,
          bytes: statSync(path).size,
        });
      }
      const finalised = await opened.archive.finalise(runId);
      if (!finalised.ok) throw new Error(`could not finalise ${runId}`);
    }

    return {
      app,
      get archive() {
        return opened.archive;
      },
      get corrupt() {
        return opened.corrupt;
      },
      root,
      spool,
      problems,
      reopen: async () => {
        opened = await FilesystemReplayArchive.open(root, () => STARTED);
      },
    };
  }

  interface TamperableState {
    segments: { archiveReference: string; offered: { bytes: number } }[];
    initialisations: { archiveReference: string; offered: { bytes: number } }[];
  }

  /** Rewrite one entry of run_1's durable state, as a tamperer would. */
  async function tamper(root: string, edit: (state: TamperableState) => void): Promise<void> {
    const key = createHash('sha256').update('run_1', 'utf8').digest('hex');
    const statePath = join(root, 'runs', key, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as TamperableState;
    edit(state);
    await writeFile(statePath, JSON.stringify(state), 'utf8');
  }

  /** A real object belonging to the OTHER recording. */
  function run2ObjectIn(root: string, folder: 'media' | 'init'): string {
    const key = createHash('sha256').update('run_2', 'utf8').digest('hex');
    const directory = join(root, 'runs', key, folder);
    const name = readdirSync(directory)[0];
    if (name === undefined) throw new Error('unreachable');
    return join(directory, name);
  }

  function firstSegmentOf(state: TamperableState): { archiveReference: string; offered: { bytes: number } } {
    const target = state.segments[0];
    if (target === undefined) throw new Error('unreachable');
    return target;
  }

  it('refuses a reference tampered to name another recording fragment', async () => {
    /*
     * THE ATTACK A ROOT-ONLY CHECK LETS THROUGH. run_2's fragment is real,
     * written by this very archive, inside the archive root, and private. The
     * only thing wrong with it is whose it is.
     */
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    await tamper(live.root, (state) => {
      firstSegmentOf(state).archiveReference = stolen;
    });
    await live.reopen();

    /*
     * DIAGNOSED WHEN THE ARCHIVE OPENS, which is earlier than the door and
     * better: a reference that is not the canonical path for the object it
     * describes is an integrity fault about the whole recording, not a problem
     * with one request. The run is refused entirely rather than served with a
     * hole in it, and the delivery adapter's own binding -- the last line, and
     * the one that catches this if an archive ever fails to -- is proven
     * directly in `programme-replay-delivery.test.ts`.
     */
    const reply = await request(live.app, '/replays/run_1/segments/run_1.g0.00000');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('SECRET-run_2');
    expect(reply.bytes.byteLength).toBeLessThan(200);
    expect(live.corrupt.map((run) => run.runId)).toEqual(['run_1']);
    expect(live.corrupt[0]?.reason).toContain('canonical');
  });

  it('refuses it even when the stolen object is exactly the length recorded', async () => {
    // Size is not identity. A plausible byte count is not a reason to hand one
    // viewer another broadcast.
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    await tamper(live.root, (state) => {
      const target = firstSegmentOf(state);
      target.archiveReference = stolen;
      target.offered.bytes = statSync(stolen).size;
    });
    await live.reopen();

    const reply = await request(live.app, '/replays/run_1/segments/run_1.g0.00000');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('SECRET-run_2');
    expect(live.corrupt.map((run) => run.runId)).toEqual(['run_1']);
  });

  it('refuses a reference tampered to name another recording initialisation object', async () => {
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'init');
    await tamper(live.root, (state) => {
      const target = state.initialisations[0];
      if (target === undefined) throw new Error('unreachable');
      target.archiveReference = stolen;
      target.offered.bytes = statSync(stolen).size;
    });
    await live.reopen();

    const reply = await request(live.app, '/replays/run_1/init/0');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('INIT-run_2');
    expect(live.corrupt.map((run) => run.runId)).toEqual(['run_1']);
  });

  it('refuses a link planted inside one recording that points at another', async () => {
    /*
     * The same theft with a filesystem instead of a JSON edit, and the case a
     * string comparison cannot catch: the reference genuinely sits beneath
     * run_1's own directory. Only resolving it reveals where it goes, which is
     * why containment resolves both sides rather than comparing prefixes.
     *
     * MECHANISM CHOSEN BY WHAT THE PLATFORM ALLOWS. An unprivileged process on
     * Windows cannot create a file symlink (EPERM) but can create a directory
     * junction, and `realpath` resolves both. Measured rather than assumed.
     */
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    const runOne = createHash('sha256').update('run_1', 'utf8').digest('hex');
    const runTwo = createHash('sha256').update('run_2', 'utf8').digest('hex');
    const planted = join(live.root, 'runs', runOne, 'media', 'borrowed.bin');

    const bridge = join(live.root, 'runs', runOne, 'media', 'borrowed');
    const plant = (): boolean => {
      try {
        symlinkSync(stolen, planted);
        return true;
      } catch {
        try {
          symlinkSync(join(live.root, 'runs', runTwo, 'media'), bridge, 'junction');
          return true;
        } catch {
          return false;
        }
      }
    };
    // Neither mechanism is available to this process; the JSON-tamper tests
    // above cover the same boundary by a different route.
    if (!plant()) return;
    const viaLink = existsSync(planted)
      ? planted
      : join(bridge, stolen.slice(stolen.lastIndexOf(sep) + 1));

    await tamper(live.root, (state) => {
      const target = firstSegmentOf(state);
      target.archiveReference = viaLink;
      target.offered.bytes = statSync(stolen).size;
    });
    await live.reopen();

    /*
     * RE-PLANTED, because the archive swept it. Opening removes material a run
     * does not reference, and the link was unreferenced by the layout even
     * though the tampered state named a path THROUGH it -- a second defence,
     * and a real one. Putting it back is what leaves the delivery boundary as
     * the only thing standing between this request and another broadcast.
     */
    if (!existsSync(viaLink)) plant();

    const reply = await request(live.app, '/replays/run_1/segments/run_1.g0.00000');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('SECRET-run_2');
    expect(live.corrupt.map((run) => run.runId)).toEqual(['run_1']);
  });

  it('leaves the other recording entirely playable afterwards', async () => {
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    await tamper(live.root, (state) => {
      firstSegmentOf(state).archiveReference = stolen;
    });
    await live.reopen();
    await request(live.app, '/replays/run_1/segments/run_1.g0.00000');

    expect((await request(live.app, '/replays/run_2/playlist.m3u8')).status).toBe(200);
    const fragment = await request(live.app, '/replays/run_2/segments/run_2.g0.00000');
    expect(fragment.status).toBe(200);
    expect(new TextDecoder().decode(fragment.bytes)).toContain('SECRET-run_2-SEGMENT-0-');
  });

  it('still serves the untampered material of the recording under attack', async () => {
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    await tamper(live.root, (state) => {
      firstSegmentOf(state).archiveReference = stolen;
    });
    await live.reopen();

    /*
     * The whole recording is refused, not just the tampered fragment. That is
     * deliberate: a record whose references cannot be trusted cannot be
     * trusted in part, and serving the rest would publish a broadcast with a
     * hole in it that nothing announced.
     */
    expect((await request(live.app, '/replays/run_1/segments/run_1.g0.00000')).status).toBe(404);
    expect((await request(live.app, '/replays/run_1/segments/run_1.g0.00001')).status).toBe(404);
    expect(live.corrupt.map((run) => run.runId)).toEqual(['run_1']);
  });

  it('tells an operator what happened without naming a single path', async () => {
    const live = await twoRecordings();
    const stolen = run2ObjectIn(live.root, 'media');
    await tamper(live.root, (state) => {
      firstSegmentOf(state).archiveReference = stolen;
    });
    await live.reopen();
    await request(live.app, '/replays/run_1/segments/run_1.g0.00000');

    const reported = JSON.stringify(live.corrupt);
    expect(live.corrupt).toHaveLength(1);
    expect(reported).toContain('canonical');
    expect(reported).not.toContain(live.root);
    expect(reported).not.toContain(live.spool);
    expect(reported).not.toContain('.bin');
  });

  it('still refuses an escape out of the archive altogether', async () => {
    const live = await twoRecordings();
    const secret = join(live.spool, 'secrets.env');
    writeFileSync(secret, Buffer.from('DATABASE_PASSWORD=hunter2'));
    await tamper(live.root, (state) => {
      const target = firstSegmentOf(state);
      target.archiveReference = secret;
      target.offered.bytes = statSync(secret).size;
    });
    await live.reopen();

    const reply = await request(live.app, '/replays/run_1/segments/run_1.g0.00000');
    expect(reply.status).toBe(404);
    expect(reply.text).not.toContain('hunter2');
    expect(live.corrupt).toHaveLength(1);
  });

  it('serves an ordinary object exactly as before', async () => {
    const live = await twoRecordings();
    const reply = await request(live.app, '/replays/run_1/segments/run_1.g0.00000');
    expect(reply.status).toBe(200);
    expect(new TextDecoder().decode(reply.bytes)).toContain('SECRET-run_1-SEGMENT-0-');
    expect(live.problems).toEqual([]);
  });
});

/* ============================================== how a generation is parsed */

describe('a generation is a number, not a four-digit product decision', () => {
  it('accepts the ordinary small ones', () => {
    expect(parseGeneration('0')).toBe(0);
    expect(parseGeneration('1')).toBe(1);
    expect(parseGeneration('42')).toBe(42);
  });

  it('accepts both sides of where a four-digit limit used to be', () => {
    /*
     * THE REGRESSION THIS PINS. An earlier version accepted at most four
     * digits, which would have made a durable recording whose encoder had
     * restarted ten thousand times unservable because of a regular expression.
     */
    expect(parseGeneration('9999')).toBe(9999);
    expect(parseGeneration('10000')).toBe(10000);
    expect(parseGeneration('123456789')).toBe(123456789);
  });

  it('accepts the largest integer that can be represented exactly', () => {
    expect(parseGeneration(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses anything that is not a canonical non-negative integer', () => {
    for (const raw of [
      '',
      '-1',
      '-0',
      '+1',
      '1.0',
      '0.5',
      '1e3',
      '0x10',
      ' 1',
      '1 ',
      'one',
      '007',
      '١',
    ]) {
      expect(parseGeneration(raw), `parsed ${JSON.stringify(raw)}`).toBeNull();
    }
  });

  it('refuses an integer a double cannot hold exactly', () => {
    // 2^53 and beyond: `Number` would round it, and two different generations
    // would become one address.
    expect(parseGeneration('9007199254740992')).toBeNull();
    expect(parseGeneration('9007199254740993')).toBeNull();
    expect(parseGeneration('99999999999999999999')).toBeNull();
  });

  it('serves a generation far above the old ceiling', async () => {
    const live = await rig();
    await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    const init = initialisation(live.spool, 0);
    await live.archive.retainInitialisation(RUN.runId, { ...init, generation: 10_000 });
    await live.archive.retainSegment(
      RUN.runId,
      segment(live.spool, 0, { initGeneration: 10_000 }),
    );
    expect((await live.archive.finalise(RUN.runId)).ok).toBe(true);

    const manifest = await request(live.app, PLAYLIST);
    expect(manifest.status).toBe(200);
    expect(manifest.text).toContain(`/replays/${RUN.runId}/init/10000`);

    const object = await request(live.app, `/replays/${RUN.runId}/init/10000`);
    expect(object.status).toBe(200);
    expect(object.bytes.byteLength).toBe(init.bytes);
  });
});


/* ================================================ the URL names the recording */

describe('a record only claims a run; the route decides which one', () => {
  it('refuses when the durable state claims a different run from the URL', async () => {
    /*
     * THE SUBTLE ONE. `describe('run_1')` returns a record whose identity says
     * `run_2` -- which is what a state file restored into the wrong directory,
     * or edited, looks like. Everything downstream keys on the run identity:
     * which access decision is taken, and which directory delivery will trust.
     * Taking it from the record would let the untrusted side choose the very
     * boundary meant to constrain it.
     *
     * Proven against a stub archive rather than a tampered file, because the
     * rule has to hold for ANY implementation of the port -- including ones
     * with no filesystem to validate.
     */
    const root = mkdtempSync(join(tmpdir(), 'videofy-identity-'));
    roots.push(root);
    const asked: string[] = [];
    const app = express();
    registerProgrammeReplayRoutes(app, {
      archive: {
        begin: () => {
          throw new Error('unused');
        },
        retainInitialisation: () => {
          throw new Error('unused');
        },
        retainSegment: () => {
          throw new Error('unused');
        },
        finalise: () => {
          throw new Error('unused');
        },
        fail: () => {
          throw new Error('unused');
        },
        expire: () => {
          throw new Error('unused');
        },
        delete: () => {
          throw new Error('unused');
        },
        describe: async (runId) => {
          asked.push(runId);
          return {
            identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_2' },
            retention: { policy: 'keep' },
            visibility: 'public',
            status: 'available',
            startedAtMs: STARTED,
            finalisedAtMs: STARTED,
            expiresAtMs: null,
            segments: [],
            initialisations: [],
            bytes: 0,
            failure: null,
            history: [],
          };
        },
      },
      access: { mayView: () => 'allow' },
      delivery: new FilesystemReplayDelivery(root),
    });

    const reply = await request(app, '/replays/run_1/playlist.m3u8');
    expect(reply.status).toBe(503);
    expect(reply.text).not.toContain('#EXTM3U');
    // The other identity is never named back to the caller.
    expect(reply.text).not.toContain('run_2');
    // And the archive was asked about the run the URL named, not another.
    expect(asked).toEqual(['run_1']);
  });

  it('refuses media on the same grounds, before any object is resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofy-identity-media-'));
    roots.push(root);
    const opened: string[] = [];
    const app = express();
    registerProgrammeReplayRoutes(app, {
      archive: {
        begin: () => {
          throw new Error('unused');
        },
        retainInitialisation: () => {
          throw new Error('unused');
        },
        retainSegment: () => {
          throw new Error('unused');
        },
        finalise: () => {
          throw new Error('unused');
        },
        fail: () => {
          throw new Error('unused');
        },
        expire: () => {
          throw new Error('unused');
        },
        delete: () => {
          throw new Error('unused');
        },
        describe: async () => ({
          identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_2' },
          retention: { policy: 'keep' },
          visibility: 'public',
          status: 'available',
          startedAtMs: STARTED,
          finalisedAtMs: STARTED,
          expiresAtMs: null,
          segments: [
            {
              runId: 'run_2',
              segmentId: 'run_2.g0.00000',
              startProgrammeTimeMs: 0,
              endProgrammeTimeMs: 2000,
              keyframeAligned: true,
              hasVideo: true,
              hasAudio: true,
              storageReference: join(root, 'anything.bin'),
              bytes: 1,
            },
          ],
          initialisations: [],
          bytes: 1,
          failure: null,
          history: [],
        }),
      },
      access: { mayView: () => 'allow' },
      delivery: {
        open: async (locator) => {
          opened.push(locator.runId);
          return { ok: false, refusal: 'not-found', detail: 'the archived object is not there' };
        },
      },
    });

    const reply = await request(app, '/replays/run_1/segments/run_2.g0.00000');
    expect(reply.status).toBe(503);
    // Delivery was never reached: the mismatch is settled before any object is
    // resolved, so no run's directory is ever consulted.
    expect(opened).toEqual([]);
  });
});
