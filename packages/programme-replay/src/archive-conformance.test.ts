/** @author masterzee001 */
/**
 * One set of rules, run against every archive that claims to keep a recording.
 *
 * WHY THIS IS NOT TWO SUITES. There are two implementations of one port now,
 * and the failure that costs the most is not either of them being wrong on its
 * own -- it is them being wrong DIFFERENTLY. A backend that accepts a segment
 * the other refuses turns "does replay work?" into "which archive was this
 * deployment using?", and that question is answered by an audience.
 *
 * So the semantics are asserted once and executed twice. Anything a test in
 * here can see must be true of any archive; anything that is genuinely about
 * storage -- byte ownership, restart, crash windows -- lives in the suite for
 * the implementation that has storage.
 *
 * REAL FILES, EVEN FOR THE ARCHIVE THAT IGNORES THEM. A durable archive copies
 * what it is offered, so a fixture describing media that does not exist would
 * pass against memory and fail against a disk for reasons that have nothing to
 * do with the rule under test.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ProgrammeReplayArchive } from './archive.js';
import { FilesystemReplayArchive } from './filesystem.js';
import { InMemoryReplayArchive } from './memory-archive.js';
import type { ReplayInitialisation } from './media.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const RUN_A: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_a' };
const RUN_B: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_b' };

/** A spool a fixture can write real fragments into. */
interface Spool {
  readonly directory: string;
  segment(index: number, overrides?: Partial<ProgrammeMediaSegment>): ProgrammeMediaSegment;
  initialisation(generation?: number, runId?: string): ReplayInitialisation;
  /** A second file with different content, for proving a conflict is refused. */
  rival(name: string): string;
  cleanup(): void;
}

function spool(): Spool {
  const directory = mkdtempSync(join(tmpdir(), 'videofy-conformance-'));
  mkdirSync(directory, { recursive: true });

  const write = (name: string, body: string): string => {
    const path = join(directory, name);
    writeFileSync(path, Buffer.from(body));
    return path;
  };

  return {
    directory,
    segment(index, overrides = {}) {
      const start = index * 2000;
      const runId = overrides.runId ?? RUN_A.runId;
      const name = `${runId}.g0.${String(index).padStart(5, '0')}.m4s`;
      const path = write(name, `SEGMENT-${name}`.padEnd(96, '.'));
      return {
        runId,
        segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
        startProgrammeTimeMs: start,
        endProgrammeTimeMs: start + 2000,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: path,
        bytes: statSync(path).size,
        ...overrides,
      };
    },
    initialisation(generation = 0, runId = RUN_A.runId) {
      const path = write(`${runId}.init.${generation}.mp4`, `INIT-${runId}-${generation}`);
      return { runId, generation, storageReference: path, bytes: statSync(path).size };
    },
    rival(name) {
      return write(name, `RIVAL-${name}`.padEnd(96, '~'));
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

interface Subject {
  readonly name: string;
  create(now: () => number): Promise<ProgrammeReplayArchive>;
  cleanup(): void;
}

function inMemorySubject(): Subject {
  return {
    name: 'InMemoryReplayArchive',
    create: async (now) => new InMemoryReplayArchive(now),
    cleanup: () => undefined,
  };
}

function filesystemSubject(): Subject {
  const roots: string[] = [];
  return {
    name: 'FilesystemReplayArchive',
    create: async (now) => {
      const root = mkdtempSync(join(tmpdir(), 'videofy-archive-'));
      roots.push(root);
      const { archive } = await FilesystemReplayArchive.open(root, now);
      return archive;
    },
    cleanup: () => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      roots.length = 0;
    },
  };
}

function conformsToTheReplayContract(subject: Subject): void {
  describe(subject.name, () => {
    let media: Spool;
    let archive: ProgrammeReplayArchive;

    beforeEach(async () => {
      media = spool();
      archive = await subject.create(() => STARTED);
    });

    afterEach(() => {
      media.cleanup();
      subject.cleanup();
    });

    async function keep(identity = RUN_A): Promise<void> {
      const begun = await archive.begin({
        identity,
        retention: { policy: 'keep' },
        visibility: 'private',
        startedAtMs: STARTED,
      });
      if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
    }

    /* ------------------------------------------------------------- policy */

    it('refuses to open a recording the operator asked not to have', async () => {
      const begun = await archive.begin({
        identity: RUN_A,
        retention: { policy: 'none' },
        visibility: 'private',
        startedAtMs: STARTED,
      });
      expect(begun.ok).toBe(false);
      if (begun.ok) throw new Error('unreachable');
      expect(begun.failure.reason).toBe('policy-forbids-replay');
      expect(await archive.describe(RUN_A.runId)).toBeNull();

      const offered = await archive.retainSegment(RUN_A.runId, media.segment(0));
      expect(offered.ok).toBe(false);
      if (offered.ok) throw new Error('unreachable');
      expect(offered.failure.reason).toBe('policy-forbids-replay');
    });

    it('refuses an expiry that is not in the future', async () => {
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

    it('records the visibility and the identity it was given', async () => {
      await archive.begin({
        identity: RUN_A,
        retention: { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
        visibility: 'unlisted',
        startedAtMs: STARTED,
      });
      const held = await archive.describe(RUN_A.runId);
      expect(held?.visibility).toBe('unlisted');
      expect(held?.identity).toEqual(RUN_A);
      expect(held?.expiresAtMs).toBe(STARTED + THIRTY_DAYS_MS);
    });

    it('refuses to open the same run twice', async () => {
      await keep();
      const again = await archive.begin({
        identity: RUN_A,
        retention: { policy: 'keep' },
        visibility: 'private',
        startedAtMs: STARTED,
      });
      expect(again.ok).toBe(false);
      if (again.ok) throw new Error('unreachable');
      expect(again.failure.reason).toBe('lifecycle-transition-refused');
    });

    it('refuses everything for a run nobody began', async () => {
      const offered = await archive.retainSegment(RUN_A.runId, media.segment(0));
      expect(offered.ok).toBe(false);
      if (offered.ok) throw new Error('unreachable');
      expect(offered.failure.reason).toBe('unknown-replay');
    });

    /* ------------------------------------------------------ run isolation */

    it('refuses media belonging to another run', async () => {
      await keep();
      const foreign = media.segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' });
      const offered = await archive.retainSegment(RUN_A.runId, foreign);
      expect(offered.ok).toBe(false);
      if (offered.ok) throw new Error('unreachable');
      expect(offered.failure.reason).toBe('run-mismatch');
      expect((await archive.describe(RUN_A.runId))?.segments).toEqual([]);
    });

    it('keeps two airings of one programme entirely apart', async () => {
      await keep(RUN_A);
      await keep(RUN_B);
      await archive.retainSegment(RUN_A.runId, media.segment(0));
      await archive.retainSegment(
        RUN_B.runId,
        media.segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' }),
      );
      expect((await archive.describe(RUN_A.runId))?.segments.map((s) => s.segmentId)).toEqual([
        'run_a.g0.00000',
      ]);
      expect((await archive.describe(RUN_B.runId))?.segments.map((s) => s.segmentId)).toEqual([
        'run_b.g0.00000',
      ]);
    });

    /* ---------------------------------------------------- validity, bytes */

    it('refuses a segment that cannot begin a playback', async () => {
      await keep();
      const offered = await archive.retainSegment(
        RUN_A.runId,
        media.segment(0, { keyframeAligned: false }),
      );
      expect(offered.ok).toBe(false);
      if (offered.ok) throw new Error('unreachable');
      expect(offered.failure.reason).toBe('segment-invalid');
    });

    it('accounts for the bytes it holds', async () => {
      await keep();
      const init = media.initialisation(0);
      const first = media.segment(0);
      const second = media.segment(1);
      await archive.retainInitialisation(RUN_A.runId, init);
      await archive.retainSegment(RUN_A.runId, first);
      await archive.retainSegment(RUN_A.runId, second);

      const held = await archive.describe(RUN_A.runId);
      expect(held?.bytes).toBe(init.bytes + first.bytes + second.bytes);
    });

    /* ------------------------------------------------------- idempotence */

    it('absorbs an exact repeat without storing it twice', async () => {
      await keep();
      const only = media.segment(0);
      const first = await archive.retainSegment(RUN_A.runId, only);
      const again = await archive.retainSegment(RUN_A.runId, only);

      if (!first.ok || !again.ok) throw new Error('unreachable');
      expect(first.value.stored).toBe(true);
      expect(again.value.stored).toBe(false);
      expect(again.value.segmentCount).toBe(1);
      expect(again.value.bytes).toBe(first.value.bytes);
      expect((await archive.describe(RUN_A.runId))?.segments).toHaveLength(1);
    });

    it('absorbs an exact initialisation repeat the same way', async () => {
      await keep();
      const init = media.initialisation(0);
      const first = await archive.retainInitialisation(RUN_A.runId, init);
      const again = await archive.retainInitialisation(RUN_A.runId, init);

      if (!first.ok || !again.ok) throw new Error('unreachable');
      expect(first.value.stored).toBe(true);
      expect(again.value.stored).toBe(false);
      expect(again.value.initialisationCount).toBe(1);
      expect(again.value.bytes).toBe(first.value.bytes);
    });

    /* ---------------------------------------------------------- conflicts */

    it('refuses a segment id re-offered against different media', async () => {
      await keep();
      const original = media.segment(0);
      await archive.retainSegment(RUN_A.runId, original);

      const conflicting = await archive.retainSegment(RUN_A.runId, {
        ...original,
        storageReference: media.rival('elsewhere.m4s'),
      });
      expect(conflicting.ok).toBe(false);
      if (conflicting.ok) throw new Error('unreachable');
      expect(conflicting.failure.reason).toBe('segment-conflict');
      expect((await archive.describe(RUN_A.runId))?.segments).toHaveLength(1);
    });

    it('refuses an initialisation generation re-offered against different media', async () => {
      await keep();
      const original = media.initialisation(2);
      await archive.retainInitialisation(RUN_A.runId, original);

      const conflicting = await archive.retainInitialisation(RUN_A.runId, {
        ...original,
        storageReference: media.rival('other-init.mp4'),
      });
      expect(conflicting.ok).toBe(false);
      if (conflicting.ok) throw new Error('unreachable');
      expect(conflicting.failure.reason).toBe('initialisation-conflict');
      expect((await archive.describe(RUN_A.runId))?.initialisations).toHaveLength(1);
    });

    /* ------------------------------------------------------ finalisation */

    it('walks recording, processing, available when the recording is whole', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));

      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(true);
      if (!finalised.ok) throw new Error('unreachable');
      expect(finalised.value.status).toBe('available');
      expect(finalised.value.history.map((h) => h.status)).toEqual([
        'recording',
        'processing',
        'available',
      ]);
    });

    it('never becomes available when a needed generation was not kept', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0, { initGeneration: 0 }));
      await archive.retainSegment(
        RUN_A.runId,
        media.segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
      );

      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(false);
      if (finalised.ok) throw new Error('unreachable');
      expect(finalised.failure.reason).toBe('initialisation-missing');
      const held = await archive.describe(RUN_A.runId);
      expect(held?.status).toBe('failed');
      expect(held?.status).not.toBe('available');
    });

    it('never becomes available having retained nothing', async () => {
      await keep();
      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(false);
      if (finalised.ok) throw new Error('unreachable');
      expect(finalised.failure.reason).toBe('no-media-retained');
      expect((await archive.describe(RUN_A.runId))?.status).toBe('failed');
    });

    it('supports fragments from more than one encoder generation', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(1));
      await archive.retainSegment(RUN_A.runId, media.segment(0, { initGeneration: 0 }));
      await archive.retainSegment(
        RUN_A.runId,
        media.segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
      );

      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(true);
      if (!finalised.ok) throw new Error('unreachable');
      expect(finalised.value.initialisations.map((i) => i.generation).sort()).toEqual([0, 1]);
    });

    it('stops accepting media once it is finalised', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));
      await archive.finalise(RUN_A.runId);

      const late = await archive.retainSegment(RUN_A.runId, media.segment(1));
      expect(late.ok).toBe(false);
      if (late.ok) throw new Error('unreachable');
      expect(late.failure.reason).toBe('lifecycle-transition-refused');
    });

    /* ------------------------------------------------------------ failure */

    it('records an explicit failure and refuses to publish afterwards', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));
      const failed = await archive.fail(RUN_A.runId, 'media-origin-failed', 'the encoder died');

      expect(failed.ok).toBe(true);
      if (!failed.ok) throw new Error('unreachable');
      expect(failed.value.status).toBe('failed');
      expect(failed.value.failure?.reason).toBe('media-origin-failed');

      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(false);
      expect((await archive.describe(RUN_A.runId))?.status).toBe('failed');
    });

    /* --------------------------------------------------- delete and expire */

    it('deletes, hides the media, and tolerates the retry', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));

      const deleted = await archive.delete(RUN_A.runId);
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) throw new Error('unreachable');
      expect(deleted.value.status).toBe('deleted');
      expect(deleted.value.segments).toEqual([]);
      expect(deleted.value.bytes).toBe(0);

      const again = await archive.delete(RUN_A.runId);
      expect(again.ok).toBe(true);
      const held = await archive.describe(RUN_A.runId);
      expect(held?.status).toBe('deleted');
      expect(held?.history.filter((h) => h.status === 'deleted')).toHaveLength(1);
    });

    it('never lets a deleted recording become available', async () => {
      await keep();
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));
      await archive.delete(RUN_A.runId);

      const finalised = await archive.finalise(RUN_A.runId);
      expect(finalised.ok).toBe(false);
      if (finalised.ok) throw new Error('unreachable');
      expect(finalised.failure.reason).toBe('lifecycle-transition-refused');
      expect((await archive.describe(RUN_A.runId))?.status).toBe('deleted');
    });

    it('expires only once the stated instant has passed, and tolerates the retry', async () => {
      await archive.begin({
        identity: RUN_A,
        retention: { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
        visibility: 'private',
        startedAtMs: STARTED,
      });
      await archive.retainInitialisation(RUN_A.runId, media.initialisation(0));
      await archive.retainSegment(RUN_A.runId, media.segment(0));
      await archive.finalise(RUN_A.runId);

      const early = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS - 1);
      expect(early.ok).toBe(false);

      const due = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
      expect(due.ok).toBe(true);
      if (!due.ok) throw new Error('unreachable');
      expect(due.value.status).toBe('expired');
      expect(due.value.segments).toEqual([]);

      const retried = await archive.expire(RUN_A.runId, STARTED);
      expect(retried.ok).toBe(true);
      const held = await archive.describe(RUN_A.runId);
      expect(held?.history.filter((h) => h.status === 'expired')).toHaveLength(1);
    });

    it('refuses to expire a recording that was asked to be kept', async () => {
      await keep();
      const expired = await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);
      expect(expired.ok).toBe(false);
      if (expired.ok) throw new Error('unreachable');
      expect(expired.failure.reason).toBe('lifecycle-transition-refused');
    });

    /* ------------------------------------------------------ live impunity */

    it('answers every refusal without threatening the broadcast', async () => {
      const refusals = [
        await archive.finalise('run_nobody'),
        await archive.delete('run_nobody'),
        await archive.expire('run_nobody', 0),
      ];
      for (const outcome of refusals) {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('unreachable');
        expect(outcome.failure.liveImpact).toBe('none');
      }
    });
  });
}

describe('every archive keeps the same promises', () => {
  conformsToTheReplayContract(inMemorySubject());
  conformsToTheReplayContract(filesystemSubject());
});
