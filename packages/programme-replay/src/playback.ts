/** @author masterzee001 */
/**
 * Turning a finished recording into something a player can seek through.
 *
 * WHAT THIS IS NOT. It is not an encoder, a remuxer or a second recording. The
 * archived fragments ARE the programme output -- keyframe-aligned, independently
 * decodable, already written once by the encoder that aired them. Playback is
 * assembly: say what exists, in what order, against which initialisation
 * material, and let an ordinary HLS player do the rest.
 *
 * WHY IT IS PURE. This module has no filesystem, no HTTP and no clock. It takes
 * a `ReplayRecord` and gives back a plan, and the URIs are supplied by whoever
 * is serving. That is what lets the same plan be rendered by a service today
 * and by something in front of object storage later, and it is why the root of
 * this package can still be imported somewhere with no disk at all.
 *
 * ONLY `available` IS PLAYABLE, and the check is not a formality. A recording
 * still being written has fragments whose neighbours have not arrived; a failed
 * one is not a shorter programme; an expired or deleted one is supposed to be
 * gone. Each would render into a playlist that looks perfectly well-formed,
 * which is exactly why refusing them has to happen here rather than being left
 * to whoever calls.
 *
 * AND `available` IS NOT TAKEN ON TRUST EITHER. A record can satisfy its own
 * lifecycle and still be unplayable -- two fragments claiming the same instant,
 * a hole where a minute of programme should be, a generation whose
 * initialisation material is not in the record. Those are checked before a
 * playlist exists rather than discovered by a decoder, and a record that fails
 * is REFUSED rather than tidied: sorting a corrupted list into something that
 * renders is how a broken recording becomes a broadcast nobody can explain.
 */

import type { ReplayRecord } from './archive.js';

/** Why a recording cannot be played. Each one is a different fault. */
export type ReplayPlaybackRefusal =
  /** The lifecycle says it is not something to play. */
  | 'not-available'
  /** Available, and holding nothing. */
  | 'no-media'
  /** A fragment that occupies no time, or an impossible amount of it. */
  | 'invalid-duration'
  /** A fragment that begins before the one before it. */
  | 'out-of-order'
  /** Two fragments claiming the same programme time. */
  | 'overlapping'
  /** A stretch of programme nothing accounts for. */
  | 'programme-time-gap'
  /** A fragment whose initialisation generation is not in the record. */
  | 'initialisation-missing'
  /** One id, two fragments. */
  | 'duplicate-segment';

/** One fragment, as a playlist needs to describe it. */
export interface ReplayPlaybackEntry {
  readonly segmentId: string;
  readonly initGeneration: number;
  readonly durationSeconds: number;
  readonly startProgrammeTimeMs: number;
  readonly endProgrammeTimeMs: number;
  /**
   * Whether the decoder must be told to expect a break here.
   *
   * True exactly where this fragment's generation differs from the one before.
   * A restarted encoder can change timestamps, resolution or codec
   * configuration, and a decoder that is not warned reads the jump as
   * corruption rather than as a new configuration.
   */
  readonly discontinuity: boolean;
}

/** Everything a manifest needs, with nothing about where the bytes live. */
export interface ReplayPlaybackPlan {
  readonly runId: string;
  /** Generations referenced by the fragments, in the order first used. */
  readonly generations: readonly number[];
  readonly entries: readonly ReplayPlaybackEntry[];
  /** The longest fragment, rounded up, as HLS requires. */
  readonly targetDurationSeconds: number;
  readonly totalDurationMs: number;
}

export type ReplayPlayback =
  | { readonly playable: true; readonly plan: ReplayPlaybackPlan }
  | {
      readonly playable: false;
      readonly refusal: ReplayPlaybackRefusal;
      readonly detail: string;
    };

function refuse(refusal: ReplayPlaybackRefusal, detail: string): ReplayPlayback {
  return { playable: false, refusal, detail };
}

/**
 * Work out whether a recording can be played, and how.
 *
 * TOTAL, AND FREE OF SIDE EFFECTS. A refusal here says the recording cannot be
 * rendered; it does not fail the replay, move its lifecycle, or write anything
 * down. Delivery discovering a problem is not authority to rewrite the history
 * an archive already committed.
 */
export function planReplayPlayback(record: ReplayRecord): ReplayPlayback {
  if (record.status !== 'available') {
    return refuse(
      'not-available',
      `a replay in status ${record.status} is not something to play`,
    );
  }
  if (record.segments.length === 0) {
    return refuse('no-media', 'this replay holds no media');
  }

  const generationsHeld = new Set(record.initialisations.map((entry) => entry.generation));
  const seen = new Set<string>();
  const generations: number[] = [];
  const entries: ReplayPlaybackEntry[] = [];
  let previous: ReplayPlaybackEntry | null = null;

  /*
   * THE RECORDED ORDER IS THE ORDER. Nothing here sorts: the archive wrote
   * these down as the broadcast produced them, and a list that needs sorting to
   * make sense is a list that is wrong. Reordering it would turn a detectable
   * fault into a playlist that renders and misbehaves.
   */
  for (const segment of record.segments) {
    if (seen.has(segment.segmentId)) {
      return refuse('duplicate-segment', `segment ${segment.segmentId} appears more than once`);
    }
    seen.add(segment.segmentId);

    const durationMs = segment.endProgrammeTimeMs - segment.startProgrammeTimeMs;
    if (
      !Number.isFinite(segment.startProgrammeTimeMs) ||
      !Number.isFinite(segment.endProgrammeTimeMs) ||
      durationMs <= 0
    ) {
      return refuse(
        'invalid-duration',
        `segment ${segment.segmentId} occupies no usable programme time`,
      );
    }

    const generation = segment.initGeneration ?? 0;
    if (!generationsHeld.has(generation)) {
      return refuse(
        'initialisation-missing',
        `segment ${segment.segmentId} needs initialisation generation ${generation}, which this replay does not hold`,
      );
    }

    if (previous !== null) {
      if (segment.startProgrammeTimeMs < previous.startProgrammeTimeMs) {
        return refuse(
          'out-of-order',
          `segment ${segment.segmentId} begins before the segment recorded before it`,
        );
      }
      if (segment.startProgrammeTimeMs < previous.endProgrammeTimeMs) {
        return refuse(
          'overlapping',
          `segment ${segment.segmentId} begins at ${segment.startProgrammeTimeMs}, inside the segment ending at ${previous.endProgrammeTimeMs}`,
        );
      }
      if (segment.startProgrammeTimeMs > previous.endProgrammeTimeMs) {
        /*
         * A HOLE IS REFUSED RATHER THAN PAPERED OVER. A player handed a
         * playlist with a silent gap plays through it and shows an audience a
         * jump nobody announced -- and the recording would look complete in
         * every listing. Programme time is continuous across an encoder
         * restart, so a gap is never the ordinary case.
         */
        return refuse(
          'programme-time-gap',
          `nothing accounts for programme time ${previous.endProgrammeTimeMs} to ${segment.startProgrammeTimeMs}`,
        );
      }
    }

    if (!generations.includes(generation)) generations.push(generation);
    const entry: ReplayPlaybackEntry = {
      segmentId: segment.segmentId,
      initGeneration: generation,
      durationSeconds: durationMs / 1000,
      startProgrammeTimeMs: segment.startProgrammeTimeMs,
      endProgrammeTimeMs: segment.endProgrammeTimeMs,
      discontinuity: previous !== null && previous.initGeneration !== generation,
    };
    entries.push(entry);
    previous = entry;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    return refuse('no-media', 'this replay holds no media');
  }

  const longest = entries.reduce((max, entry) => Math.max(max, entry.durationSeconds), 0);
  return {
    playable: true,
    plan: {
      runId: record.identity.runId,
      generations,
      entries,
      targetDurationSeconds: Math.max(1, Math.ceil(longest)),
      totalDurationMs: last.endProgrammeTimeMs - first.startProgrammeTimeMs,
    },
  };
}

/**
 * Where a player should go for each thing the plan names.
 *
 * SUPPLIED BY THE CALLER, never derived here. A storage reference is an archive
 * detail -- a path, an object key, a volume nobody outside the service should
 * learn about -- and a playlist that carried one would hand every viewer a map
 * of the box. What goes in a manifest is a route.
 */
export interface ReplayManifestUris {
  init(generation: number): string;
  segment(segmentId: string): string;
}

/**
 * A finished broadcast as an ordinary HLS VOD playlist.
 *
 * PLAYLIST-TYPE:VOD and a closing ENDLIST are what make a player offer a
 * scrub bar instead of following a live edge: the whole programme is described
 * at once, every duration is exact, and nothing will be appended.
 *
 * SEEKING NEEDS NO PROTOCOL OF ITS OWN. It falls out of a complete playlist,
 * keyframe-aligned fragments, honest EXTINF values and byte-range access to the
 * archived objects. Anything more would be a second way to do what HLS already
 * does, and a second thing to be wrong.
 */
export function renderReplayVodManifest(
  plan: ReplayPlaybackPlan,
  uris: ReplayManifestUris,
): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${plan.targetDurationSeconds}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];

  /*
   * THE MAP IS EMITTED WHERE IT CHANGES, never once at the top.
   *
   * A broadcast whose encoder restarted holds fragments written against two
   * different configurations, and the older ones do not decode against the
   * newer initialisation object. One map at the top would be silently wrong
   * for half the programme, and the failure would arrive as a decode error
   * partway through rather than as anything anybody could attribute.
   */
  let mapped: number | null = null;
  for (const entry of plan.entries) {
    if (entry.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (mapped !== entry.initGeneration) {
      lines.push(`#EXT-X-MAP:URI="${uris.init(entry.initGeneration)}"`);
      mapped = entry.initGeneration;
    }
    lines.push(`#EXTINF:${entry.durationSeconds.toFixed(6)},`);
    lines.push(uris.segment(entry.segmentId));
  }

  // Always: a replay is finished by definition, and a player that is not told
  // so waits at the end for material that is never coming.
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}
