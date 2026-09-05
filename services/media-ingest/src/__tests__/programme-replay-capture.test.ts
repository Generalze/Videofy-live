/** @author masterzee001 */
/**
 * Does a running programme actually feed the archive, and can the archive hurt it?
 *
 * Two questions, and the second one matters more. Replay capture sits inside
 * the loop that publishes a live broadcast, which means every way it can be
 * slow, broken or absent is a way a programme can go off air -- and none of
 * those ways is visible by reading the happy path. So most of what follows is
 * adversarial: an archive that blocks forever, one that throws, one that
 * refuses, one that is simply not there, and an encoder that dies while work
 * is still queued.
 *
 * THE LIVE ASSERTIONS ARE THE POINT. Nearly every test here checks the
 * timeline and the media store as well as the archive, because "Replay failed"
 * is only an acceptable outcome if the broadcast did not.
 */
import { mkdirSync, mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { initFileName, playlistFileName } from '@videofy-live/programme-contribution';
import type { MediaOriginOptions, OriginRunResult } from '@videofy-live/programme-contribution';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import {
  InMemoryReplayArchive,
  replayRefused,
  type ProgrammeReplayArchive,
  type ReplayInitialisation,
  type ReplayOutcome,
  type ReplayRecord,
  type ReplayRetentionReceipt,
  type ReplayStatus,
} from '@videofy-live/programme-replay';
import {
  ProgrammeMediaOrigin,
  type OriginProcess,
  type OriginSpawner,
} from '../programme-media-origin.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import { logger } from '../logger.js';

const CHANNEL = { channelId: 'ch_1', programmeId: 'prog_1' } as const;
const DELAY_MS = 45_000;
/** What `rig` writes as every generation's initialisation object. */
const INIT_BYTES = 'INIT-BYTES'.length;

function identity(runId: string): ProgrammeRunIdentity {
  return { ...CHANNEL, runId };
}

/**
 * Let every queued microtask and macrotask run.
 *
 * Replay capture is deliberately not awaited by the live path, so a test that
 * asserts immediately after `collect` is asserting about work that has not
 * started. Draining is how the test observes what the broadcast never waits
 * for.
 */
async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    /*
     * A TIMER, NOT `setImmediate`, for the same reason as `waitFor` below:
     * immediates cycle the loop far faster than the filesystem threadpool
     * answers, so a drain that looks generous can finish before any of the
     * work it was draining has had a chance to run. This suite was flaky in
     * exactly that way until it was measured.
     */
    await new Promise((done) => setTimeout(done, 1));
  }
}

/**
 * Wait for something to become true, rather than for a number of turns.
 *
 * A fixed count of ticks is enough to drain the capture chain, whose work is
 * pure. It is NOT enough after an encoder exit: that path re-reads the
 * playlist and syncs files, which is real I/O on a real threadpool, and a
 * test that guessed how long that takes is a test that fails on a busy
 * machine and passes on the author's.
 */
async function waitFor(check: () => Promise<boolean> | boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (await check()) return;
    /*
     * A TIMER, NOT `setImmediate`. Spinning immediates cycles the event loop
     * far faster than the filesystem threadpool answers, so a loop that looks
     * generous can expire before a single `open` has returned. This cost a
     * morning: the implementation was correct and the wait was not.
     */
    await new Promise((done) => setTimeout(done, 1));
  }
}

async function waitForStatus(
  archive: ProgrammeReplayArchive,
  runId: string,
  status: ReplayStatus,
): Promise<void> {
  await waitFor(async () => (await archive.describe(runId))?.status === status);
}

/* --------------------------------------------------------------- the rig */

/** An encoder that never exits unless a test says so. */
function fakeSpawner(): OriginSpawner & {
  exit: (result: OriginRunResult) => void;
} {
  let resolveExit: ((result: OriginRunResult) => void) | null = null;
  const exited = new Promise<OriginRunResult>((resolve) => {
    resolveExit = resolve;
  });
  const process: OriginProcess = { exited, stop: () => undefined };
  return {
    start(_options: MediaOriginOptions) {
      return process;
    },
    exit: (result) => resolveExit?.(result),
  };
}

function playlistOf(...durations: readonly number[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2'];
  durations.forEach((duration, index) => {
    lines.push(`#EXTINF:${duration.toFixed(6)},`);
    lines.push(`seg_${String(index).padStart(5, '0')}.m4s`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * A playlist naming a fragment the filesystem cannot hold.
 *
 * The producer must treat any durability error that is NOT ENOENT as the
 * device refusing. A directory in the fragment's place does not produce that
 * everywhere -- on Windows it opens happily and reports a size of zero -- so
 * the name carries a NUL, which every platform rejects identically. The
 * mechanism is not what is being pinned; the branch is.
 */
function unreadableFragment(): string {
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:2.000000,\nseg_${String.fromCharCode(0)}unreadable.m4s\n`;
}

/**
 * A media store that remembers the exact object it was handed.
 *
 * The canonical segment is constructed once by the producer. Proving Replay
 * receives THAT object rather than one describing the same fragment is what
 * rules out a second description of one piece of media -- which is the defect
 * that only ever shows up as a player giving up, weeks later.
 */
class RecordingMediaStore extends ProgrammeMediaStore {
  readonly accepted: ProgrammeMediaSegment[] = [];

  override accept(segment: ProgrammeMediaSegment): boolean {
    const ok = super.accept(segment);
    if (ok) this.accepted.push(segment);
    return ok;
  }
}

interface Rig {
  readonly origin: ProgrammeMediaOrigin;
  readonly spool: string;
  readonly media: RecordingMediaStore;
  readonly timelines: ProgrammeTimelineRegistry;
  readonly spawner: ReturnType<typeof fakeSpawner>;
  setPlaylist: (runId: string, playlist: string | null) => void;
  rotateEncoder: (runId: string, generation: number) => void;
  mediaEvents: (runId: string) => number;
  cleanup: () => void;
}

function rig(
  replay?: ProgrammeReplayArchive,
  runIds: readonly string[] = ['run_1'],
  pollMs = 3_600_000,
): Rig {
  const spoolRoot = mkdtempSync(join(tmpdir(), 'videofy-replay-'));
  const timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    media: true,
  });
  for (const runId of runIds) {
    mkdirSync(join(spoolRoot, runId), { recursive: true });
    timelines.open(identity(runId));
  }
  const media = new RecordingMediaStore();
  const egress = new ProgrammeEgressAuthority(timelines, media);
  const spawner = fakeSpawner();
  const playlists = new Map<string, string | null>();

  const origin = new ProgrammeMediaOrigin({
    media,
    timelines,
    egress,
    spoolRoot,
    spawner,
    /*
     * Long enough that no timer fires, by default: collection is driven
     * explicitly so the assertions are about logic rather than about waiting.
     * One suite below deliberately shortens it, because whether a stale
     * encoder cleared somebody else's timer is only observable if the timer
     * was going to do something.
     */
    pollMs,
    readPlaylist: async (path) => {
      for (const [runId, playlist] of playlists) {
        if (path.includes(`${runId}`)) return playlist;
      }
      return null;
    },
    ...(replay === undefined ? {} : { replay }),
  });

  return {
    origin,
    spool: spoolRoot,
    media,
    timelines,
    spawner,
    rotateEncoder: (runId, generation) => {
      writeFileSync(join(spoolRoot, runId, playlistFileName(generation)), '#EXTM3U');
    },
    setPlaylist: (runId, value) => {
      playlists.set(runId, value);
      if (value === null) return;
      for (const generation of [0, 1, 2]) {
        writeFileSync(join(spoolRoot, runId, initFileName(generation)), Buffer.from('INIT-BYTES'));
      }
      for (const line of value.split(/\r?\n/u)) {
        const name = line.trim();
        if (!name.endsWith('.m4s')) continue;
        // A name the filesystem cannot hold is deliberate in one test: the
        // playlist lists it and there is no file to write.
        if (name.includes(String.fromCharCode(0))) continue;
        writeFileSync(join(spoolRoot, runId, name), Buffer.from(`SEG-${name}`.padEnd(64, '.')));
      }
    },
    mediaEvents: (runId) =>
      timelines
        .timeline(runId)
        ?.all()
        .filter((event) => event.kind === 'media').length ?? 0,
    cleanup: () => rmSync(spoolRoot, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------- archives */

interface Journal {
  readonly calls: string[];
}

/**
 * A real archive with a journal, and optional sabotage.
 *
 * Delegation rather than a hand-written double: the behaviour under test is
 * the WIRING, and a double that answered differently from the real archive
 * would let the wiring pass against an archive nobody ships.
 */
function journalled(
  archive: ProgrammeReplayArchive,
  /*
   * A sabotage hook returns the outcome the archive should give, or
   * `undefined` to let the real archive answer.
   *
   * `undefined` rather than `null`, and the hooks below are deliberately NOT
   * `async`: an async function returning null yields a *promise* of null,
   * which is truthy, so a hook meaning "delegate" would silently replace every
   * outcome with `null` and the capture chain would read `.ok` off nothing.
   * That cost an hour of blaming the implementation.
   */
  sabotage: {
    readonly onInit?: (
      runId: string,
      init: ReplayInitialisation,
    ) => Promise<ReplayOutcome<ReplayRetentionReceipt>> | undefined;
    readonly onSegment?: (
      runId: string,
      segment: ProgrammeMediaSegment,
    ) => Promise<ReplayOutcome<ReplayRetentionReceipt>> | undefined;
  } = {},
): ProgrammeReplayArchive & Journal {
  const calls: string[] = [];
  return {
    calls,
    begin: (request) => archive.begin(request),
    describe: (runId) => archive.describe(runId),
    expire: (runId, nowMs) => archive.expire(runId, nowMs),
    delete: (runId) => archive.delete(runId),
    fail: (runId, reason, detail) => {
      calls.push(`fail:${runId}:${reason}`);
      return archive.fail(runId, reason, detail);
    },
    finalise: (runId) => {
      calls.push(`finalise:${runId}`);
      return archive.finalise(runId);
    },
    retainInitialisation: (runId, init) => {
      calls.push(`init:${runId}:g${init.generation}`);
      const forced = sabotage.onInit?.(runId, init);
      return forced ?? archive.retainInitialisation(runId, init);
    },
    retainSegment: (runId, segment) => {
      calls.push(`segment:${runId}:${segment.segmentId}`);
      const forced = sabotage.onSegment?.(runId, segment);
      return forced ?? archive.retainSegment(runId, segment);
    },
  };
}

/** A gate a test opens by hand, for proving the live path never waits. */
function gate(): { readonly held: Promise<void>; open: () => void; opened: () => boolean } {
  let release: (() => void) | null = null;
  let wasOpened = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    held,
    open: () => {
      wasOpened = true;
      release?.();
    },
    opened: () => wasOpened,
  };
}

async function beginKeep(archive: ProgrammeReplayArchive, runId: string): Promise<void> {
  const begun = await archive.begin({
    identity: identity(runId),
    retention: { policy: 'keep' },
    visibility: 'private',
    startedAtMs: 1_700_000_000_000,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
}

async function record(
  archive: ProgrammeReplayArchive,
  runId: string,
): Promise<ReplayRecord | null> {
  return archive.describe(runId);
}

/* ============================================================ absent replay */

describe('a producer with no archive behaves exactly as it always did', () => {
  it('publishes the broadcast with no Replay dependency at all', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));

    expect(await live.origin.collect('run_1')).toBe(3);
    expect(live.mediaEvents('run_1')).toBe(3);
    expect(live.media.segmentCount('run_1')).toBe(3);
    await live.origin.stop('run_1');
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    live.cleanup();
  });

  it('produces the identical live result with and without an archive wired in', async () => {
    // The regression that matters: adding Replay must not change one byte of
    // what the audience is served.
    const without = rig();
    await without.origin.start('run_1', 'rtmp://source/live');
    without.setPlaylist('run_1', playlistOf(2, 1.96, 2.04));
    await without.origin.collect('run_1');

    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const wired = rig(archive);
    await wired.origin.start('run_1', 'rtmp://source/live');
    wired.setPlaylist('run_1', playlistOf(2, 1.96, 2.04));
    await wired.origin.collect('run_1');
    await settle();

    expect(wired.media.retainedSegmentIds('run_1')).toEqual(
      without.media.retainedSegmentIds('run_1'),
    );
    expect(wired.mediaEvents('run_1')).toBe(without.mediaEvents('run_1'));
    expect(
      wired.timelines.timeline('run_1')?.all().map((e) => [e.kind, e.programmeTimeMs, e.reference]),
    ).toEqual(
      without.timelines.timeline('run_1')?.all().map((e) => [e.kind, e.programmeTimeMs, e.reference]),
    );
    without.cleanup();
    wired.cleanup();
  });
});

describe('an archive is a capability, never a decision to record', () => {
  it('records nothing when no caller has begun a replay', async () => {
    // The producer has no policy of its own and must not invent one.
    const archive = journalled(new InMemoryReplayArchive());
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();

    expect(await record(archive, 'run_1')).toBeNull();
    expect(live.mediaEvents('run_1')).toBe(2);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    live.cleanup();
  });

  it('manufactures nothing when the broadcast is stopped either', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2));
    await live.origin.stop('run_1');
    await settle();

    expect(await record(archive, 'run_1')).toBeNull();
    // Nothing was finalised and nothing was failed: there was no recording.
    expect(archive.calls.filter((c) => c.startsWith('fail:'))).toEqual([]);
    live.cleanup();
  });

  it('manufactures nothing when the encoder dies on an unrecorded broadcast', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'Connection reset by peer' });
    await settle();

    expect(await record(archive, 'run_1')).toBeNull();
    expect(archive.calls.filter((c) => c.startsWith('fail:'))).toEqual([]);
    // The live failure is unchanged: that part was never Replay's business.
    expect(live.timelines.status('run_1')?.state).toBe('failed');
    live.cleanup();
  });
});

/* ============================================================ happy capture */

describe('what an active recording is given', () => {
  it('captures every segment the live store accepted', async () => {
    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('recording');
    expect(held?.segments.map((s) => s.segmentId)).toEqual(
      live.media.retainedSegmentIds('run_1'),
    );
    live.cleanup();
  });

  it('is handed the very same segment object the live store accepted', async () => {
    // Not an equal one: the same one. Two descriptions of a fragment disagree
    // eventually, and the disagreement surfaces as a player giving up.
    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 1.96));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.segments).toHaveLength(2);
    held?.segments.forEach((segment, index) => {
      expect(segment).toBe(live.media.accepted[index]);
    });
    live.cleanup();
  });

  it('offers the initialisation material before the fragment that needs it', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();

    const first = archive.calls.findIndex((c) => c.startsWith('init:'));
    const firstSegment = archive.calls.findIndex((c) => c.startsWith('segment:'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(firstSegment);
    live.cleanup();
  });

  it('names the generation the fragments were actually written against', async () => {
    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.initialisations.map((i) => i.generation)).toEqual([0]);
    expect(held?.segments[0]?.initGeneration).toBe(0);
    live.cleanup();
  });

  it('records the initialisation size it actually synced', async () => {
    // Read from the same fsynced file, not guessed and not probed again: a
    // second measurement is a second answer that can disagree with the first.
    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    const onDisk = statSync(join(live.spool, 'run_1', initFileName(0))).size;
    expect(held?.initialisations[0]?.bytes).toBe(INIT_BYTES);
    expect(held?.initialisations[0]?.bytes).toBe(onDisk);
    expect(held?.initialisations[0]?.storageReference).toBe(
      join(live.spool, 'run_1', initFileName(0)),
    );
    live.cleanup();
  });

  it('keeps the segments of one run in the order the broadcast produced them', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2, 2, 2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.segments.map((s) => s.startProgrammeTimeMs)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(archive.calls.filter((c) => c.startsWith('segment:'))).toEqual([
      'segment:run_1:run_1.g0.00000',
      'segment:run_1:run_1.g0.00001',
      'segment:run_1:run_1.g0.00002',
      'segment:run_1:run_1.g0.00003',
      'segment:run_1:run_1.g0.00004',
    ]);
    live.cleanup();
  });
});

/* ====================================================== generation rotation */

describe('an encoder that restarts mid-broadcast', () => {
  it('keeps both generations, each against its own initialisation object', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();

    // The encoder rotated: its next generation's playlist now exists.
    live.rotateEncoder('run_1', 1);
    await live.origin.collect('run_1');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.initialisations.map((i) => i.generation).sort()).toEqual([0, 1]);
    // Never flattened: a fragment keeps the generation that decodes it.
    const generations = new Set(held?.segments.map((s) => s.initGeneration));
    expect([...generations].sort()).toEqual([0, 1]);
    live.cleanup();
  });

  it('never offers a fragment before the generation that decodes it', async () => {
    // The ordering rule, stated over the whole journal rather than the first
    // pair: for every segment, its generation was offered earlier.
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    live.rotateEncoder('run_1', 1);
    await live.origin.collect('run_1');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    const seen = new Set<number>();
    for (const call of archive.calls) {
      const init = /^init:run_1:g(\d+)$/u.exec(call);
      if (init?.[1] !== undefined) {
        seen.add(Number(init[1]));
        continue;
      }
      if (!call.startsWith('segment:')) continue;
      const id = call.split(':')[2];
      const segment = held?.segments.find((s) => s.segmentId === id);
      // Only assert about segments that were actually kept.
      if (segment === undefined) continue;
      expect(seen.has(segment.initGeneration ?? 0)).toBe(true);
    }
    live.cleanup();
  });
});

/* ================================================== live independence */

describe('a broken archive is not a broken broadcast', () => {
  it('keeps publishing when initialisation retention is refused', async () => {
    const inner = new InMemoryReplayArchive();
    const archive = journalled(inner, {
      onInit: async () => replayRefused('archive-unavailable', 'the volume went away'),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));

    expect(await live.origin.collect('run_1')).toBe(3);
    await settle();

    // The broadcast is untouched.
    expect(live.mediaEvents('run_1')).toBe(3);
    expect(live.media.segmentCount('run_1')).toBe(3);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    // The recording is honestly dead.
    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.failure?.reason).toBe('archive-unavailable');
    live.cleanup();
  });

  it('keeps publishing when segment retention is refused', async () => {
    const archive = journalled(new InMemoryReplayArchive(), {
      onSegment: async () => replayRefused('archive-unavailable', 'the store said no'),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));

    expect(await live.origin.collect('run_1')).toBe(2);
    await settle();

    expect(live.mediaEvents('run_1')).toBe(2);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    expect((await record(archive, 'run_1'))?.status).toBe('failed');
    live.cleanup();
  });

  it('survives an archive that throws instead of refusing', async () => {
    // The failure mode a durable backend will actually have: an SDK that
    // rejects inside the live segment loop.
    const archive = journalled(new InMemoryReplayArchive(), {
      onSegment: () => {
        throw new Error('the object store hung up');
      },
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));

    // collect itself must not reject.
    await expect(live.origin.collect('run_1')).resolves.toBe(2);
    await settle();

    expect(live.mediaEvents('run_1')).toBe(2);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.failure?.reason).toBe('archive-unavailable');
    live.cleanup();
  });

  it('stops trying once the recording is dead, rather than retrying every segment', async () => {
    // An encoder produces a fragment every two seconds for hours. A dead
    // archive retried per segment is how a broadcast fills a disk with its
    // own complaints.
    const archive = journalled(new InMemoryReplayArchive(), {
      onInit: async () => replayRefused('archive-unavailable', 'gone'),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(...Array.from({ length: 20 }, () => 2)));
    await live.origin.collect('run_1');
    await settle();

    expect(live.mediaEvents('run_1')).toBe(20);
    expect(archive.calls.filter((c) => c.startsWith('init:'))).toHaveLength(1);
    expect(archive.calls.filter((c) => c.startsWith('segment:'))).toHaveLength(0);
    expect(archive.calls.filter((c) => c.startsWith('fail:'))).toHaveLength(1);
    live.cleanup();
  });

  it('never fails the live buffer merely because the recording failed', async () => {
    const archive = journalled(new InMemoryReplayArchive(), {
      onSegment: async () => replayRefused('archive-unavailable', 'no'),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));
    await live.origin.collect('run_1');
    await settle();

    expect((await record(archive, 'run_1'))?.status).toBe('failed');
    // The one assertion this whole file exists for.
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    expect(live.media.segmentCount('run_1')).toBe(3);
    live.cleanup();
  });
});

/* ================================================== non-blocking behaviour */

describe('the live path never waits for the archive', () => {
  it('publishes the broadcast while a Replay write is still hanging', async () => {
    const held = gate();
    const inner = new InMemoryReplayArchive();
    const archive = journalled(inner, {
      onInit: (runId, init) => held.held.then(() => inner.retainInitialisation(runId, init)),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));

    // The archive is hanging and will stay hanging for the whole assertion.
    expect(await live.origin.collect('run_1')).toBe(3);
    await settle();

    expect(held.opened()).toBe(false);
    expect(live.mediaEvents('run_1')).toBe(3);
    expect(live.media.segmentCount('run_1')).toBe(3);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    // Still recording: nothing has been decided about it either way.
    expect((await record(archive, 'run_1'))?.status).toBe('recording');

    held.open();
    await settle();
    live.cleanup();
  });

  it('lets one broadcast keep recording while another one is blocked', async () => {
    // A single global queue would let one slow archive write stall the
    // recording of every other programme on the box.
    const blocked = gate();
    const inner = new InMemoryReplayArchive();
    const archive = journalled(inner, {
      onInit: (runId, init) =>
        runId === 'run_1'
          ? blocked.held.then(() => inner.retainInitialisation(runId, init))
          : undefined,
    });
    await beginKeep(archive, 'run_1');
    await beginKeep(archive, 'run_2');

    const live = rig(archive, ['run_1', 'run_2']);
    await live.origin.start('run_1', 'rtmp://source/live');
    await live.origin.start('run_2', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    live.setPlaylist('run_2', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await live.origin.collect('run_2');
    await waitFor(async () => ((await record(archive, 'run_2'))?.segments.length ?? 0) === 2);

    // Run 1 is stuck at its first init and holds nothing.
    expect((await record(archive, 'run_1'))?.segments ?? []).toHaveLength(0);
    // Run 2 was never asked to wait.
    expect((await record(archive, 'run_2'))?.segments).toHaveLength(2);

    blocked.open();
    await waitFor(async () => ((await record(archive, 'run_1'))?.segments.length ?? 0) === 2);
    expect((await record(archive, 'run_1'))?.segments).toHaveLength(2);
    live.cleanup();
  });
});

/* ================================================= source-media failure */

describe('a hole in the source is not a broken archive', () => {
  it('treats a missing initialisation object as transient and keeps the recording alive', async () => {
    // ENOENT is the packager not having written it yet. The live path already
    // treats it as transient, and a recording must not die of impatience.
    const archive = new InMemoryReplayArchive();
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    rmSync(join(live.spool, 'run_1', initFileName(0)));

    await live.origin.collect('run_1');
    await settle();

    expect(live.mediaEvents('run_1')).toBe(0);
    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('recording');
    expect(held?.failure).toBeNull();
    live.cleanup();
  });

  it('fails the recording, and only the recording, on a real durability failure', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));

    /*
     * A FRAGMENT THE FILESYSTEM REFUSES OUTRIGHT. Not ENOENT -- this is a
     * device that has started to go wrong rather than one that is merely
     * behind, and the branch under test is "any durability error that is not
     * ENOENT fails the broadcast".
     *
     * A DIRECTORY IN THE FRAGMENT'S PLACE DOES NOT PRODUCE THAT EVERYWHERE. On
     * Linux `open(dir, 'r+')` is EISDIR; on Windows it SUCCEEDS and reports a
     * size of zero, which the producer correctly reads as a segment the
     * packager has not finished writing -- so the durability branch is never
     * reached and the test hangs waiting for a failure that was never going to
     * come. Measured, not assumed. A name carrying a NUL is rejected by every
     * platform identically, and the MECHANISM is not what is being pinned.
     */
    live.setPlaylist('run_1', unreadableFragment());

    await live.origin.collect('run_1');
    await waitForStatus(archive, 'run_1', 'failed');

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.failure?.reason).toBe('source-media-unavailable');
    // Not archive-unavailable: the bytes were never there to store.
    expect(held?.failure?.reason).not.toBe('archive-unavailable');
    live.cleanup();
  });
});

/* ============================================== finalisation and races */

describe('when a broadcast ends', () => {
  it('captures the final segments, drains the queue, and only then finalises', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2, 2));

    // Never polled while running: the final read is what saves the tail.
    await live.origin.stop('run_1');

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('available');
    expect(held?.segments).toHaveLength(3);

    const lastSegment = archive.calls.map((c) => c.startsWith('segment:')).lastIndexOf(true);
    const finalise = archive.calls.indexOf('finalise:run_1');
    expect(finalise).toBeGreaterThan(lastSegment);
    live.cleanup();
  });

  it('finalises exactly once when the encoder exits normally', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2));
    live.spawner.exit({ ok: true, exitCode: 0, stderr: '' });
    await waitForStatus(archive, 'run_1', 'available');

    expect((await record(archive, 'run_1'))?.status).toBe('available');
    expect(archive.calls.filter((c) => c === 'finalise:run_1')).toHaveLength(1);
    live.cleanup();
  });

  it('fails a truncated recording rather than calling it available', async () => {
    // Every segment it holds is individually valid, which is exactly why
    // finalise would happily publish it. The difference between a broadcast
    // that ended and one that broke is not visible in the media.
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'Connection reset by peer' });
    await waitForStatus(archive, 'run_1', 'failed');

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.failure?.reason).toBe('media-origin-failed');
    expect(held?.status).not.toBe('available');
    // The live failure is the pre-existing one, unchanged.
    expect(live.timelines.status('run_1')?.state).toBe('failed');
    live.cleanup();
  });

  it('does not finalise twice when a deliberate stop is followed by the exit', async () => {
    // Both run when an operator ends a programme. Only one may own the
    // lifecycle, or a recording is checked without the last of the broadcast.
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));

    await live.origin.stop('run_1');
    live.spawner.exit({ ok: true, exitCode: 0, stderr: '' });
    await settle();

    expect(archive.calls.filter((c) => c === 'finalise:run_1')).toHaveLength(1);
    expect((await record(archive, 'run_1'))?.status).toBe('available');
    live.cleanup();
  });

  it('does not fail a finalised recording when the encoder then exits badly', async () => {
    // The deliberate stop already happened. A non-zero exit afterwards is the
    // encoder being killed, not the broadcast breaking.
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2));

    await live.origin.stop('run_1');
    live.spawner.exit({ ok: false, exitCode: 255, stderr: 'killed' });
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('available');
    expect(archive.calls.filter((c) => c.startsWith('fail:'))).toEqual([]);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    live.cleanup();
  });

  it('drains queued work before failing an abandoned recording', async () => {
    const blocked = gate();
    let released = false;
    const inner = new InMemoryReplayArchive();
    const archive = journalled(inner, {
      onSegment: (runId, segment) =>
        blocked.held.then(() => {
          released = true;
          return inner.retainSegment(runId, segment);
        }),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');

    const dying = (async () => {
      live.spawner.exit({ ok: false, exitCode: 1, stderr: 'gone' });
      await settle(4);
      blocked.open();
      await settle();
    })();
    await dying;

    expect(released).toBe(true);
    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.status).not.toBe('available');
    live.cleanup();
  });

  it('cannot be resurrected by capture work that lands after it is terminal', async () => {
    const archive = journalled(new InMemoryReplayArchive(), {
      onInit: async () => replayRefused('archive-unavailable', 'dead'),
    });
    await beginKeep(archive, 'run_1');
    const live = rig(archive);
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist('run_1', playlistOf(2, 2));
    await live.origin.collect('run_1');
    await settle();
    expect((await record(archive, 'run_1'))?.status).toBe('failed');

    // More of the broadcast arrives, and the run is stopped normally.
    live.setPlaylist('run_1', playlistOf(2, 2, 2, 2));
    await live.origin.collect('run_1');
    await live.origin.stop('run_1');
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('failed');
    expect(held?.status).not.toBe('available');
    live.cleanup();
  });
});

/* ========================================================= independence */

describe('replay capture drags no AI into the live path', () => {
  it('imports only media contracts, never a provider or a language route', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'programme-replay-capture.ts'),
      'utf8',
    );
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/gu)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .filter((specifier) => !specifier.startsWith('.'));

    expect(specifiers.sort()).toEqual([
      '@videofy-live/programme-replay',
      '@videofy-live/programme-timeline',
    ]);
    for (const banned of ['language', 'translation', 'speech', 'vocabulary', 'ai-registry']) {
      expect(source).not.toContain(`@videofy-live/${banned}`);
    }
  });
});


/* ==================================================== what gets reported */

describe('an abandoned recording is reported once, and only when there was one', () => {
  it('says nothing about Replay when a durability failure hits an unrecorded broadcast', async () => {
    /*
     * The live path has no idea whether anybody asked for a recording. If it
     * announced an abandonment anyway, every unrecorded broadcast that met a
     * bad disk would report a failed replay it never had -- which is the
     * manufactured signal this wiring exists to avoid, and the kind that sends
     * somebody looking for a recording that was never configured.
     */
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const archive = journalled(new InMemoryReplayArchive());
      const live = rig(archive);
      await live.origin.start('run_1', 'rtmp://source/live');
      live.setPlaylist('run_1', unreadableFragment());
      await live.origin.collect('run_1');
      await settle();

      expect(await record(archive, 'run_1')).toBeNull();
      expect(archive.calls.filter((c) => c.startsWith('fail:'))).toEqual([]);
      const replayWarnings = warn.mock.calls.filter(
        (call) => call[0] === 'Programme replay abandoned',
      );
      expect(replayWarnings).toEqual([]);
      live.cleanup();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a genuinely abandoned recording exactly once', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const archive = journalled(new InMemoryReplayArchive(), {
        onInit: () => Promise.resolve(replayRefused('archive-unavailable', 'gone')),
      });
      await beginKeep(archive, 'run_1');
      const live = rig(archive);
      await live.origin.start('run_1', 'rtmp://source/live');
      live.setPlaylist('run_1', playlistOf(...Array.from({ length: 12 }, () => 2)));
      await live.origin.collect('run_1');
      await settle();

      expect((await record(archive, 'run_1'))?.status).toBe('failed');
      const replayWarnings = warn.mock.calls.filter(
        (call) => call[0] === 'Programme replay abandoned',
      );
      // Twelve fragments, one complaint.
      expect(replayWarnings).toHaveLength(1);
      live.cleanup();
    } finally {
      warn.mockRestore();
    }
  });
});


/* ============================== a superseded encoder owns nothing */

/**
 * Drive one run through a rotation, leaving the FIRST encoder still un-exited.
 *
 * The dangerous window in a live broadcast: the gateway has rotated to a new
 * encoder, the replacement is already producing, and the old process has not
 * finished dying yet. Its exit is still coming, and it still knows the run id.
 */
async function rotatedPast(
  archive: ProgrammeReplayArchive & Journal,
  pollMs?: number,
): Promise<Rig> {
  const live = pollMs === undefined ? rig(archive) : rig(archive, ['run_1'], pollMs);
  await live.origin.start('run_1', 'rtmp://source/live');
  live.setPlaylist('run_1', playlistOf(2, 2));
  await live.origin.collect('run_1');
  await settle();

  live.rotateEncoder('run_1', 1);
  expect(live.origin.advanceGeneration('run_1')).toBe(true);
  return live;
}

describe('an encoder that has been replaced cannot act on its successor', () => {
  it('rotates the run onto a new generation, leaving the old process still alive', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive);

    // The replacement owns the run, and the old process has not exited yet.
    expect(live.origin.produces('run_1')).toBe(true);
    expect((await record(archive, 'run_1'))?.status).toBe('recording');
    live.cleanup();
  });

  it('ignores a stale unsuccessful exit entirely', async () => {
    /*
     * THE BUG THIS PINS. The dead generation-0 process resolves with a failure
     * long after generation 1 took over. Looked up by run id alone it would
     * find the REPLACEMENT and fail the broadcast, delete the run and end a
     * recording that is still being written -- an encoder killing its own
     * successor.
     */
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive);
    const eventsBefore = live.mediaEvents('run_1');

    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'the old encoder died' });
    await settle();

    // The replacement is untouched in every respect.
    expect(live.origin.produces('run_1')).toBe(true);
    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    expect(live.mediaEvents('run_1')).toBe(eventsBefore);

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('recording');
    expect(held?.failure).toBeNull();
    expect(archive.calls.filter((c) => c.startsWith('fail:'))).toEqual([]);
    expect(archive.calls.filter((c) => c === 'finalise:run_1')).toEqual([]);
    live.cleanup();
  });

  it('ignores a stale successful exit just as completely', async () => {
    // A clean exit from a superseded encoder is not the broadcast ending. It
    // is one process finishing while the programme carries on without it.
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive);

    live.spawner.exit({ ok: true, exitCode: 0, stderr: '' });
    await settle();

    expect(live.origin.produces('run_1')).toBe(true);
    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('recording');
    expect(held?.status).not.toBe('available');
    expect(archive.calls.filter((c) => c === 'finalise:run_1')).toEqual([]);
    live.cleanup();
  });

  it('does not collect the replacement generation on its way out', async () => {
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive);
    const eventsBefore = live.mediaEvents('run_1');

    // Material the REPLACEMENT has not been asked to collect yet.
    live.setPlaylist('run_1', playlistOf(2, 2, 2));
    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'gone' });
    await settle();

    // Untouched: a stale process must not publish its successor's media.
    expect(live.mediaEvents('run_1')).toBe(eventsBefore);

    // And the material was genuinely there to be collected, so the assertion
    // above is about authority rather than about an empty playlist.
    await live.origin.collect('run_1');
    expect(live.mediaEvents('run_1')).toBeGreaterThan(eventsBefore);
    live.cleanup();
  });

  it('does not clear the replacement generation timer', async () => {
    /*
     * Only observable if the timer was going to do something, so this run
     * polls quickly: if the stale exit had cleared it, the segments below
     * would never be registered by anybody.
     */
    const archive = journalled(new InMemoryReplayArchive());
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive, 20);
    const eventsBefore = live.mediaEvents('run_1');

    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'gone' });
    await settle();

    live.setPlaylist('run_1', playlistOf(2, 2, 2));
    await waitFor(() => live.mediaEvents('run_1') > eventsBefore);

    expect(live.mediaEvents('run_1')).toBeGreaterThan(eventsBefore);
    expect(live.origin.produces('run_1')).toBe(true);
    live.cleanup();
  });

  it('cannot end a recording whose capture work was still in flight', async () => {
    // Rotation and a slow archive at once: the stale exit lands while the
    // replacement's own Replay work is still queued.
    const blocked = gate();
    const inner = new InMemoryReplayArchive();
    const archive = journalled(inner, {
      onSegment: (runId, segment) => blocked.held.then(() => inner.retainSegment(runId, segment)),
    });
    await beginKeep(archive, 'run_1');
    const live = await rotatedPast(archive);

    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'gone' });
    await settle();
    blocked.open();
    await settle();

    const held = await record(archive, 'run_1');
    expect(held?.status).toBe('recording');
    expect(held?.failure).toBeNull();

    // The replacement still owns its own ending, and it still works.
    await live.origin.stop('run_1');
    expect((await record(archive, 'run_1'))?.status).toBe('available');
    expect(archive.calls.filter((c) => c === 'finalise:run_1')).toHaveLength(1);
    live.cleanup();
  });
});
