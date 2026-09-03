/** @author masterzee001 */
/**
 * Bringing the retained MEDIA back after a restart, not just the record of it.
 *
 * The journal survives a restart and the cursor is restored with it, so a
 * recovered broadcast knows exactly what it published and how far behind the
 * audience is. It does not know where the bytes are: the media store is held
 * in memory and comes back empty, so the timeline described a window of
 * segments that nothing could serve.
 *
 * The symptom is quiet and complete. The manifest is well formed and lists
 * nothing; the cursor is correct; every status is green; the audience simply
 * receives an empty playlist for the rest of the broadcast. "The safety buffer
 * survives a restart" was half true -- the promise survived and the material
 * did not.
 *
 * AND THE MISSING CASE IS NOT THE SAME AS THE WAITING CASE. A segment that is
 * absent because the packager has not finished closing it is a moment old and
 * arrives on the next poll. A segment the timeline already REFERENCES and that
 * is not on the volume was published to somebody and is gone -- retained media
 * corruption, and the protection is broken rather than pending. Both are
 * ENOENT at the system call, and treating them the same way is how a broadcast
 * would retry for ever over material that is never coming back.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProgrammeMediaSegment, ProgrammeTimelineEvent } from '@videofy-live/programme-timeline';
import type { ProgrammeMediaStore } from './programme-media-store.js';

/** What a recovery found, in the terms an operator needs. */
export interface MediaRecoveryResult {
  /** Segments whose bytes are on the volume and are back in the store. */
  readonly restored: number;
  /**
   * Segments the timeline references and the volume does not have.
   *
   * Any of these is a broken promise: the material was published to an
   * audience and cannot be served again.
   */
  readonly missing: readonly string[];
  /** The init generations the restored segments still depend on. */
  readonly generations: readonly number[];
}

/**
 * The file a segment id names.
 *
 * The producer mints `run.gN.NNNNN` and the packager writes `seg_gN_NNNNN.m4s`,
 * so the mapping is derivable rather than stored. Kept in one place because
 * two spellings of the same convention is how a recovery quietly finds
 * nothing.
 */
export function segmentFileName(segmentId: string): string | null {
  const found = /\.g(\d+)\.(\d+)$/u.exec(segmentId);
  if (found === null) return null;
  return `seg_g${found[1]}_${found[2]}.m4s`;
}

export function generationOf(segmentId: string): number | null {
  const found = /\.g(\d+)\./u.exec(segmentId);
  return found === null ? null : Number(found[1]);
}

/**
 * Put the retained media back, and report anything that did not come back.
 *
 * Only what the timeline references. The spool may also hold orphans -- media
 * that was made durable and never referenced, which is the direction the
 * write ordering deliberately fails in -- and those are not part of the
 * broadcast and must not be resurrected into it.
 */
export async function recoverProgrammeMedia(input: {
  readonly runId: string;
  readonly directory: string;
  readonly events: readonly ProgrammeTimelineEvent[];
  readonly media: ProgrammeMediaStore;
}): Promise<MediaRecoveryResult> {
  const missing: string[] = [];
  const generations = new Set<number>();
  let restored = 0;

  for (const event of input.events) {
    if (event.kind !== 'media') continue;
    const fileName = segmentFileName(event.reference);
    if (fileName === null) {
      // A reference this build cannot map is not a reference it may ignore.
      missing.push(event.reference);
      continue;
    }

    const path = join(input.directory, fileName);
    let bytes: number;
    try {
      bytes = (await stat(path)).size;
    } catch {
      missing.push(event.reference);
      continue;
    }
    /*
     * Present but empty is missing. A zero-length file is what a truncated
     * write leaves behind, and offering it would hand a player something it
     * cannot decode -- which is worse than saying the material is gone.
     */
    if (bytes === 0) {
      missing.push(event.reference);
      continue;
    }

    const generation = generationOf(event.reference) ?? 0;
    generations.add(generation);
    const segment: ProgrammeMediaSegment = {
      runId: input.runId,
      segmentId: event.reference,
      startProgrammeTimeMs: event.programmeTimeMs,
      endProgrammeTimeMs: event.programmeTimeMs + (event.durationMs ?? 0),
      /*
       * Guaranteed by the command that produced it. Re-probing every retained
       * segment on every restart would decode the whole window to re-learn a
       * fact that is structural, and would make recovery time grow with the
       * length of the broadcast.
       */
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: path,
      bytes,
      initGeneration: generation,
    };
    if (input.media.accept(segment)) restored += 1;
  }

  return { restored, missing, generations: [...generations].sort((a, b) => a - b) };
}
