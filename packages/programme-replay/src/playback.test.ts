/** @author masterzee001 */
/**
 * What may be played, and what a player is told.
 *
 * TWO PROPERTIES, AND THE FIRST IS THE ONE THAT MATTERS. A recording that is
 * not `available` must produce no playlist at all -- not a shorter one, not a
 * partial one. Every refusal below describes a record that would have rendered
 * into a perfectly well-formed playlist and then misbehaved: a hole nothing
 * accounts for, two fragments claiming the same second, a generation whose
 * initialisation material was never kept. Each of those is invisible in the
 * document and obvious to a decoder, which is the wrong order.
 *
 * The second property is that nothing about where the bytes live ever reaches
 * the manifest.
 */
import { describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ReplayRecord } from './archive.js';
import type { ReplayStatus } from './lifecycle.js';
import type { ReplayInitialisation } from './media.js';
import { planReplayPlayback, renderReplayVodManifest } from './playback.js';

const RUN: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_a' };
const ARCHIVE = '/replay/runs/abc123';

function segment(
  index: number,
  overrides: Partial<ProgrammeMediaSegment> = {},
): ProgrammeMediaSegment {
  const start = index * 2000;
  return {
    runId: RUN.runId,
    segmentId: `${RUN.runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: start,
    endProgrammeTimeMs: start + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `${ARCHIVE}/media/${index}.bin`,
    bytes: 100_000,
    ...overrides,
  };
}

function initialisation(generation = 0): ReplayInitialisation {
  return {
    runId: RUN.runId,
    generation,
    storageReference: `${ARCHIVE}/init/g${generation}.bin`,
    bytes: 1_000,
  };
}

function record(overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    identity: RUN,
    retention: { policy: 'keep' },
    visibility: 'public',
    status: 'available',
    startedAtMs: 1_700_000_000_000,
    finalisedAtMs: 1_700_000_100_000,
    expiresAtMs: null,
    segments: [segment(0), segment(1)],
    initialisations: [initialisation(0)],
    bytes: 201_000,
    failure: null,
    history: [],
    ...overrides,
  };
}

const URIS = {
  init: (generation: number) => `/replays/run_a/init/${String(generation)}`,
  segment: (segmentId: string) => `/replays/run_a/segments/${segmentId}`,
};

function rendered(overrides: Partial<ReplayRecord> = {}): string {
  const playback = planReplayPlayback(record(overrides));
  if (!playback.playable) throw new Error(`unexpectedly unplayable: ${playback.detail}`);
  return renderReplayVodManifest(playback.plan, URIS);
}

/* ============================================================== lifecycle */

describe('only a finished recording is something to play', () => {
  it('plans playback for an available recording', () => {
    const playback = planReplayPlayback(record());
    expect(playback.playable).toBe(true);
    if (!playback.playable) throw new Error('unreachable');
    expect(playback.plan.entries).toHaveLength(2);
    expect(playback.plan.runId).toBe('run_a');
    expect(playback.plan.totalDurationMs).toBe(4000);
  });

  const unplayable: readonly ReplayStatus[] = [
    'recording',
    'processing',
    'failed',
    'expired',
    'deleted',
  ];

  for (const status of unplayable) {
    it(`refuses a recording in status ${status}`, () => {
      /*
       * None of these is "almost VOD". A recording still being written has
       * fragments whose neighbours have not arrived; a failed one is not a
       * shorter programme; an expired or deleted one is supposed to be gone.
       */
      const playback = planReplayPlayback(record({ status }));
      expect(playback.playable).toBe(false);
      if (playback.playable) throw new Error('unreachable');
      expect(playback.refusal).toBe('not-available');
      expect(playback.detail).toContain(status);
    });
  }
});

/* ============================================================= validation */

describe('an available recording is still checked before it is rendered', () => {
  it('refuses one holding nothing', () => {
    const playback = planReplayPlayback(record({ segments: [] }));
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('no-media');
  });

  it('refuses a fragment that occupies no time', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0, { endProgrammeTimeMs: 0 })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('invalid-duration');
  });

  it('refuses a fragment that runs backwards', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0, { startProgrammeTimeMs: 4000, endProgrammeTimeMs: 2000 })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('invalid-duration');
  });

  it('refuses a duration that is not a number at all', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0, { endProgrammeTimeMs: Number.POSITIVE_INFINITY })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('invalid-duration');
  });

  it('refuses two fragments claiming the same programme time', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0), segment(1, { startProgrammeTimeMs: 1000 })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('overlapping');
  });

  it('refuses a fragment recorded out of order', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(2), segment(0)] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('out-of-order');
  });

  it('refuses a hole where a stretch of programme should be', () => {
    // Rendered, this would play straight through a jump nobody announced, and
    // the recording would look complete in every listing.
    const playback = planReplayPlayback(
      record({ segments: [segment(0), segment(1, { startProgrammeTimeMs: 8000, endProgrammeTimeMs: 10_000 })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('programme-time-gap');
  });

  it('refuses a fragment whose generation was never kept', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0), segment(1, { initGeneration: 1 })] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('initialisation-missing');
    expect(playback.detail).toContain('generation 1');
  });

  it('refuses one id used twice', () => {
    const playback = planReplayPlayback(
      record({ segments: [segment(0), segment(0)] }),
    );
    expect(playback.playable).toBe(false);
    if (playback.playable) throw new Error('unreachable');
    expect(playback.refusal).toBe('duplicate-segment');
  });

  it('does not sort a broken record into looking correct', () => {
    // The archive wrote these down in the order the broadcast produced them.
    // A list that needs sorting to make sense is a list that is wrong, and
    // reordering it turns a detectable fault into a playlist that misbehaves.
    const shuffled = [segment(0), segment(2), segment(1)];
    const playback = planReplayPlayback(record({ segments: shuffled }));
    expect(playback.playable).toBe(false);
  });

  it('changes nothing about the record it refuses', () => {
    // Delivery finding a problem is not authority to rewrite a lifecycle the
    // archive already committed.
    const held = record({ segments: [] });
    planReplayPlayback(held);
    expect(held.status).toBe('available');
    expect(held.failure).toBeNull();
  });
});

/* =============================================================== manifest */

describe('the playlist a player is handed', () => {
  it('is a VOD playlist that ends', () => {
    const manifest = rendered();
    expect(manifest).toContain('#EXTM3U');
    expect(manifest).toContain('#EXT-X-VERSION:7');
    expect(manifest).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(manifest).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(manifest.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('states each duration exactly as the programme time says', () => {
    const manifest = rendered({
      segments: [
        segment(0, { endProgrammeTimeMs: 1960 }),
        segment(1, { startProgrammeTimeMs: 1960, endProgrammeTimeMs: 4000 }),
      ],
    });
    expect(manifest).toContain('#EXTINF:1.960000,');
    expect(manifest).toContain('#EXTINF:2.040000,');
  });

  it('targets the longest fragment, rounded up', () => {
    const manifest = rendered({
      segments: [
        segment(0, { endProgrammeTimeMs: 2500 }),
        segment(1, { startProgrammeTimeMs: 2500, endProgrammeTimeMs: 4000 }),
      ],
    });
    expect(manifest).toContain('#EXT-X-TARGETDURATION:3');
  });

  it('never has a target duration of zero', () => {
    const manifest = rendered({ segments: [segment(0, { endProgrammeTimeMs: 100 })] });
    expect(manifest).toContain('#EXT-X-TARGETDURATION:1');
  });

  it('maps the first generation before any media', () => {
    const manifest = rendered();
    const lines = manifest.split('\n');
    const map = lines.findIndex((line) => line.startsWith('#EXT-X-MAP:'));
    const media = lines.findIndex((line) => line.startsWith('/replays/'));
    expect(map).toBeGreaterThanOrEqual(0);
    expect(map).toBeLessThan(media);
    expect(manifest).toContain('#EXT-X-MAP:URI="/replays/run_a/init/0"');
  });

  it('names routes, and never where the bytes live', () => {
    /*
     * THE LEAK THIS PREVENTS is a playlist handing every viewer a map of the
     * box: an archive root, a volume name, a directory somebody could go
     * looking for. A viewer names material by opaque id, which is also what
     * lets the archive become object storage later without a player noticing.
     */
    const manifest = rendered();
    expect(manifest).not.toContain(ARCHIVE);
    expect(manifest).not.toContain('/replay/runs');
    expect(manifest).not.toContain('file://');
    expect(manifest).not.toContain('.bin');
    expect(manifest).toContain('/replays/run_a/segments/run_a.g0.00000');
  });
});

/* ============================================================ generations */

describe('a broadcast whose encoder restarted', () => {
  const multi = {
    segments: [
      segment(0, { initGeneration: 0 }),
      segment(1, { initGeneration: 0 }),
      segment(2, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
      segment(3, { initGeneration: 1, segmentId: 'run_a.g1.00001' }),
    ],
    initialisations: [initialisation(0), initialisation(1)],
  };

  it('plans both generations, in the order they were used', () => {
    const playback = planReplayPlayback(record(multi));
    expect(playback.playable).toBe(true);
    if (!playback.playable) throw new Error('unreachable');
    expect(playback.plan.generations).toEqual([0, 1]);
    expect(playback.plan.entries.map((e) => e.discontinuity)).toEqual([false, false, true, false]);
  });

  it('announces the break and remaps before the new generation plays', () => {
    /*
     * One map at the top would be silently wrong for half the programme, and
     * the failure would arrive as a decode error partway through rather than
     * as anything anybody could attribute.
     */
    const manifest = rendered(multi);
    const lines = manifest.split('\n').filter((line) => line.length > 0);
    const discontinuity = lines.indexOf('#EXT-X-DISCONTINUITY');
    const firstMap = lines.indexOf('#EXT-X-MAP:URI="/replays/run_a/init/0"');
    const secondMap = lines.indexOf('#EXT-X-MAP:URI="/replays/run_a/init/1"');
    const firstNewSegment = lines.indexOf('/replays/run_a/segments/run_a.g1.00000');

    expect(firstMap).toBeGreaterThanOrEqual(0);
    expect(discontinuity).toBeGreaterThan(firstMap);
    expect(secondMap).toBeGreaterThan(discontinuity);
    expect(firstNewSegment).toBeGreaterThan(secondMap);
  });

  it('emits exactly one map per generation, not one per fragment', () => {
    const manifest = rendered(multi);
    const maps = manifest.split('\n').filter((line) => line.startsWith('#EXT-X-MAP:'));
    expect(maps).toHaveLength(2);
    const breaks = manifest.split('\n').filter((line) => line === '#EXT-X-DISCONTINUITY');
    expect(breaks).toHaveLength(1);
  });

  it('treats an absent generation as the first one', () => {
    const manifest = rendered({ segments: [segment(0), segment(1, { initGeneration: 0 })] });
    expect(manifest.split('\n').filter((l) => l.startsWith('#EXT-X-MAP:'))).toHaveLength(1);
  });
});
