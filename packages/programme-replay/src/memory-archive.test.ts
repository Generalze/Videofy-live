/** @author masterzee001 */
/**
 * What a recording promises, pinned against an archive with no storage.
 *
 * Every rule here is about behaviour rather than bytes -- one run may not take
 * another run's media, a repeated segment may not be counted twice, nothing
 * may call itself available while material it needs is missing -- so none of
 * it needs a disk to be true. That is the point of pinning it now: the durable
 * implementation that follows has something to be judged against.
 */
import { describe, expect, it } from 'vitest';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import { InMemoryReplayArchive } from './memory-archive.js';
import { hasExpired } from './index.js';
import type { ReplayInitialisation } from './media.js';
import type { ReplayRetention } from './policy.js';
import type { ReplayRecord } from './archive.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const RUN_A: ProgrammeRunIdentity = {
  channelId: 'main',
  programmeId: 'evening-news',
  runId: 'run_a',
};
const RUN_B: ProgrammeRunIdentity = {
  channelId: 'main',
  programmeId: 'evening-news',
  runId: 'run_b',
};

/** A clock a test can move, as the lease suite does. */
function clock(start = STARTED): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

/** Two-second segments, as the live encoder produces them. */
function segment(
  index: number,
  overrides: Partial<ProgrammeMediaSegment> = {},
): ProgrammeMediaSegment {
  const start = index * 2000;
  return {
    runId: RUN_A.runId,
    segmentId: `${RUN_A.runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: start,
    endProgrammeTimeMs: start + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/${RUN_A.runId}/${start}.m4s`,
    bytes: 100_000,
    ...overrides,
  };
}

function initialisation(generation = 0, runId = RUN_A.runId): ReplayInitialisation {
  return {
    runId,
    generation,
    storageReference: `/spool/${runId}/init.${generation}.mp4`,
    bytes: 1_000,
  };
}

const KEEP: ReplayRetention = { policy: 'keep' };
const EXPIRE: ReplayRetention = { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS };

/** Open a recording that is expected to open, and hand back the archive. */
async function recording(
  retention: ReplayRetention = KEEP,
  now: () => number = () => STARTED,
): Promise<InMemoryReplayArchive> {
  const archive = new InMemoryReplayArchive(now);
  const begun = await archive.begin({
    identity: RUN_A,
    retention,
    visibility: 'private',
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
  return archive;
}

function statuses(record: ReplayRecord): readonly string[] {
  return record.history.map((change) => change.status);
}

/* ------------------------------------------------------------------- none */

describe('a programme configured to keep no replay keeps none', () => {
  it('refuses to open a recording at all, and says why', async () => {
    // Not "unknown" and not "failed": the operator chose this, and a caller
    // deciding whether to alert needs to be able to tell those apart.
    const archive = new InMemoryReplayArchive(() => STARTED);
    const begun = await archive.begin({
      identity: RUN_A,
      retention: { policy: 'none' },
      visibility: 'private',
      startedAtMs: STARTED,
    });
    expect(begun.ok).toBe(false);
    if (begun.ok) throw new Error('unreachable');
    expect(begun.failure.reason).toBe('policy-forbids-replay');
  });

  it('retains no media offered to it afterwards', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'none' },
      visibility: 'private',
      startedAtMs: STARTED,
    });

    const media = await archive.retainSegment(RUN_A.runId, segment(0));
    expect(media.ok).toBe(false);
    if (media.ok) throw new Error('unreachable');
    expect(media.failure.reason).toBe('policy-forbids-replay');

    const init = await archive.retainInitialisation(RUN_A.runId, initialisation());
    expect(init.ok).toBe(false);
    if (init.ok) throw new Error('unreachable');
    expect(init.failure.reason).toBe('policy-forbids-replay');
  });

  it('stays declined: a second policy cannot reopen the same broadcast', async () => {
    // Half a recording is a recording nobody asked for and nobody can reason
    // about. Changing what is kept is a decision for the next airing.
    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'none' },
      visibility: 'private',
      startedAtMs: STARTED,
    });

    const reopened = await archive.begin({
      identity: RUN_A,
      retention: KEEP,
      visibility: 'private',
      startedAtMs: STARTED + 1_000,
    });
    expect(reopened.ok).toBe(false);
    if (reopened.ok) throw new Error('unreachable');
    expect(reopened.failure.reason).toBe('policy-forbids-replay');
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });

  it('can never become available, because there is nothing to become it', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'none' },
      visibility: 'private',
      startedAtMs: STARTED,
    });

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('policy-forbids-replay');
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });
});

/* ------------------------------------------------------------------- keep */

describe('a programme configured to keep its replay keeps it', () => {
  it('accepts completed segments for its own run', async () => {
    const archive = await recording(KEEP);
    for (let i = 0; i < 3; i += 1) {
      const kept = await archive.retainSegment(RUN_A.runId, segment(i));
      expect(kept.ok).toBe(true);
      if (!kept.ok) throw new Error('unreachable');
      expect(kept.value.stored).toBe(true);
      expect(kept.value.segmentCount).toBe(i + 1);
    }

    const record = await archive.describe(RUN_A.runId);
    expect(record?.segments).toHaveLength(3);
    expect(record?.bytes).toBe(300_000);
  });

  it('has no expiry, and never expires however long it waits', async () => {
    const archive = await recording(KEEP);
    const record = await archive.describe(RUN_A.runId);
    expect(record?.expiresAtMs).toBeNull();
    if (record === null || record === undefined) throw new Error('unreachable');
    expect(hasExpired(record, STARTED + 10 * THIRTY_DAYS_MS)).toBe(false);

    // And the archive refuses to expire it, rather than obliging a caller that
    // asked for something the policy does not permit.
    const expired = await archive.expire(RUN_A.runId, STARTED + 10 * THIRTY_DAYS_MS);
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error('unreachable');
    expect(expired.failure.reason).toBe('lifecycle-transition-refused');
  });

  it('refuses a segment that cannot begin a playback', async () => {
    const archive = await recording(KEEP);
    const notKeyframed = await archive.retainSegment(
      RUN_A.runId,
      segment(0, { keyframeAligned: false }),
    );
    expect(notKeyframed.ok).toBe(false);
    if (notKeyframed.ok) throw new Error('unreachable');
    expect(notKeyframed.failure.reason).toBe('segment-invalid');

    const empty = await archive.retainSegment(
      RUN_A.runId,
      segment(0, { endProgrammeTimeMs: 0 }),
    );
    expect(empty.ok).toBe(false);
  });
});

/* ----------------------------------------------------------------- expire */

describe('a programme configured to expire records the exact instant', () => {
  it('pins the expiry it was given, to the millisecond', async () => {
    const archive = await recording(EXPIRE);
    const record = await archive.describe(RUN_A.runId);
    expect(record?.expiresAtMs).toBe(STARTED + THIRTY_DAYS_MS);
    expect(record?.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS });
  });

  it('accepts segments before finalisation like any other kept replay', async () => {
    const archive = await recording(EXPIRE);
    const kept = await archive.retainSegment(RUN_A.runId, segment(0));
    expect(kept.ok).toBe(true);
  });

  it('refuses to open with an expiry that is not in the future', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    const begun = await archive.begin({
      identity: RUN_A,
      retention: { policy: 'expire', expiresAtMs: STARTED - 1 },
      visibility: 'private',
      startedAtMs: STARTED,
    });
    expect(begun.ok).toBe(false);
    if (begun.ok) throw new Error('unreachable');
    expect(begun.failure.reason).toBe('retention-configuration-invalid');
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });

  it('is not expired until the instant arrives, and then is', async () => {
    const time = clock();
    const archive = await recording(EXPIRE, time.now);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    const before = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS - 1);
    expect(before.ok).toBe(false);

    time.advance(THIRTY_DAYS_MS);
    const after = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('unreachable');
    expect(after.value.status).toBe('expired');
    // The material is gone with it.
    expect(after.value.segments).toEqual([]);
    expect(after.value.bytes).toBe(0);
  });

  it('succeeds as a no-op when the recording has already expired', async () => {
    const archive = await recording(EXPIRE);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);

    const again = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.value.status).toBe('expired');
  });

  it('tolerates a retry that arrives carrying a different clock', async () => {
    // An at-least-once worker re-reading its queue need not reproduce the
    // instant it used the first time. The expiry it already honoured stands.
    const archive = await recording(EXPIRE);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);

    const again = await archive.expire(RUN_A.runId, STARTED);
    expect(again.ok).toBe(true);
  });

  it('writes no second transition when an expiry is retried', async () => {
    const time = clock();
    const archive = await recording(EXPIRE, time.now);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    time.advance(THIRTY_DAYS_MS);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    const afterFirst = await archive.describe(RUN_A.runId);

    time.advance(60_000);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    const afterRetries = await archive.describe(RUN_A.runId);

    expect(statuses(afterRetries as ReplayRecord)).toEqual([
      'recording',
      'processing',
      'available',
      'expired',
    ]);
    expect(afterRetries?.history).toEqual(afterFirst?.history);
  });

  it('still refuses to delete-then-expire, and to expire what was deleted', async () => {
    // Retry-safety absorbs a repeat of the SAME instruction. It does not make
    // a terminal state permeable to a different one.
    const archive = await recording(EXPIRE);
    await archive.delete(RUN_A.runId);
    const expired = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error('unreachable');
    expect(expired.failure.reason).toBe('lifecycle-transition-refused');
    expect((await archive.describe(RUN_A.runId))?.status).toBe('deleted');
  });
});

/* ---------------------------------------------------------- run isolation */

describe('media belongs to the run that produced it', () => {
  it('refuses a segment belonging to another run, without reassigning it', async () => {
    const archive = await recording(KEEP);
    const foreign = segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' });

    const offered = await archive.retainSegment(RUN_A.runId, foreign);
    expect(offered.ok).toBe(false);
    if (offered.ok) throw new Error('unreachable');
    expect(offered.failure.reason).toBe('run-mismatch');

    // Nothing was silently rewritten into this recording.
    const record = await archive.describe(RUN_A.runId);
    expect(record?.segments).toEqual([]);
  });

  it('refuses initialisation material belonging to another run', async () => {
    const archive = await recording(KEEP);
    const offered = await archive.retainInitialisation(
      RUN_A.runId,
      initialisation(0, RUN_B.runId),
    );
    expect(offered.ok).toBe(false);
    if (offered.ok) throw new Error('unreachable');
    expect(offered.failure.reason).toBe('run-mismatch');
  });

  it('keeps two airings of one programme entirely apart', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN_A,
      retention: KEEP,
      visibility: 'private',
      startedAtMs: STARTED,
    });
    await archive.begin({
      identity: RUN_B,
      retention: KEEP,
      visibility: 'private',
      startedAtMs: STARTED,
    });

    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.retainSegment(
      RUN_B.runId,
      segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' }),
    );

    const a = await archive.describe(RUN_A.runId);
    const b = await archive.describe(RUN_B.runId);
    expect(a?.segments.map((s) => s.segmentId)).toEqual(['run_a.g0.00000']);
    expect(b?.segments.map((s) => s.segmentId)).toEqual(['run_b.g0.00000']);
  });
});

/* ------------------------------------------------------------ idempotence */

describe('the same notification twice changes nothing', () => {
  it('does not duplicate a segment or double-count its bytes', async () => {
    // A playlist re-read, or a recovery that replayed a journal it had already
    // replayed. Both happen; neither may be visible in the result.
    const archive = await recording(KEEP);
    const first = await archive.retainSegment(RUN_A.runId, segment(0));
    const second = await archive.retainSegment(RUN_A.runId, segment(0));

    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.value.stored).toBe(true);
    expect(second.value.stored).toBe(false);
    expect(second.value.segmentCount).toBe(1);
    expect(second.value.bytes).toBe(first.value.bytes);

    const record = await archive.describe(RUN_A.runId);
    expect(record?.segments).toHaveLength(1);
    expect(record?.bytes).toBe(100_000);
  });

  it('does not duplicate an initialisation generation', async () => {
    const archive = await recording(KEEP);
    const first = await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    const second = await archive.retainInitialisation(RUN_A.runId, initialisation(0));

    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.value.stored).toBe(true);
    expect(second.value.stored).toBe(false);
    expect(second.value.initialisationCount).toBe(1);
    expect(second.value.bytes).toBe(first.value.bytes);
  });

  it('reports a duplicate as an ordinary result, not a failure', async () => {
    // A caller on the live path must not have to treat a re-read as an error.
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const again = await archive.retainSegment(RUN_A.runId, segment(0));
    expect(again.ok).toBe(true);
  });

  it('treats an absent init generation and generation zero as the same fact', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const again = await archive.retainSegment(RUN_A.runId, segment(0, { initGeneration: 0 }));
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.value.stored).toBe(false);
    expect(again.value.segmentCount).toBe(1);
  });
});

/* -------------------------------------------------------------- conflicts */

describe('the same identity describing different media is a conflict', () => {
  it('refuses a segment id re-offered against a different storage object', async () => {
    // Two producers disagreeing about what a segment id MEANS. Letting the
    // first arrival win would settle that silently, and the result is a
    // recording that is valid segment by segment and wrong as a whole.
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));

    const conflicting = await archive.retainSegment(
      RUN_A.runId,
      segment(0, { storageReference: '/spool/run_a/somewhere-else.m4s' }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('segment-conflict');
    expect(conflicting.failure.detail).toContain('storageReference');
  });

  it('refuses a segment id re-offered with a different byte count', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const conflicting = await archive.retainSegment(RUN_A.runId, segment(0, { bytes: 999 }));
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('segment-conflict');
  });

  it('refuses a segment id re-offered over a different stretch of programme time', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const conflicting = await archive.retainSegment(
      RUN_A.runId,
      segment(0, { endProgrammeTimeMs: 9_000 }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('segment-conflict');
    expect(conflicting.failure.detail).toContain('endProgrammeTimeMs');
  });

  it('refuses a segment id re-offered against a different init generation', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0, { initGeneration: 0 }));
    const conflicting = await archive.retainSegment(
      RUN_A.runId,
      segment(0, { initGeneration: 1 }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('segment-conflict');
  });

  it('keeps the material it already had when it refuses a conflict', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.retainSegment(RUN_A.runId, segment(0, { bytes: 999 }));

    const record = await archive.describe(RUN_A.runId);
    expect(record?.segments).toHaveLength(1);
    expect(record?.segments[0]?.bytes).toBe(100_000);
    expect(record?.bytes).toBe(100_000);
  });

  it('refuses an init generation re-offered against a different object', async () => {
    // One of the two decodes the fragments this recording kept and the other
    // does not, and nothing later can work out which.
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(2));
    const conflicting = await archive.retainInitialisation(RUN_A.runId, {
      runId: RUN_A.runId,
      generation: 2,
      storageReference: '/spool/run_a/init.2.rebuilt.mp4',
      bytes: 1_000,
    });

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('initialisation-conflict');
    expect(conflicting.failure.detail).toContain('storageReference');
  });

  it('refuses an init generation re-offered with a different size', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    const conflicting = await archive.retainInitialisation(RUN_A.runId, {
      runId: RUN_A.runId,
      generation: 0,
      storageReference: `/spool/${RUN_A.runId}/init.0.mp4`,
      bytes: 2_048,
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('initialisation-conflict');
  });

  it('keeps the generation it already had when it refuses a conflict', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainInitialisation(RUN_A.runId, {
      runId: RUN_A.runId,
      generation: 0,
      storageReference: '/spool/run_a/elsewhere.mp4',
      bytes: 1_000,
    });

    const record = await archive.describe(RUN_A.runId);
    expect(record?.initialisations).toHaveLength(1);
    expect(record?.initialisations[0]?.storageReference).toBe(
      `/spool/${RUN_A.runId}/init.0.mp4`,
    );
  });

  it('separates a conflict from a segment that was never fit to keep', async () => {
    // Different faults, different actions: one is an encoder producing
    // something unplayable, the other is two producers disagreeing.
    const archive = await recording(KEEP);
    const unfit = await archive.retainSegment(
      RUN_A.runId,
      segment(5, { keyframeAligned: false }),
    );
    if (unfit.ok) throw new Error('unreachable');
    expect(unfit.failure.reason).toBe('segment-invalid');
  });
});

/* ------------------------------------------------- initialisation material */

describe('a replay knows what it needs to be decodable', () => {
  it('supports fragments from more than one encoder generation', async () => {
    // An encoder restart mid-broadcast leaves fragments written against two
    // configurations. A replay that kept only one of them is half a programme.
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainInitialisation(RUN_A.runId, initialisation(1));
    await archive.retainSegment(RUN_A.runId, segment(0, { initGeneration: 0 }));
    await archive.retainSegment(
      RUN_A.runId,
      segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
    );

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(true);
    if (!finalised.ok) throw new Error('unreachable');
    expect(finalised.value.status).toBe('available');
    expect(finalised.value.initialisations.map((i) => i.generation)).toEqual([0, 1]);
  });

  it('treats a segment with no stated generation as the first', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(true);
  });

  it('refuses to become available when a needed generation was never kept', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0, { initGeneration: 0 }));
    // Generation 1 fragments were kept; generation 1 initialisation was not.
    await archive.retainSegment(
      RUN_A.runId,
      segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
    );

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('initialisation-missing');
    // The detail names the generation, so an operator is not left guessing.
    expect(finalised.failure.detail).toContain('1');

    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('failed');
    expect(record?.status).not.toBe('available');
    expect(record?.failure?.reason).toBe('initialisation-missing');
  });
});

/* ---------------------------------------------------------- finalisation */

describe('a recording becomes available only by being finalised', () => {
  it('walks recording, processing, available, in that order', async () => {
    const time = clock();
    const archive = await recording(KEEP, time.now);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));

    time.advance(60_000);
    const finalised = await archive.finalise(RUN_A.runId);
    if (!finalised.ok) throw new Error('unreachable');
    expect(finalised.value.status).toBe('available');
    expect(statuses(finalised.value)).toEqual(['recording', 'processing', 'available']);
    expect(finalised.value.finalisedAtMs).toBe(STARTED + 60_000);
  });

  it('is not available while it is still recording', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('recording');
    expect(record?.finalisedAtMs).toBeNull();
  });

  it('fails rather than publishing a recording that retained nothing', async () => {
    const archive = await recording(KEEP);
    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('no-media-retained');

    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('failed');
    expect(statuses(record as ReplayRecord)).toEqual(['recording', 'processing', 'failed']);
  });

  it('refuses to finalise twice', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    const again = await archive.finalise(RUN_A.runId);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.reason).toBe('lifecycle-transition-refused');
  });

  it('stops accepting media once the broadcast is finalised', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    const late = await archive.retainSegment(RUN_A.runId, segment(1));
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error('unreachable');
    expect(late.failure.reason).toBe('lifecycle-transition-refused');
  });

  it('refuses to finalise a run it never began', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    const finalised = await archive.finalise('run_nobody');
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('unknown-replay');
  });

  it('refuses to begin when the policy could not be resolved', async () => {
    // This package invents no default. An absent policy is a configuration
    // failure the caller has to hear about, not a quiet fall back to `none`,
    // which would be indistinguishable from a deliberate choice.
    const archive = new InMemoryReplayArchive(() => STARTED);
    const begun = await archive.begin({
      identity: RUN_A,
      retention: { policy: undefined } as unknown as ReplayRetention,
      visibility: 'private',
      startedAtMs: STARTED,
    });

    expect(begun.ok).toBe(false);
    if (begun.ok) throw new Error('unreachable');
    expect(begun.failure.reason).toBe('retention-configuration-invalid');
    // And nothing was opened, nor was the run marked as deliberately declined.
    expect(await archive.describe(RUN_A.runId)).toBeNull();

    const retried = await archive.begin({
      identity: RUN_A,
      retention: KEEP,
      visibility: 'private',
      startedAtMs: STARTED,
    });
    expect(retried.ok).toBe(true);
  });

  it('refuses to begin the same run twice', async () => {
    const archive = await recording(KEEP);
    const again = await archive.begin({
      identity: RUN_A,
      retention: KEEP,
      visibility: 'private',
      startedAtMs: STARTED,
    });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.reason).toBe('lifecycle-transition-refused');
  });
});

/* ---------------------------------------------------------------- failure */

describe('a recording that cannot be made says so', () => {
  it('records an explicit failure with the reason it was given', async () => {
    const archive = await recording(KEEP);
    const failed = await archive.fail(
      RUN_A.runId,
      'archive-unavailable',
      'the spool volume could not be read',
    );

    // Recording the failure SUCCEEDED, which is a different thing from the
    // recording succeeding.
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error('unreachable');
    expect(failed.value.status).toBe('failed');
    expect(failed.value.failure?.reason).toBe('archive-unavailable');
    expect(failed.value.failure?.detail).toContain('spool volume');
  });

  it('never lets a failed recording claim it is available', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.fail(RUN_A.runId, 'archive-unavailable', 'the volume went away');

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('lifecycle-transition-refused');

    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('failed');
  });

  it('refuses to fail a recording that has already been deleted', async () => {
    const archive = await recording(KEEP);
    await archive.delete(RUN_A.runId);
    const failed = await archive.fail(RUN_A.runId, 'archive-unavailable', 'too late');
    expect(failed.ok).toBe(false);
  });
});

/* ----------------------------------------------------------------- delete */

describe('deleting a recording removes it', () => {
  it('moves it to deleted and takes its media out of reach', async () => {
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    const deleted = await archive.delete(RUN_A.runId);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error('unreachable');
    expect(deleted.value.status).toBe('deleted');
    expect(deleted.value.segments).toEqual([]);
    expect(deleted.value.initialisations).toEqual([]);
    expect(deleted.value.bytes).toBe(0);

    const record = await archive.describe(RUN_A.runId);
    expect(record?.segments).toEqual([]);
  });

  it('succeeds as a no-op when the recording is already deleted', async () => {
    // A cleanup worker can remove an object and die before recording that it
    // did. The next pass repeats the instruction, and "make sure this is gone"
    // is already satisfied -- which is a success, not an incident.
    const archive = await recording(KEEP);
    const first = await archive.delete(RUN_A.runId);
    expect(first.ok).toBe(true);

    const second = await archive.delete(RUN_A.runId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value.status).toBe('deleted');
    expect(second.value.segments).toEqual([]);
    expect(second.value.bytes).toBe(0);
  });

  it('writes no second transition when a delete is retried', async () => {
    const time = clock();
    const archive = await recording(KEEP, time.now);
    await archive.delete(RUN_A.runId);
    const afterFirst = await archive.describe(RUN_A.runId);

    time.advance(60_000);
    await archive.delete(RUN_A.runId);
    await archive.delete(RUN_A.runId);
    const afterRetries = await archive.describe(RUN_A.runId);

    expect(statuses(afterRetries as ReplayRecord)).toEqual(['recording', 'deleted']);
    expect(afterRetries?.history).toEqual(afterFirst?.history);
  });

  it('never lets a deleted recording become available', async () => {
    // The case that matters: a finaliser already in flight when the delete
    // landed.
    const archive = await recording(KEEP);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.delete(RUN_A.runId);

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('lifecycle-transition-refused');

    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('deleted');
    expect(record?.status).not.toBe('available');
  });

  it('never lets a deleted recording take more media', async () => {
    const archive = await recording(KEEP);
    await archive.delete(RUN_A.runId);
    const late = await archive.retainSegment(RUN_A.runId, segment(0));
    expect(late.ok).toBe(false);
  });

  it('refuses to delete a run it never began', async () => {
    const archive = new InMemoryReplayArchive(() => STARTED);
    const deleted = await archive.delete('run_nobody');
    expect(deleted.ok).toBe(false);
    if (deleted.ok) throw new Error('unreachable');
    expect(deleted.failure.reason).toBe('unknown-replay');
  });
});

/* -------------------------------------------------- terminal, and staying so */

describe('a recording that has ended stays ended', () => {
  it('will not take media again after expiring', async () => {
    const archive = await recording(EXPIRE);
    await archive.retainInitialisation(RUN_A.runId, initialisation());
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);

    const late = await archive.retainSegment(RUN_A.runId, segment(1));
    expect(late.ok).toBe(false);
    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);

    const record = await archive.describe(RUN_A.runId);
    expect(record?.status).toBe('expired');
  });

  it('hands out a copy, so a caller cannot edit the archive by holding it', async () => {
    const archive = await recording(KEEP);
    await archive.retainSegment(RUN_A.runId, segment(0));
    const record = await archive.describe(RUN_A.runId);
    if (record === null) throw new Error('unreachable');

    (record.segments as ProgrammeMediaSegment[]).length = 0;
    const again = await archive.describe(RUN_A.runId);
    expect(again?.segments).toHaveLength(1);
  });
});
