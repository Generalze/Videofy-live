/** @author masterzee001 */
/**
 * History is not the recording, and the recording is not permission.
 *
 * Two properties under test throughout:
 *
 *   A PROGRAMME THAT AIRED STAYS AIRED. Whatever happens to its media --
 *   never kept, expired, deleted, failed -- the fact that it happened is not
 *   editable by a retention policy.
 *
 *   A PROJECTION NEVER GOES BACKWARDS. Snapshots arrive late, twice, and out
 *   of order, and a catalogue that can regress will eventually advertise a
 *   recording an operator removed.
 */
import { describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ReplayRecord } from './archive.js';
import { REPLAY_STATUSES, type ReplayStatus } from './lifecycle.js';
import { REPLAY_FAILURE_REASONS } from './outcome.js';
import {
  AIRING_PAGE_SIZE,
  MAX_AIRING_PAGE,
  REPLAY_NOT_KEPT,
  isReachableStatus,
  judgeProjection,
  pageSize,
  summariseFailure,
  summariseReplay,
  type ReplayDisposition,
} from './airing.js';

const RUN: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_a' };
const STARTED = 1_700_000_000_000;

function record(overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    identity: RUN,
    retention: { policy: 'keep' },
    visibility: 'unlisted',
    status: 'available',
    startedAtMs: STARTED,
    finalisedAtMs: STARTED + 60_000,
    expiresAtMs: null,
    segments: [
      {
        runId: RUN.runId,
        segmentId: 'run_a.g0.00000',
        startProgrammeTimeMs: 0,
        endProgrammeTimeMs: 2000,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: '/replay/runs/abc/media/deadbeef.bin',
        bytes: 100_000,
      },
    ],
    initialisations: [
      {
        runId: RUN.runId,
        generation: 0,
        storageReference: '/replay/runs/abc/init/g0.bin',
        bytes: 1_000,
      },
    ],
    bytes: 101_000,
    failure: null,
    history: [],
    ...overrides,
  };
}

function replay(status: ReplayStatus): ReplayDisposition {
  return summariseReplay(record({ status }));
}

/* =========================================================== the projection */

describe('what the catalogue keeps about a recording', () => {
  it('carries status, retention and visibility', () => {
    const projected = summariseReplay(record());
    expect(projected.disposition).toBe('replay');
    if (projected.disposition !== 'replay') throw new Error('unreachable');
    expect(projected.summary.status).toBe('available');
    expect(projected.summary.retention).toEqual({ policy: 'keep' });
    expect(projected.summary.visibility).toBe('unlisted');
    expect(projected.summary.finalisedAtMs).toBe(STARTED + 60_000);
  });

  it('carries an expiry when the policy states one', () => {
    const projected = summariseReplay(
      record({
        retention: { policy: 'expire', expiresAtMs: STARTED + 1_000 },
        expiresAtMs: STARTED + 1_000,
      }),
    );
    if (projected.disposition !== 'replay') throw new Error('unreachable');
    expect(projected.summary.expiresAtMs).toBe(STARTED + 1_000);
  });

  it('carries a summary of size, not the media itself', () => {
    const projected = summariseReplay(record());
    if (projected.disposition !== 'replay') throw new Error('unreachable');
    expect(projected.summary.bytes).toBe(101_000);
    expect(projected.summary.segmentCount).toBe(1);
    expect(projected.summary.initialisationCount).toBe(1);
  });

  it('carries a failure when there is one', () => {
    const projected = summariseReplay(
      record({
        status: 'failed',
        failure: { reason: 'media-origin-failed', detail: 'the encoder died', liveImpact: 'none' },
      }),
    );
    if (projected.disposition !== 'replay') throw new Error('unreachable');
    expect(projected.summary.failure?.reason).toBe('media-origin-failed');
    expect(projected.summary.failure?.summary).toBe(
      'The programme media origin failed before the replay completed.',
    );
  });

  it('never carries the archive own failure text, which can name a path', () => {
    /*
     * THE LEAK THIS CLOSES. A `source-media-unavailable` detail is assembled
     * where the failure happened and names the spool file that could not be
     * copied -- exactly right for a log on the box, and exactly wrong for a
     * product database that is queried by other things and backed up
     * elsewhere. The reason survives; the sentence is chosen here.
     */
    for (const leak of [
      'C:\videofy\spool\run\segment.m4s',
      '/srv/videofy/spool/run/segment.m4s',
    ]) {
      const projected = summariseReplay(
        record({
          status: 'failed',
          failure: {
            reason: 'source-media-unavailable',
            detail: `programme media at ${leak} could not be copied`,
            liveImpact: 'none',
          },
        }),
      );
      if (projected.disposition !== 'replay') throw new Error('unreachable');
      const serialised = JSON.stringify(projected);
      expect(serialised).not.toContain(leak);
      expect(serialised).not.toContain('spool');
      expect(serialised).not.toContain('segment.m4s');
      expect(projected.summary.failure?.reason).toBe('source-media-unavailable');
      expect(projected.summary.failure?.summary).toBe(
        'Programme media became unavailable before replay retention completed.',
      );
    }
  });

  it('gives every failure reason a sentence of its own', () => {
    for (const reason of REPLAY_FAILURE_REASONS) {
      const summary = summariseFailure({ reason, detail: 'C:\secret\path', liveImpact: 'none' });
      expect(summary?.reason).toBe(reason);
      expect(summary?.summary.length ?? 0).toBeGreaterThan(0);
      expect(summary?.summary).not.toContain('secret');
    }
  });

  it('gives an unrecognised reason the vaguest sentence, not the raw text', () => {
    // A reason added in a later wave must not become a leak by being forgotten
    // in the mapping.
    const summary = summariseFailure({
      reason: 'invented-later' as never,
      detail: '/srv/videofy/spool/run/segment.m4s',
      liveImpact: 'none',
    });
    expect(summary?.summary).toBe('The replay failed.');
    expect(JSON.stringify(summary)).not.toContain('spool');
  });

  it('never carries anything that says where the media lives', () => {
    /*
     * THE LEAK THIS PREVENTS is a product database that also happens to be a
     * map of the archive. A history row describes a broadcast; finding its
     * bytes is the archive's job and nobody else's.
     */
    const projected = summariseReplay(record());
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain('/replay/runs');
    expect(serialised).not.toContain('storageReference');
    expect(serialised).not.toContain('.bin');
    expect(serialised).not.toContain('deadbeef');
    if (projected.disposition !== 'replay') throw new Error('unreachable');
    expect(Object.keys(projected.summary).sort()).toEqual([
      'bytes',
      'expiresAtMs',
      'failure',
      'finalisedAtMs',
      'initialisationCount',
      'retention',
      'segmentCount',
      'status',
      'visibility',
    ]);
  });
});

/* ================================================================ NONE */

describe('a programme nobody recorded still happened', () => {
  it('has a disposition of its own rather than an absent recording', () => {
    expect(REPLAY_NOT_KEPT).toEqual({ disposition: 'none' });
  });

  it('is never dressed up as a deleted or failed recording', () => {
    /*
     * `deleted` and `failed` describe recordings that existed and stopped
     * existing. A programme the operator chose not to keep never had one, and
     * telling those apart is the difference between "we removed this" and "we
     * were never asked to hold it".
     */
    const held = REPLAY_NOT_KEPT;
    expect(held).not.toHaveProperty('summary');
    expect(JSON.stringify(held)).not.toContain('deleted');
    expect(JSON.stringify(held)).not.toContain('failed');
  });

  it('is accepted as the first thing known about an airing', () => {
    expect(judgeProjection(null, REPLAY_NOT_KEPT).kind).toBe('apply');
  });

  it('is idempotent', () => {
    expect(judgeProjection(REPLAY_NOT_KEPT, REPLAY_NOT_KEPT).kind).toBe('apply');
  });
});

/* ==================================================== disposition conflicts */

describe('an airing either kept a recording or it did not', () => {
  it('refuses to turn a recorded airing into an unrecorded one', () => {
    const judgement = judgeProjection(replay('available'), REPLAY_NOT_KEPT);
    expect(judgement.kind).toBe('conflict');
  });

  it('refuses to turn an unrecorded airing into a recorded one', () => {
    // The decision was taken when the broadcast opened. Either direction here
    // means two sources disagree about what happened.
    const judgement = judgeProjection(REPLAY_NOT_KEPT, replay('recording'));
    expect(judgement.kind).toBe('conflict');
  });
});

/* ================================================= lifecycle in a projection */

describe('a projection may move forward and never back', () => {
  it('accepts the first thing it is told', () => {
    for (const status of REPLAY_STATUSES) {
      expect(judgeProjection(null, replay(status)).kind).toBe('apply');
    }
  });

  it('accepts the same snapshot twice', () => {
    for (const status of REPLAY_STATUSES) {
      expect(judgeProjection(replay(status), replay(status)).kind).toBe('apply');
    }
  });

  it('accepts ordinary progress', () => {
    expect(judgeProjection(replay('recording'), replay('processing')).kind).toBe('apply');
    expect(judgeProjection(replay('processing'), replay('available')).kind).toBe('apply');
    expect(judgeProjection(replay('recording'), replay('failed')).kind).toBe('apply');
    expect(judgeProjection(replay('available'), replay('expired')).kind).toBe('apply');
    expect(judgeProjection(replay('available'), replay('deleted')).kind).toBe('apply');
    expect(judgeProjection(replay('failed'), replay('deleted')).kind).toBe('apply');
  });

  it('accepts a jump that skipped a snapshot nobody sent', () => {
    /*
     * The catalogue is fed CURRENT STATE, not a transition log. A `processing`
     * snapshot lost to a catalogue outage must not make the `available` one
     * that follows look like corruption.
     */
    expect(judgeProjection(replay('recording'), replay('available')).kind).toBe('apply');
    expect(judgeProjection(replay('recording'), replay('deleted')).kind).toBe('apply');
    expect(judgeProjection(replay('recording'), replay('expired')).kind).toBe('apply');
  });

  it('ignores a snapshot from the past arriving late', () => {
    for (const [held, incoming] of [
      ['available', 'recording'],
      ['available', 'processing'],
      ['deleted', 'available'],
      ['deleted', 'recording'],
      ['expired', 'available'],
      ['expired', 'recording'],
      ['failed', 'recording'],
      ['failed', 'available'],
      ['processing', 'recording'],
    ] as const) {
      const judgement = judgeProjection(replay(held), replay(incoming));
      expect(judgement.kind, `${held} -> ${incoming}`).toBe('stale');
    }
  });

  it('uses the archive lifecycle graph rather than a second one of its own', () => {
    // Reachability over REPLAY_TRANSITIONS: every forward path, no path back.
    expect(isReachableStatus('recording', 'available')).toBe(true);
    expect(isReachableStatus('recording', 'deleted')).toBe(true);
    expect(isReachableStatus('available', 'recording')).toBe(false);
    expect(isReachableStatus('deleted', 'available')).toBe(false);
    expect(isReachableStatus('deleted', 'deleted')).toBe(true);
    for (const status of REPLAY_STATUSES) {
      expect(isReachableStatus(status, 'recording')).toBe(status === 'recording');
    }
  });
});

/* ================================================================ paging */

describe('how much history a page holds', () => {
  it('has a default and a ceiling', () => {
    expect(pageSize(undefined)).toBe(AIRING_PAGE_SIZE);
    expect(pageSize({})).toBe(AIRING_PAGE_SIZE);
    expect(pageSize({ limit: 10 })).toBe(10);
    expect(pageSize({ limit: 10_000 })).toBe(MAX_AIRING_PAGE);
  });

  it('ignores a limit that is not a sensible count', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pageSize({ limit })).toBe(AIRING_PAGE_SIZE);
    }
  });
});
