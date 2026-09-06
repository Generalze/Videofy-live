/** @author masterzee001 */
/**
 * The same archive over an object store, and the ways object storage differs.
 *
 * The lifecycle rules are proven once, for every implementation, by
 * `archive-conformance.test.ts`. What is here is only what changes when there is
 * no rename, no fsync, no directory and other processes writing at the same
 * time:
 *
 *   THE ORDERING. Media is uploaded and verified BEFORE any state names it;
 *   state says gone BEFORE any byte is removed. A crash in either gap must
 *   leave the harmless kind of mess, and the tests below interrupt at exactly
 *   those points and then reopen to see what survived.
 *
 *   THE COMPARE-AND-SWAP. Two processes must not both write generation 8. The
 *   conditional create is the mechanism -- and because a store could quietly
 *   ignore it, the archive reads its own write back. `ignoreConditionals` is how
 *   that second guard is proven rather than assumed.
 *
 *   THE REFERENCE IS A KEY, NOT A LOCATOR. No endpoint, no bucket, no
 *   credential ever reaches a state document.
 *
 *   ORPHANS ARE SWEPT AND NOTHING IS RESURRECTED. An object nothing references
 *   is removed; an object the state has released never comes back.
 */
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import { InMemoryObjectStore } from './memory-object-store.js';
import {
  S3CompatibleReplayArchive,
  type ReplaySourceReader,
} from './object-archive.js';
import type { ReplayObjectStore } from './object-store.js';
import {
  replayInitialisationKey,
  replaySegmentKey,
  replayStateGenerationKey,
  replayStatePrefix,
} from './object-layout.js';
import { runReplayExpiryPass } from './lifecycle-worker.js';
import { planReplayPlayback } from './playback.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const RUN = 'run_a';

/** A source with the spool in memory, so a "missing file" is a chosen fact. */
class FakeSource implements ReplaySourceReader {
  readonly files = new Map<string, Buffer>();
  /** References matching this throw, as a spool file that has been pruned. */
  missing: RegExp | null = null;
  /** References matching this yield fewer bytes than declared, mid-upload. */
  truncate: RegExp | null = null;

  put(reference: string, bytes: number, fill = 0x41): void {
    this.files.set(reference, Buffer.alloc(bytes, fill));
  }

  async open(reference: string): Promise<Readable> {
    if (this.missing?.test(reference) === true) {
      throw new Error('the source media is not there');
    }
    const held = this.files.get(reference);
    if (held === undefined) throw new Error('the source media is not there');
    if (this.truncate?.test(reference) === true) {
      return Readable.from([held.subarray(0, Math.max(1, held.length - 10))]);
    }
    return Readable.from([held]);
  }
}

interface World {
  readonly store: InMemoryObjectStore;
  readonly source: FakeSource;
  readonly archive: S3CompatibleReplayArchive;
}

async function world(
  store = new InMemoryObjectStore(),
  source = new FakeSource(),
  now: () => number = () => STARTED,
): Promise<World> {
  const opened = await S3CompatibleReplayArchive.open({ store, source, now });
  return { store, source, archive: opened.archive };
}

function segment(index: number, runId = RUN): ProgrammeMediaSegment {
  return {
    runId,
    segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: index * 2000,
    endProgrammeTimeMs: index * 2000 + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/${runId}/${index}.m4s`,
    bytes: 1000 + index,
  };
}

/**
 * The state document currently in force.
 *
 * FOUND RATHER THAN GUESSED. Superseded generations are pruned, so a test that
 * named one by number would read `undefined` the moment the archive did its job.
 */
function currentState(store: InMemoryObjectStore, runId = RUN): string {
  const keys = store.keys().filter((key) => key.startsWith(replayStatePrefix(runId)));
  const newest = keys[keys.length - 1];
  if (newest === undefined) throw new Error('no state document for this run');
  return store.peek(newest)!.toString('utf8');
}

async function recordTwoSegments(w: World, runId = RUN, retention = { policy: 'keep' } as const) {
  w.source.put(`/spool/${runId}/init.mp4`, 200);
  w.source.put(`/spool/${runId}/0.m4s`, 1000);
  w.source.put(`/spool/${runId}/1.m4s`, 1001);
  const begun = await w.archive.begin({
    identity: { channelId: 'ch_1', programmeId: 'prog_1', runId },
    retention,
    visibility: 'public',
    startedAtMs: STARTED,
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
  await w.archive.retainInitialisation(runId, {
    runId,
    generation: 0,
    storageReference: `/spool/${runId}/init.mp4`,
    bytes: 200,
  });
  await w.archive.retainSegment(runId, segment(0, runId));
  await w.archive.retainSegment(runId, segment(1, runId));
}

/* ============================================================ the ordering */

describe('media is durable before any state names it', () => {
  it('uploads and verifies the object, then writes the state', async () => {
    const w = await world();
    await recordTwoSegments(w);
    /*
     * READ OFF THE STORE'S OWN WRITE LOG. The first segment's object must
     * appear before the state generation that mentions it, or a crash between
     * them would leave a recording naming media that is not there -- which is
     * a replay that lies.
     */
    const objectAt = w.store.writes.indexOf(replaySegmentKey(RUN, segment(0).segmentId));
    const stateAt = w.store.writes.findIndex(
      (key, index) => index > objectAt && key.startsWith(replayStatePrefix(RUN)),
    );
    expect(objectAt).toBeGreaterThanOrEqual(0);
    expect(stateAt).toBeGreaterThan(objectAt);
  });

  it('a failed upload retains nothing, and the state never mentions it', async () => {
    const w = await world();
    await recordTwoSegments(w);
    w.store.inject({ failPut: /media\// });
    const outcome = await w.archive.retainSegment(RUN, segment(2));
    expect(outcome.ok).toBe(false);
    const held = await w.archive.describe(RUN);
    expect(held?.segments).toHaveLength(2);
  });

  it('a source that disappears mid-upload refuses, and stores nothing', async () => {
    const w = await world();
    await recordTwoSegments(w);
    w.source.missing = /2\.m4s$/u;
    const outcome = await w.archive.retainSegment(RUN, segment(2));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('source-media-unavailable');
    expect(outcome.failure.liveImpact).toBe('none');
    expect(w.store.keys()).not.toContain(replaySegmentKey(RUN, segment(2).segmentId));
  });

  it('a short read is refused rather than recorded as a smaller fragment', async () => {
    /*
     * THE COUNT IS NOT ADVISORY. The producer's metadata says what this
     * fragment IS; a copy of a different length is a truncated write or a
     * source still being written, and recording it would make the archive's own
     * byte totals a fiction.
     */
    const w = await world();
    await recordTwoSegments(w);
    w.source.put('/spool/run_a/2.m4s', 1002);
    w.source.truncate = /2\.m4s$/u;
    const outcome = await w.archive.retainSegment(RUN, segment(2));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.detail).toContain('yielded');
  });

  it('an object that is the wrong size after the write is refused', async () => {
    /*
     * THE QUESTION IS WHAT THE STORE NOW HOLDS, not what this process believes
     * it sent -- which is why the check is a head rather than the put's own
     * answer. A store that accepted a short body would otherwise make the
     * archive's byte totals a fiction, and the mismatch would surface as a
     * decode error in somebody's player months later.
     *
     * DELEGATED, NOT SPREAD: a class's methods live on its prototype and a
     * spread copies none of them.
     */
    const real = new InMemoryObjectStore();
    const source = new FakeSource();
    const shortHead: ReplayObjectStore = {
      put: (key, body, options) => real.put(key, body, options),
      putStream: (key, body, size, options) => real.putStream(key, body, size, options),
      get: (key, range) => real.get(key, range),
      delete: (key) => real.delete(key),
      list: (prefix, limit) => real.list(prefix, limit),
      head: async (key) => {
        const found = await real.head(key);
        // Only the media lies; the state read-back must keep working.
        return found === null || !key.includes('/media/')
          ? found
          : { ...found, sizeBytes: found.sizeBytes - 1 };
      },
    };
    const opened = await S3CompatibleReplayArchive.open({
      store: shortHead,
      source,
      now: () => STARTED,
    });
    source.put(`/spool/${RUN}/init.mp4`, 200);
    source.put(`/spool/${RUN}/0.m4s`, 1000);
    await opened.archive.begin({
      identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: RUN },
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    const outcome = await opened.archive.retainSegment(RUN, segment(0));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.detail).toContain('bytes where');
  });
});

describe('release writes the state first, then removes the bytes', () => {
  it('expiry marks the state before it deletes anything', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN, { policy: 'expire', expiresAtMs: STARTED + DAY_MS });
    await w.archive.finalise(RUN);
    w.store.writes.length = 0;
    w.store.deletes.length = 0;

    await w.archive.expire(RUN, STARTED + 2 * DAY_MS);

    /*
     * ONCE THE STATE SAYS `expired` THE MEDIA IS GONE AS FAR AS ANYTHING CAN
     * SEE, so a crash during removal leaves objects nothing references. The
     * other order leaves a window where the state still says `available` and
     * the bytes are already gone -- a playlist rendered onto nothing.
     */
    expect(w.store.writes.some((key) => key.startsWith(replayStatePrefix(RUN)))).toBe(true);
    expect(w.store.deletes.length).toBeGreaterThan(0);
  });

  it('a cleanup that fails after the state persisted leaves it expired, not available', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN, { policy: 'expire', expiresAtMs: STARTED + DAY_MS });
    await w.archive.finalise(RUN);
    w.store.inject({ failDelete: /media\// });

    const outcome = await w.archive.expire(RUN, STARTED + 2 * DAY_MS);
    expect(outcome.ok).toBe(true);
    expect((await w.archive.describe(RUN))?.status).toBe('expired');
    // The bytes are still there, unreferenced, and the next sweep removes them.
    expect(w.store.keys().some((key) => key.startsWith(`runs/`) && key.includes('/media/'))).toBe(true);

    w.store.inject({});
    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect((await reopened.archive.describe(RUN))?.status).toBe('expired');
    expect(w.store.keys().some((key) => key.includes('/media/'))).toBe(false);
  });

  it('an expired recording never comes back after a restart', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN, { policy: 'expire', expiresAtMs: STARTED + DAY_MS });
    await w.archive.finalise(RUN);
    await w.archive.expire(RUN, STARTED + 2 * DAY_MS);

    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    const held = await reopened.archive.describe(RUN);
    expect(held?.status).toBe('expired');
    expect(held?.segments).toHaveLength(0);
    expect(planReplayPlayback(held!, STARTED + 3 * DAY_MS).playable).toBe(false);
  });
});

/* ================================================== the compare-and-swap */

describe('two writers cannot both write one generation', () => {
  it('the conditional create refuses the stale writer', async () => {
    const store = new InMemoryObjectStore();
    const source = new FakeSource();
    const first = await world(store, source);
    await recordTwoSegments(first);

    // A second process that opened before the first wrote anything more.
    const second = await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED });
    source.put('/spool/run_a/2.m4s', 1002);
    source.put('/spool/run_a/3.m4s', 1003);
    const won = await first.archive.retainSegment(RUN, segment(2));
    expect(won.ok, 'the winner must actually win, or this proves nothing').toBe(true);

    const stale = await second.archive.retainSegment(RUN, segment(3));
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.failure.detail).toContain('stale view');
  });

  it('and the read-back catches a store that ignores the conditional', async () => {
    /*
     * THE SECOND GUARD, AND IT IS NOT REDUNDANT. `If-None-Match: *` is the
     * mechanism; a store that accepted the header and overwrote anyway would
     * turn a refused write into a LOST UPDATE -- one process's view of a
     * recording silently replacing another's, with no error anywhere.
     */
    const store = new InMemoryObjectStore({ ignoreConditionals: true });
    const source = new FakeSource();
    const first = await world(store, source);
    await recordTwoSegments(first);
    const second = await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED });
    source.put('/spool/run_a/2.m4s', 1002);
    source.put('/spool/run_a/3.m4s', 1003);
    const won = await first.archive.retainSegment(RUN, segment(2));
    expect(won.ok, 'the winner must actually win, or this proves nothing').toBe(true);

    const stale = await second.archive.retainSegment(RUN, segment(3));
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.failure.detail).toContain('stale view');
  });

  it('the winner keeps its work, and the loser changed nothing', async () => {
    const store = new InMemoryObjectStore();
    const source = new FakeSource();
    const first = await world(store, source);
    await recordTwoSegments(first);
    const second = await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED });
    source.put('/spool/run_a/2.m4s', 1002);
    source.put('/spool/run_a/3.m4s', 1003);
    expect((await first.archive.retainSegment(RUN, segment(2))).ok).toBe(true);
    expect((await second.archive.retainSegment(RUN, segment(3))).ok).toBe(false);

    const reopened = await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED });
    const held = await reopened.archive.describe(RUN);
    // Three segments -- the winner's -- and not the loser's fourth.
    expect(held?.segments.map((entry) => entry.segmentId)).toEqual([
      segment(0).segmentId,
      segment(1).segmentId,
      segment(2).segmentId,
    ]);
  });

  it('the conditional create refuses even when the pre-check cannot see the winner', async () => {
    /*
     * THE CONDITIONAL, ISOLATED FROM THE PRE-CHECK.
     *
     * Two guards protect state writes and they cover different failures. The
     * head-before-write catches a store that IGNORES the conditional. The
     * conditional catches the window the pre-check cannot: two writers landing
     * between one another's check and write.
     *
     * That window is not reproducible by scheduling, so it is reproduced by
     * BLINDING the pre-check -- a store whose head on a state key always says
     * "not there". Everything that refuses the stale writer from here is the
     * conditional and nothing else, which is what makes this a test of it
     * rather than of the guard in front of it.
     */
    const real = new InMemoryObjectStore();
    const source = new FakeSource();
    const blindPreCheck: ReplayObjectStore = {
      put: (key, body, options) => real.put(key, body, options),
      putStream: (key, body, size, options) => real.putStream(key, body, size, options),
      get: (key, range) => real.get(key, range),
      delete: (key) => real.delete(key),
      list: (prefix, limit) => real.list(prefix, limit),
      head: async (key) => (key.includes('/state/') ? null : real.head(key)),
    };

    const first = (
      await S3CompatibleReplayArchive.open({ store: blindPreCheck, source, now: () => STARTED })
    ).archive;
    source.put(`/spool/${RUN}/init.mp4`, 200);
    source.put(`/spool/${RUN}/0.m4s`, 1000);
    source.put(`/spool/${RUN}/1.m4s`, 1001);
    source.put(`/spool/${RUN}/2.m4s`, 1002);
    source.put(`/spool/${RUN}/3.m4s`, 1003);
    await first.begin({
      identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: RUN },
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    await first.retainInitialisation(RUN, {
      runId: RUN,
      generation: 0,
      storageReference: `/spool/${RUN}/init.mp4`,
      bytes: 200,
    });
    await first.retainSegment(RUN, segment(0));

    const second = (
      await S3CompatibleReplayArchive.open({ store: blindPreCheck, source, now: () => STARTED })
    ).archive;
    expect((await first.retainSegment(RUN, segment(1))).ok).toBe(true);

    const stale = await second.retainSegment(RUN, segment(2));
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.failure.detail).toContain('stale view');
  });

  it('a state write that cannot be confirmed is a refusal, not a success', async () => {
    const w = await world();
    await recordTwoSegments(w);
    w.store.inject({ failGet: /state\// });
    w.source.put('/spool/run_a/4.m4s', 1004);
    const outcome = await w.archive.retainSegment(RUN, segment(4));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.detail).toContain('could not confirm');
  });
});

/* ==================================================== restart and orphans */

describe('a restart reads back what was written, and nothing else', () => {
  it('survives losing the archive instance entirely', async () => {
    const w = await world();
    await recordTwoSegments(w);
    await w.archive.finalise(RUN);

    // The spool is gone: a restarted service has no access to the producer's
    // files, and must not need any.
    w.source.files.clear();

    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect(reopened.corrupt).toEqual([]);
    const held = await reopened.archive.describe(RUN);
    expect(held?.status).toBe('available');
    expect(held?.segments).toHaveLength(2);
    expect(planReplayPlayback(held!, STARTED).playable).toBe(true);
  });

  it('reads the HIGHEST generation, not whichever sorts first', async () => {
    /*
     * Object stores list keys as strings, so `10` sorts before `9` unless the
     * width is fixed. Reading the wrong one would restore a recording to a
     * moment it has already moved past.
     */
    const w = await world();
    await recordTwoSegments(w);
    for (let index = 2; index < 12; index += 1) {
      w.source.put(`/spool/run_a/${index}.m4s`, 1000 + index);
      await w.archive.retainSegment(RUN, segment(index));
    }
    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect((await reopened.archive.describe(RUN))?.segments).toHaveLength(12);
  });

  it('sweeps an orphan object nothing references', async () => {
    /*
     * A retention that died before its metadata. The state is the authority, so
     * the object goes -- which is what makes the crash ordering safe rather
     * than merely survivable.
     */
    const w = await world();
    await recordTwoSegments(w);
    const orphan = replaySegmentKey(RUN, 'run_a.g0.99999');
    w.store.plant(orphan, Buffer.alloc(50));
    expect(w.store.keys()).toContain(orphan);

    await S3CompatibleReplayArchive.open({ store: w.store, source: w.source, now: () => STARTED });
    expect(w.store.keys()).not.toContain(orphan);
  });

  it('an orphan never becomes replay truth', async () => {
    const w = await world();
    await recordTwoSegments(w);
    w.store.plant(replaySegmentKey(RUN, 'run_a.g0.99999'), Buffer.alloc(50));
    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    const held = await reopened.archive.describe(RUN);
    expect(held?.segments).toHaveLength(2);
    expect(held?.bytes).toBe(200 + 1000 + 1001);
  });

  it('an object that vanished under a retained state is reported, not hidden', async () => {
    /*
     * The one failure direction the write ordering is supposed to make
     * impossible, so meeting it means something outside this archive has been
     * at the bucket. A recording that quietly dropped the missing fragment
     * would be a different broadcast.
     */
    const w = await world();
    await recordTwoSegments(w);
    await w.archive.finalise(RUN);
    await w.store.delete(replaySegmentKey(RUN, segment(1).segmentId));

    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect(reopened.corrupt).toHaveLength(1);
    expect(reopened.corrupt[0]?.reason).toContain('not intact');
    expect(await reopened.archive.describe(RUN)).toBeNull();
  });

  it('an object of the wrong size under a retained state is reported too', async () => {
    const w = await world();
    await recordTwoSegments(w);
    await w.archive.finalise(RUN);
    w.store.plant(replaySegmentKey(RUN, segment(1).segmentId), Buffer.alloc(7));

    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect(reopened.corrupt[0]?.reason).toContain('bytes where');
  });

  it('a state document claiming another run is refused', async () => {
    const w = await world();
    await recordTwoSegments(w);
    const body = JSON.parse(currentState(w.store)) as Record<string, unknown>;
    (body['identity'] as Record<string, unknown>)['runId'] = 'somebody_else';
    // Planted under run_a's OWN prefix, so the disagreement is the only fault.
    for (const held of w.store.keys()) {
      if (held.startsWith(replayStatePrefix(RUN))) await w.store.delete(held);
    }
    w.store.plant(replayStateGenerationKey(RUN, 9), Buffer.from(JSON.stringify(body)));

    const reopened = await S3CompatibleReplayArchive.open({
      store: w.store,
      source: w.source,
      now: () => STARTED,
    });
    expect(reopened.corrupt[0]?.reason).toContain('different run');
  });
});

/* =================================================== keys and references */

describe('a reference is a key, never a locator', () => {
  it('carries no endpoint, bucket, credential or scheme', async () => {
    const w = await world();
    await recordTwoSegments(w);
    const held = await w.archive.describe(RUN);
    for (const reference of [
      ...held!.segments.map((entry) => entry.storageReference),
      ...held!.initialisations.map((entry) => entry.storageReference),
    ]) {
      expect(reference).not.toContain('://');
      expect(reference).not.toContain('http');
      expect(reference.startsWith('runs/')).toBe(true);
    }
  });

  it('the whole state document names no host, key material or spool path', async () => {
    const w = await world();
    await recordTwoSegments(w);
    const document = currentState(w.store);
    for (const forbidden of ['://', 'AKIA', 'secretAccessKey', 'amazonaws', 'localhost', 'bucket']) {
      expect(document, forbidden).not.toContain(forbidden);
    }
  });

  it('the key is derived from the identity, not from the offered reference', async () => {
    // The producer's spool path is recorded as offered metadata; where the
    // archive PUT it is decided here.
    const w = await world();
    await recordTwoSegments(w);
    expect(w.store.keys()).toContain(replaySegmentKey(RUN, segment(0).segmentId));
    expect(w.store.keys()).toContain(replayInitialisationKey(RUN, 0));
  });

  it('two runs never share a prefix', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN);
    await recordTwoSegments(w, 'run_b');
    const a = w.store.keys().filter((key) => key.startsWith(replaySegmentKey(RUN, '').slice(0, 20)));
    const b = w.store.keys().filter((key) => key.startsWith(replaySegmentKey('run_b', '').slice(0, 20)));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.some((key) => b.includes(key))).toBe(false);
  });
});

/* ============================================ maintenance over the store */

describe('the expiry worker over an object archive', () => {
  it('finds its candidates in the archive and releases the bytes', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN, { policy: 'expire', expiresAtMs: STARTED + DAY_MS });
    await w.archive.finalise(RUN);

    const report = await runReplayExpiryPass({
      archive: w.archive,
      candidates: w.archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(report.expired).toBe(1);
    expect(w.store.keys().some((key) => key.includes('/media/'))).toBe(false);
    expect((await w.archive.describe(RUN))?.status).toBe('expired');
  });

  it('a positive grace keeps the bytes and never the access', async () => {
    const w = await world();
    await recordTwoSegments(w, RUN, { policy: 'expire', expiresAtMs: STARTED + DAY_MS });
    await w.archive.finalise(RUN);

    const justAfter = STARTED + DAY_MS + 1;
    const report = await runReplayExpiryPass({
      archive: w.archive,
      candidates: w.archive,
      nowMs: justAfter,
      cleanupGraceMs: 7 * DAY_MS,
      limit: 10,
    });
    expect(report.expired).toBe(0);
    // The bytes are still there...
    expect(w.store.keys().some((key) => key.includes('/media/'))).toBe(true);
    // ...and nobody may watch them, which is the whole point.
    const held = await w.archive.describe(RUN);
    expect(planReplayPlayback(held!, justAfter).playable).toBe(false);
  });
});
