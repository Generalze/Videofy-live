/** @author masterzee001 */
/**
 * The caretaker, and the four things it must never become.
 *
 *   IT MUST NEVER BE WHAT ENFORCES ACCESS. A pass that never runs, or runs and
 *   fails, must not extend anybody's ability to watch by a millisecond. That is
 *   `planReplayPlayback`'s job and it is proven there; what is proven here is
 *   the other half -- that this releases BYTES and touches nothing else.
 *
 *   IT MUST NEVER DEPEND ON THE CATALOGUE FOR TRUTH. A history projection being
 *   stale or down cannot keep expired media alive, because that would turn
 *   "kept for thirty days" into "until the catalogue is healthy".
 *
 *   ONE RUN'S FAILURE MUST NEVER STOP THE BATCH. A single corrupt recording
 *   halting maintenance would hold every other recording past its retention:
 *   one broken thing becoming an estate-wide breach of the same promise.
 *
 *   IT MUST NEVER DESTROY A LIVE BROADCAST because a queued request arrived.
 */
import { describe, expect, it } from 'vitest';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import { InMemoryReplayArchive } from './memory-archive.js';
import type { ProgrammeReplayArchive, ReplayRecord } from './archive.js';
import {
  readyToRelease,
  runReplayDeletionPass,
  runReplayExpiryPass,
  type ReplayDeletionQueue,
  type ReplayDeletionRequest,
  type ReplayDeletionSettlement,
  type ReplayLifecycleCandidate,
  type ReplayLifecycleCandidateSource,
} from './lifecycle-worker.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function identity(runId: string) {
  return { channelId: 'ch_1', programmeId: 'prog_1', runId };
}

function segment(runId: string, index = 0): ProgrammeMediaSegment {
  return {
    runId,
    segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: index * 2000,
    endProgrammeTimeMs: index * 2000 + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/${runId}/${index}.m4s`,
    bytes: 1000,
  };
}

/** A finished, expiring recording, ready to be swept. */
async function expiringRun(
  archive: InMemoryReplayArchive,
  runId: string,
  expiresAtMs: number,
): Promise<void> {
  await archive.begin({
    identity: identity(runId),
    retention: { policy: 'expire', expiresAtMs },
    visibility: 'public',
    startedAtMs: STARTED,
  });
  await archive.retainInitialisation(runId, {
    runId,
    generation: 0,
    storageReference: `/spool/${runId}/init.mp4`,
    bytes: 100,
  });
  await archive.retainSegment(runId, segment(runId));
  const finalised = await archive.finalise(runId);
  if (!finalised.ok) throw new Error(`could not finalise: ${finalised.failure.detail}`);
}

async function keepRun(archive: InMemoryReplayArchive, runId: string): Promise<void> {
  await archive.begin({
    identity: identity(runId),
    retention: { policy: 'keep' },
    visibility: 'public',
    startedAtMs: STARTED,
  });
  await archive.retainInitialisation(runId, {
    runId,
    generation: 0,
    storageReference: `/spool/${runId}/init.mp4`,
    bytes: 100,
  });
  await archive.retainSegment(runId, segment(runId));
  await archive.finalise(runId);
}

/* ============================================================ the grace */

describe('the grace period is explicit, and it is not the audience cutoff', () => {
  const retention = { policy: 'expire', expiresAtMs: STARTED + 30 * DAY_MS } as const;

  it('zero grace releases at the expiry instant', () => {
    expect(readyToRelease(retention, retention.expiresAtMs - 1, 0)).toBe(false);
    expect(readyToRelease(retention, retention.expiresAtMs, 0)).toBe(true);
  });

  it('a positive grace holds the bytes longer, and only the bytes', () => {
    /*
     * THE DISTINCTION THAT MAKES A GRACE PERIOD SAFE. The logical cutoff --
     * enforced per request, by the clock, in `planReplayPlayback` -- has
     * already refused everybody by the time this returns false. What the grace
     * buys is RECOVERABILITY: a recording released by a policy typo can still
     * be fetched back out of the store. It never buys access.
     */
    const grace = 7 * DAY_MS;
    expect(readyToRelease(retention, retention.expiresAtMs, grace)).toBe(false);
    expect(readyToRelease(retention, retention.expiresAtMs + grace - 1, grace)).toBe(false);
    expect(readyToRelease(retention, retention.expiresAtMs + grace, grace)).toBe(true);
  });

  it('never releases a keep retention, whatever the grace', () => {
    expect(readyToRelease({ policy: 'keep' }, STARTED + 1_000 * DAY_MS, 0)).toBe(false);
  });

  it('the pass refuses a grace that is not a usable number, and touches nothing', async () => {
    // A composition mistake. Running with a silently corrected value would
    // release bytes against a rule nobody wrote.
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    for (const cleanupGraceMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = await runReplayExpiryPass({
        archive,
        candidates: archive,
        nowMs: STARTED + 30 * DAY_MS,
        cleanupGraceMs,
        limit: 10,
      });
      expect(report.refusal, String(cleanupGraceMs)).not.toBeNull();
      expect(report.examined).toBe(0);
    }
    expect((await archive.describe('run_a'))?.status).toBe('available');
  });

  it('the pass refuses an unusable limit too', async () => {
    const archive = new InMemoryReplayArchive();
    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      nowMs: STARTED,
      cleanupGraceMs: 0,
      limit: 0,
    });
    expect(report.refusal).toContain('limit');
  });
});

/* ========================================================== expiry pass */

describe('a bounded, retry-safe expiry pass', () => {
  it('expires what is due and leaves what is not', async () => {
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_due', STARTED + DAY_MS);
    await expiringRun(archive, 'run_later', STARTED + 90 * DAY_MS);
    await keepRun(archive, 'run_kept');

    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });

    expect(report.refusal).toBeNull();
    expect(report.expired).toBe(1);
    expect((await archive.describe('run_due'))?.status).toBe('expired');
    expect((await archive.describe('run_later'))?.status).toBe('available');
    expect((await archive.describe('run_kept'))?.status).toBe('available');
  });

  it('running it twice is indistinguishable from running it once', async () => {
    /*
     * THE ONLY SHAPE THAT MAKES A SCHEDULED JOB SAFE TO RESTART. A pass that
     * died halfway and was run again must not raise an incident about work that
     * is already done.
     */
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    const options = {
      archive,
      candidates: archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    };
    const first = await runReplayExpiryPass(options);
    const second = await runReplayExpiryPass(options);
    expect(first.expired).toBe(1);
    expect(second.expired + second.failed).toBe(0);
    const after = await archive.describe('run_a');
    expect(after?.status).toBe('expired');
    expect(after?.history.filter((entry) => entry.status === 'expired')).toHaveLength(1);
  });

  it('honours the bound rather than sweeping the whole estate at once', async () => {
    const archive = new InMemoryReplayArchive();
    for (let index = 0; index < 5; index += 1) {
      await expiringRun(archive, `run_${index}`, STARTED + DAY_MS);
    }
    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 2,
    });
    expect(report.examined).toBe(2);
    expect(report.expired).toBe(2);
  });

  it('re-reads every candidate before acting on it', async () => {
    /*
     * The scan is a hint; the record is the truth. A source that names a run
     * which has since been deleted, or was never eligible, must produce a skip
     * rather than an argument with the archive.
     */
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_kept');
    const lying: ReplayLifecycleCandidateSource = {
      async dueForExpiry() {
        return [
          {
            runId: 'run_kept',
            status: 'available',
            retention: { policy: 'expire', expiresAtMs: 0 },
            expiresAtMs: 0,
          },
          {
            runId: 'run_never_existed',
            status: 'available',
            retention: { policy: 'expire', expiresAtMs: 0 },
            expiresAtMs: 0,
          },
        ] satisfies ReplayLifecycleCandidate[];
      },
    };
    const report = await runReplayExpiryPass({
      archive,
      candidates: lying,
      nowMs: STARTED + 90 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(report.expired).toBe(0);
    expect(report.skipped).toBe(2);
    expect((await archive.describe('run_kept'))?.status).toBe('available');
  });

  it('one run failing does not stop the batch', async () => {
    /*
     * A SINGLE CORRUPT RECORDING HALTING MAINTENANCE would hold every other
     * recording on the box past its retention. One broken thing must not become
     * an estate-wide breach of the same promise.
     */
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    await expiringRun(archive, 'run_b', STARTED + DAY_MS);
    await expiringRun(archive, 'run_c', STARTED + DAY_MS);

    const exploding: ProgrammeReplayArchive = {
      ...archive,
      describe: (runId) => archive.describe(runId),
      expire: async (runId, nowMs) => {
        if (runId === 'run_b') throw new Error('this run is on fire');
        return archive.expire(runId, nowMs);
      },
      delete: (runId) => archive.delete(runId),
    } as ProgrammeReplayArchive;

    const report = await runReplayExpiryPass({
      archive: exploding,
      candidates: archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(report.expired).toBe(2);
    expect(report.failed).toBe(1);
    expect((await archive.describe('run_a'))?.status).toBe('expired');
    expect((await archive.describe('run_c'))?.status).toBe('expired');
    expect((await archive.describe('run_b'))?.status).toBe('available');
  });

  it("a caller's throwing logger does not abandon the rest of the batch", async () => {
    /*
     * `onEntry` IS SOMEBODY ELSE'S FUNCTION -- a metric, a log line, a
     * notification. A throwing one must not abandon every remaining run and
     * hold them all past their retention, which is the same estate-wide failure
     * as a single corrupt recording halting the sweep.
     */
    const archive = new InMemoryReplayArchive();
    for (const runId of ['run_a', 'run_b', 'run_c']) {
      await expiringRun(archive, runId, STARTED + DAY_MS);
    }
    const seen: string[] = [];
    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
      onEntry: (entry) => {
        seen.push(entry.runId);
        throw new Error('the metrics sink is down');
      },
    });
    expect(report.expired).toBe(3);
    expect(seen).toHaveLength(3);
    for (const runId of ['run_a', 'run_b', 'run_c']) {
      expect((await archive.describe(runId))?.status, runId).toBe('expired');
    }
  });

  it('a scan that cannot run is a refusal, not a pile of failures', async () => {
    // Nothing was attempted, so nothing is reported as failed: a pass claiming
    // N failures because it could not list anything would describe work it
    // never did.
    const archive = new InMemoryReplayArchive();
    const report = await runReplayExpiryPass({
      archive,
      candidates: {
        async dueForExpiry() {
          throw new Error('the store is unreachable');
        },
      },
      nowMs: STARTED,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(report.refusal).toContain('could not be scanned');
    expect(report.failed).toBe(0);
    expect(report.examined).toBe(0);
  });
});

/* ================================================= the catalogue is a lag */

describe('the catalogue is a projection and never the source of expiry truth', () => {
  it('expires media even when the catalogue is completely unavailable', async () => {
    /*
     * THE FAILURE THIS FORBIDS. If expiry were driven from, or gated on, the
     * airing catalogue, an outage there would keep expired media alive
     * indefinitely -- retention silently becoming "until the catalogue is
     * healthy", which is the one thing a retention promise may not mean.
     */
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);

    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      catalogue: {
        async sync() {
          throw new Error('the catalogue is down');
        },
      },
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });

    expect(report.expired).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.catalogueLagged).toBe(1);
    expect((await archive.describe('run_a'))?.status).toBe('expired');
  });

  it('records the lag as diagnostic rather than as a failed expiry', async () => {
    // Reporting it as a failure would invite somebody to retry an operation
    // that already succeeded, and would raise an incident about bookkeeping.
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    const report = await runReplayExpiryPass({
      archive,
      candidates: archive,
      catalogue: {
        async sync() {
          throw new Error('nope');
        },
      },
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    const entry = report.entries[0];
    expect(entry?.outcome).toBe('expired');
    expect(entry?.catalogueSynced).toBe(false);
  });

  it('syncs the resulting record, not the one it started from', async () => {
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    const synced: ReplayRecord[] = [];
    await runReplayExpiryPass({
      archive,
      candidates: archive,
      catalogue: {
        async sync(record) {
          synced.push(record);
        },
      },
      nowMs: STARTED + 2 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(synced).toHaveLength(1);
    expect(synced[0]?.status).toBe('expired');
  });
});

/* ======================================================== deletion work */

describe('deletion requests', () => {
  function queue(requests: ReplayDeletionRequest[]) {
    const settled: { requestId: string; settlement: ReplayDeletionSettlement; detail: string }[] = [];
    const port: ReplayDeletionQueue = {
      async claim(limit) {
        return requests.slice(0, limit);
      },
      async settle(requestId, settlement, detail) {
        settled.push({ requestId, settlement, detail });
      },
    };
    return { port, settled };
  }

  const request = (runId: string, requestId = `req_${runId}`): ReplayDeletionRequest => ({
    requestId,
    runId,
    requestedAtMs: STARTED,
    attempts: 0,
  });

  it('removes a finished recording and settles the request', async () => {
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_a');
    const { port, settled } = queue([request('run_a')]);

    const report = await runReplayDeletionPass({
      archive,
      queue: port,
      nowMs: STARTED + DAY_MS,
      limit: 10,
    });
    expect(report.done).toBe(1);
    expect(settled[0]?.settlement).toBe('done');
    expect((await archive.describe('run_a'))?.status).toBe('deleted');
  });

  it('is retry-safe: the second request for the same run is a no-op success', async () => {
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_a');
    const options = { archive, nowMs: STARTED + DAY_MS, limit: 10 };
    await runReplayDeletionPass({ ...options, queue: queue([request('run_a')]).port });
    const second = await runReplayDeletionPass({
      ...options,
      queue: queue([request('run_a', 'req_again')]).port,
    });
    expect(second.done).toBe(1);
    const after = await archive.describe('run_a');
    expect(after?.status).toBe('deleted');
    expect(after?.history.filter((entry) => entry.status === 'deleted')).toHaveLength(1);
  });

  it('a run the archive never had is success, not an error', async () => {
    // The instruction is "make sure this is gone", and it is.
    const archive = new InMemoryReplayArchive();
    const { port, settled } = queue([request('run_unknown')]);
    const report = await runReplayDeletionPass({ archive, queue: port, nowMs: STARTED, limit: 10 });
    expect(report.done).toBe(1);
    expect(settled[0]?.settlement).toBe('done');
  });

  it('an already-expired recording is deleted, per the frozen lifecycle', async () => {
    const archive = new InMemoryReplayArchive();
    await expiringRun(archive, 'run_a', STARTED + DAY_MS);
    await archive.expire('run_a', STARTED + 2 * DAY_MS);
    const { port } = queue([request('run_a')]);
    const report = await runReplayDeletionPass({
      archive,
      queue: port,
      nowMs: STARTED + 3 * DAY_MS,
      limit: 10,
    });
    expect(report.done).toBe(1);
    expect((await archive.describe('run_a'))?.status).toBe('deleted');
  });

  it('DEFERS a broadcast that is still recording rather than destroying it', async () => {
    /*
     * THE ONE THIS SECTION EXISTS FOR. The request may predate this run going
     * back on air, or arrive while finalisation is in flight. A background
     * queue is the last thing that should reach into either -- and the damage
     * would be a live programme losing its recording mid-broadcast.
     */
    const archive = new InMemoryReplayArchive();
    await archive.begin({
      identity: identity('run_live'),
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    await archive.retainSegment('run_live', segment('run_live'));

    const { port, settled } = queue([request('run_live')]);
    const report = await runReplayDeletionPass({
      archive,
      queue: port,
      nowMs: STARTED + 1000,
      limit: 10,
    });

    expect(report.deferred).toBe(1);
    expect(report.done).toBe(0);
    expect(settled[0]?.settlement).toBe('defer');
    const still = await archive.describe('run_live');
    expect(still?.status).toBe('recording');
    expect(still?.segments).toHaveLength(1);
  });

  it('one bad request does not stop the others', async () => {
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_a');
    await keepRun(archive, 'run_c');
    const exploding = {
      ...archive,
      describe: (runId: string) => archive.describe(runId),
      delete: async (runId: string) => {
        if (runId === 'run_b') throw new Error('this one is on fire');
        return archive.delete(runId);
      },
    } as unknown as ProgrammeReplayArchive;
    await keepRun(archive, 'run_b');

    const { port, settled } = queue([request('run_a'), request('run_b'), request('run_c')]);
    const report = await runReplayDeletionPass({
      archive: exploding,
      queue: port,
      nowMs: STARTED + DAY_MS,
      limit: 10,
    });
    expect(report.done).toBe(2);
    expect(report.retried).toBe(1);
    expect(settled).toHaveLength(3);
    expect((await archive.describe('run_a'))?.status).toBe('deleted');
    expect((await archive.describe('run_c'))?.status).toBe('deleted');
  });

  it('a claim that cannot be made is a refusal, not an empty batch', async () => {
    const archive = new InMemoryReplayArchive();
    const report = await runReplayDeletionPass({
      archive,
      queue: {
        async claim() {
          throw new Error('the queue is unreachable');
        },
        async settle() {
          /* not reached */
        },
      },
      nowMs: STARTED,
      limit: 10,
    });
    expect(report.refusal).toContain('could not be claimed');
    expect(report.claimed).toBe(0);
  });

  it('a settle that fails leaves the work done and the request reclaimable', async () => {
    // `delete` is retry-safe, so the next pass settles correctly against a
    // recording that is already gone.
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_a');
    const report = await runReplayDeletionPass({
      archive,
      queue: {
        async claim() {
          return [request('run_a')];
        },
        async settle() {
          throw new Error('the queue is unreachable');
        },
      },
      nowMs: STARTED + DAY_MS,
      limit: 10,
    });
    expect(report.done).toBe(1);
    expect((await archive.describe('run_a'))?.status).toBe('deleted');
  });

  it('the catalogue being down does not undo a deletion', async () => {
    const archive = new InMemoryReplayArchive();
    await keepRun(archive, 'run_a');
    const report = await runReplayDeletionPass({
      archive,
      queue: queue([request('run_a')]).port,
      catalogue: {
        async sync() {
          throw new Error('down');
        },
      },
      nowMs: STARTED + DAY_MS,
      limit: 10,
    });
    expect(report.done).toBe(1);
    expect(report.catalogueLagged).toBe(1);
    expect((await archive.describe('run_a'))?.status).toBe('deleted');
  });
});
