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
import { initFileName } from '@videofy-live/programme-contribution';
import {
  retentionWindowMs,
  type ProgrammeMediaSegment,
  type ProgrammeTimelineEvent,
} from '@videofy-live/programme-timeline';
import type { ProgrammeMediaStore } from './programme-media-store.js';

/** What a recovery found, in the terms an operator needs. */
export interface MediaRecoveryResult {
  /** Segments whose bytes are on the volume and are back in the store. */
  readonly restored: number;
  /**
   * REQUIRED segments the volume does not have.
   *
   * Any of these is a broken promise: the material is inside the window this
   * broadcast still owes its audience, and it cannot be served.
   */
  readonly missing: readonly string[];
  /**
   * References the retention policy was entitled to delete.
   *
   * NOT A FAULT, and keeping the two apart is the whole of this type. A
   * six-hour programme's journal remembers hour one; the spool is required to
   * hold minutes. A recovery that demanded every reference ever written would
   * fail on the first restart of any long broadcast -- for material that was
   * correctly deleted hours earlier.
   */
  readonly expired: number;
  /** The init generations the restored segments still depend on. */
  readonly generations: readonly number[];
  /**
   * Generations whose initialisation object is absent or empty.
   *
   * SEPARATE FROM `missing`, because the fix is different and the blast radius
   * is larger: one absent init makes every retained fragment of that
   * generation undecodable, however many of them came back.
   */
  readonly missingInits: readonly number[];
  /** The earliest programme time this run must still be able to serve. */
  readonly requiredFromMs: number;
}

/**
 * The earliest programme time a run must still hold media for.
 *
 * Derived from the SAME function retention prunes by, so the two cannot drift:
 * anything retention was entitled to discard is exactly what recovery is
 * entitled not to find. Two independent definitions of one boundary would
 * disagree the first time either was tuned.
 *
 * Everything at or after this point is required -- including material the
 * cursor has NOT yet released. A restart that recovered only what was already
 * public would restore the current manifest and then run out of programme the
 * moment the cursor advanced.
 */
export function requiredMediaFromMs(
  publicOutputTimeMs: number,
  configuredDelayMs: number,
): number {
  return Math.max(0, publicOutputTimeMs - retentionWindowMs(configuredDelayMs));
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
  /** Where the audience had reached. Zero when nothing was released. */
  readonly publicOutputTimeMs: number;
  readonly configuredDelayMs: number;
}): Promise<MediaRecoveryResult> {
  const missing: string[] = [];
  const generations = new Set<number>();
  let restored = 0;
  let expired = 0;
  const requiredFromMs = requiredMediaFromMs(
    input.publicOutputTimeMs,
    input.configuredDelayMs,
  );

  for (const event of input.events) {
    if (event.kind !== 'media') continue;
    /*
     * Older than the window this run still owes anybody. Retention was
     * entitled to delete it, so its absence is the system working -- and
     * restoring it would put material back that the store is meant to have
     * let go.
     */
    if (event.programmeTimeMs + (event.durationMs ?? 0) <= requiredFromMs) {
      expired += 1;
      continue;
    }
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

  /*
   * THE INIT OBJECTS THE RESTORED WINDOW DEPENDS ON.
   *
   * A fragment decodes only with the initialisation object of its generation,
   * so a window whose fragments are all present and whose init is missing is
   * not a recovered window -- it is a set of files no player can open. This
   * used to be inferred from the segment names and never checked, which meant
   * recovery could report every segment restored and hand the audience
   * material that could not be decoded.
   */
  const missingInits: number[] = [];
  for (const generation of generations) {
    const path = join(input.directory, initFileName(generation));
    try {
      if ((await stat(path)).size === 0) missingInits.push(generation);
    } catch {
      missingInits.push(generation);
    }
  }

  return {
    restored,
    missing,
    expired,
    missingInits: missingInits.sort((a, b) => a - b),
    generations: [...generations].sort((a, b) => a - b),
    requiredFromMs,
  };
}
