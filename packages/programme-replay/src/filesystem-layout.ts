/** @author masterzee001 */
/**
 * Where a run's archived material lives, agreed on once.
 *
 * TWO THINGS NEED THIS ANSWER AND THEY MUST NOT DERIVE IT SEPARATELY. The
 * archive writes objects into a run's directory; delivery has to decide whether
 * an object it has been asked for is inside that same directory. If each
 * computed the path its own way, the day one of them changed would be the day
 * containment quietly stopped meaning anything -- and nothing would fail, which
 * is the worst version of that.
 *
 * A NAME DERIVED FROM AN IDENTITY, NEVER THE IDENTITY. Run ids and segment ids
 * are opaque and arrive from the wire. Pasting one into a path is how `..`
 * becomes a directory traversal and a colon becomes an alternate data stream on
 * Windows. A digest sidesteps all of it and is stable across restarts, which is
 * what recovery needs. The original ids are still written inside the metadata,
 * because that is what a human reads.
 *
 * FILESYSTEM-ONLY, and reachable only through the `./filesystem` subpath. The
 * Replay contracts stay portable; nothing here belongs in them.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The directory name for one run. Stable, opaque, and safe in a path. */
export function replayRunKey(runId: string): string {
  return replayObjectKey(runId);
}

/** The file name for one archived object, derived from its logical id. */
export function replayObjectKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The one directory a run's material may occupy.
 *
 * THE TRUST BOUNDARY FOR DELIVERY. Being somewhere under the archive root is
 * not enough: every other run's media is under the archive root too, and a
 * reference that has been tampered into naming a neighbour's fragment would
 * pass a root-only check while handing one viewer another broadcast. The
 * question delivery has to ask is narrower -- is this object inside the
 * directory belonging to the run this viewer was authorised for -- and this is
 * how both sides ask it the same way.
 */
export function replayRunDirectory(archiveRoot: string, runId: string): string {
  return join(archiveRoot, 'runs', replayRunKey(runId));
}

/** Where a run's fragments live. */
export function replaySegmentDirectory(archiveRoot: string, runId: string): string {
  return join(replayRunDirectory(archiveRoot, runId), 'media');
}

/** Where a run's initialisation material lives. */
export function replayInitialisationDirectory(archiveRoot: string, runId: string): string {
  return join(replayRunDirectory(archiveRoot, runId), 'init');
}

/**
 * THE one path a given fragment may occupy.
 *
 * DERIVED FROM THE LOGICAL IDENTITY, which is what makes it useful twice over:
 * the archive uses it to decide where to write, and delivery uses it to decide
 * what it is allowed to read. Because both compute it from `runId` and
 * `segmentId` -- neither of which comes from the metadata being checked -- a
 * persisted reference stops being a way to CHOOSE an object and becomes merely
 * a claim that can be compared against the answer.
 *
 * Without this, run-scoped containment still allows one fragment of a
 * recording to be served in place of another: same run, same directory,
 * possibly the same size, and entirely the wrong material.
 */
export function replaySegmentPath(
  archiveRoot: string,
  runId: string,
  segmentId: string,
): string {
  return join(replaySegmentDirectory(archiveRoot, runId), `${replayObjectKey(segmentId)}.bin`);
}

/** THE one path a given encoder generation's initialisation material may occupy. */
export function replayInitialisationPath(
  archiveRoot: string,
  runId: string,
  generation: number,
): string {
  return join(replayInitialisationDirectory(archiveRoot, runId), `g${String(generation)}.bin`);
}
