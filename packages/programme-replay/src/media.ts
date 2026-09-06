/** @author masterzee001 */
/**
 * The material a replay is made of, and what it takes for that to be playable.
 *
 * A REPLAY REUSES THE SEGMENT THE LIVE PATH ALREADY PRODUCES. There is one
 * encoder and one description of what it wrote: `ProgrammeMediaSegment`, with
 * its run, its programme-time boundaries, its keyframe alignment, its storage
 * reference and its initialisation generation. Replay retaining a different
 * shape would mean a second description of the same bytes, and the first time
 * they disagreed the disagreement would be discovered by a viewer.
 *
 * WHAT REPLAY ADDS is the initialisation material as a retained object in its
 * own right. The live path can be relaxed about this because its window is
 * seconds long and the encoder that wrote the fragments is usually still
 * running. A replay is read back weeks later by a player that has never seen
 * the encoder, and a fragment whose initialisation was never kept is not
 * degraded -- it is undecodable. So the dependency is tracked explicitly and
 * checked before anything is called available.
 */

import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';

/**
 * The initialisation material one encoder generation's fragments need.
 *
 * SEPARATE FROM THE SEGMENTS because a broadcast whose encoder restarted
 * mid-run has fragments written against TWO different configurations and needs
 * both to play. The live manifest already offers both for exactly this reason;
 * a replay has to have kept both, which is a stronger requirement, because
 * there is no encoder still running to ask.
 */
export interface ReplayInitialisation {
  readonly runId: string;
  /** Which encoder run within the broadcast. Zero is the first. */
  readonly generation: number;
  /** Where the bytes are. Opaque: a path, an object key, a URL. */
  readonly storageReference: string;
  readonly bytes: number;
}

/** Which generation a segment was written against. Absent means the first. */
export function initGenerationOf(segment: ProgrammeMediaSegment): number {
  return segment.initGeneration ?? 0;
}

/**
 * Every initialisation generation the retained segments actually depend on.
 *
 * DERIVED FROM THE SEGMENTS, never from what the encoder announced. A
 * generation whose fragments were all discarded is not needed, and a
 * generation whose fragments were kept is needed whether or not anybody
 * remembered to mention it. Asking the segments is the only answer that stays
 * true as the retained set changes.
 */
export function requiredInitGenerations(
  segments: readonly ProgrammeMediaSegment[],
): readonly number[] {
  return [...new Set(segments.map(initGenerationOf))].sort((a, b) => a - b);
}

/** The generations the retained segments need and the archive does not hold. */
export function missingInitGenerations(
  segments: readonly ProgrammeMediaSegment[],
  retained: readonly ReplayInitialisation[],
): readonly number[] {
  const held = new Set(retained.map((init) => init.generation));
  return requiredInitGenerations(segments).filter((generation) => !held.has(generation));
}

/**
 * Whether a segment is fit to be part of a recording at all.
 *
 * The same two refusals the live store makes, for the same reason and then
 * some: a fragment that does not begin on a keyframe cannot start a playback,
 * and a replay is nothing but playbacks that start somewhere. One that
 * occupies no programme time has nothing in it to play.
 *
 * Returns the complaint, or null when there is none.
 */
export function segmentUnfitForReplay(segment: ProgrammeMediaSegment): string | null {
  if (!segment.keyframeAligned) {
    return `segment ${segment.segmentId} does not begin on a keyframe`;
  }
  if (segment.endProgrammeTimeMs <= segment.startProgrammeTimeMs) {
    return `segment ${segment.segmentId} occupies no programme time`;
  }
  return null;
}

/* --------------------------------------------------------------- conflicts */

/**
 * WHY A REPEAT IS NOT AUTOMATICALLY A DUPLICATE.
 *
 * A retry is harmless only when the second notification describes the SAME
 * logical media object. A poll that re-reads a playlist, or a recovery that
 * replays a journal it has already replayed, offers a byte-for-byte identical
 * description, and keeping one copy of it is exactly right.
 *
 * A second notification carrying the SAME IDENTITY AND DIFFERENT CONTENT is a
 * different animal entirely. Two producers disagree about what a segment id or
 * an encoder generation MEANS -- different bytes, a different storage object, a
 * different stretch of programme time. Letting the first one win would resolve
 * that disagreement silently, in favour of whichever arrived first, and the
 * result is a recording that is individually valid everywhere and wrong as a
 * whole. That is media corruption with no symptom until playback.
 *
 * So identity is compared field by field, and a disagreement is refused and
 * named. The comparison is against WHAT THE ARCHIVE WAS OFFERED, which matters
 * for a durable backend: an implementation that rewrites `storageReference` to
 * its own archive-owned reference must keep the originally offered one for
 * this check, or every ordinary retry would look like a conflict.
 */
interface FieldDifference {
  readonly field: string;
  readonly held: string | number | boolean;
  readonly offered: string | number | boolean;
}

function disagreements(fields: readonly FieldDifference[]): readonly FieldDifference[] {
  return fields.filter((field) => field.held !== field.offered);
}

function describeConflict(
  what: string,
  identity: string,
  found: readonly FieldDifference[],
): string {
  const parts = found.map(
    (field) => `${field.field} was ${JSON.stringify(field.held)} and is now ${JSON.stringify(field.offered)}`,
  );
  return `${what} ${identity} was offered again describing different media: ${parts.join('; ')}`;
}

/**
 * Whether a repeated segment describes different media. The complaint, or null.
 *
 * Every field that says what the media IS takes part: where it sits in the
 * broadcast, what it contains, how big it is, which object holds it and which
 * initialisation decodes it. An absent generation is compared as the first one,
 * so `undefined` and `0` are the same fact rather than a conflict.
 */
export function segmentConflict(
  held: ProgrammeMediaSegment,
  offered: ProgrammeMediaSegment,
): string | null {
  const found = disagreements([
    { field: 'runId', held: held.runId, offered: offered.runId },
    {
      field: 'startProgrammeTimeMs',
      held: held.startProgrammeTimeMs,
      offered: offered.startProgrammeTimeMs,
    },
    {
      field: 'endProgrammeTimeMs',
      held: held.endProgrammeTimeMs,
      offered: offered.endProgrammeTimeMs,
    },
    { field: 'keyframeAligned', held: held.keyframeAligned, offered: offered.keyframeAligned },
    { field: 'hasVideo', held: held.hasVideo, offered: offered.hasVideo },
    { field: 'hasAudio', held: held.hasAudio, offered: offered.hasAudio },
    { field: 'storageReference', held: held.storageReference, offered: offered.storageReference },
    { field: 'bytes', held: held.bytes, offered: offered.bytes },
    {
      field: 'initGeneration',
      held: initGenerationOf(held),
      offered: initGenerationOf(offered),
    },
  ]);
  return found.length === 0 ? null : describeConflict('segment', held.segmentId, found);
}

/**
 * Whether a repeated encoder generation carries different material.
 *
 * Generation 2 pointing at one object and then at another is not a retry: one
 * of the two decodes the fragments this recording kept and the other does not,
 * and nothing later can work out which.
 */
export function initialisationConflict(
  held: ReplayInitialisation,
  offered: ReplayInitialisation,
): string | null {
  const found = disagreements([
    { field: 'runId', held: held.runId, offered: offered.runId },
    { field: 'storageReference', held: held.storageReference, offered: offered.storageReference },
    { field: 'bytes', held: held.bytes, offered: offered.bytes },
  ]);
  return found.length === 0
    ? null
    : describeConflict('initialisation generation', String(held.generation), found);
}

/** What a set of retained material weighs. */
export function retainedBytes(
  segments: readonly ProgrammeMediaSegment[],
  initialisations: readonly ReplayInitialisation[],
): number {
  const media = segments.reduce((total, segment) => total + segment.bytes, 0);
  return initialisations.reduce((total, init) => total + init.bytes, media);
}
