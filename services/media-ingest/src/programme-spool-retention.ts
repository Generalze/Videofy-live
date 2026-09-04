/** @author masterzee001 */
/**
 * Actually removing what retention decided to let go of.
 *
 * THE STORE HAS BEEN PRUNING AN INDEX AND NOTHING ELSE. Every deployment
 * constructed `ProgrammeMediaStore` with the sink that keeps nothing --
 * `NO_SEGMENT_SINK`, whose `discard` returns true without touching a file --
 * so a segment left the in-memory window and its bytes stayed on the volume
 * for the life of the broadcast. Retention reported segments discarded, the
 * manifest was correct, the cursor was correct, and the spool grew until the
 * disk filled. It is the same shape as the recovery hole: the record of the
 * policy was real and the physical half of it was never wired.
 *
 * THREE RULES GOVERN A DELETION HERE.
 *
 * Containment: nothing outside the spool is ever unlinked. The reference being
 * deleted came from our own store, but a delete path that trusts its input is
 * one mistake away from removing something else on the host.
 *
 * Init objects are reference-counted, not aged. A fragment is decodable only
 * with the initialisation object of its generation, so deleting generation G
 * while any retained fragment still names it silently destroys the retained
 * window rather than trimming it -- an audience mid-reconnect gets material
 * that cannot be decoded.
 *
 * Durability: the unlink is followed by a directory sync, for the same reason
 * the write was. A removal that is not durable can come back after a power
 * loss as a file the timeline no longer references.
 */

import { open, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { initFileName } from '@videofy-live/programme-contribution';
import type { MediaSegmentSink } from './programme-media-store.js';
import { generationOf } from './programme-media-recovery.js';

/*
 * Which files are initialisation objects, derived from the name the packager
 * is actually told to write.
 *
 * NOT A SECOND SPELLING OF THE CONVENTION. `initFileName` is the one authority
 * for that name, and a pattern written from memory beside it is how a sweep
 * quietly matches nothing -- or, far worse, matches something else. This asks
 * the authority what generation zero is called and takes the text either side
 * of the number, so a change there cannot leave this behind.
 *
 * Split rather than built into a regular expression on purpose: a pattern
 * assembled from another string has to escape it, and an escape written wrong
 * fails as a pattern that matches the wrong files rather than as an error.
 */
const INIT_EXAMPLE = initFileName(0);
const INIT_PREFIX = INIT_EXAMPLE.slice(0, INIT_EXAMPLE.indexOf('0'));
const INIT_SUFFIX = INIT_EXAMPLE.slice(INIT_EXAMPLE.indexOf('0') + 1);

/** The generation an init object's file name names, or null if it is not one. */
export function initGenerationOfFile(fileName: string): number | null {
  if (!fileName.startsWith(INIT_PREFIX) || !fileName.endsWith(INIT_SUFFIX)) return null;
  const digits = fileName.slice(INIT_PREFIX.length, fileName.length - INIT_SUFFIX.length);
  if (digits.length === 0 || !/^[0-9]+$/u.test(digits)) return null;
  return Number(digits);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch {
    // Windows cannot open a directory as a handle. The deployment target can,
    // and the startup probe is what refuses a volume where this matters.
    return;
  }
  try {
    await handle.sync();
  } catch {
    /* Reported by the readiness probe, not by every deletion. */
  } finally {
    await handle.close();
  }
}

export interface SpoolRetentionDeps {
  /** The one directory anything may be deleted from. */
  readonly spoolRoot: string;
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * A sink that removes a segment's bytes, and refuses to remove anything else.
 */
export class FileSegmentSink implements MediaSegmentSink {
  private readonly root: string;

  constructor(private readonly deps: SpoolRetentionDeps) {
    this.root = resolve(deps.spoolRoot);
  }

  async discard(storageReference: string): Promise<boolean> {
    const path = resolve(storageReference);
    if (!path.startsWith(`${this.root}${sep}`)) {
      /*
       * Unreachable if the store is behaving, and fatal to the host if it is
       * not. Refused rather than logged and done anyway: the cost of a wrong
       * refusal is a spool that grows, and the cost of a wrong deletion is
       * somebody else's file.
       */
      this.deps.onProblem?.('refused to discard media outside the spool', {
        // The path is ours, not a caller's, and naming it helps whoever has to
        // find out how the store minted it.
        path,
      });
      return false;
    }
    try {
      await rm(path, { force: true });
    } catch (error) {
      this.deps.onProblem?.('a retained media segment could not be removed', {
        code: (error as { code?: string }).code ?? 'unknown',
      });
      return false;
    }
    await syncDirectory(path.slice(0, path.lastIndexOf(sep)));
    return true;
  }
}

export interface GenerationSweepResult {
  /** Generations whose init object was removed. */
  readonly removed: readonly number[];
  /** Generations kept because a retained fragment still needs them. */
  readonly kept: readonly number[];
}

/**
 * Remove the initialisation objects no retained fragment references any more.
 *
 * `retainedSegmentIds` is the authority, and it is passed in rather than read
 * from disk on purpose: what the run still owes an audience is a fact about
 * the store, and asking the filesystem instead would count orphans as
 * references and keep every generation for ever.
 *
 * A generation with no retained fragment is removable. A generation with one
 * is not -- however old it is, and even if it is the oldest on the volume.
 */
export async function sweepInitGenerations(input: {
  readonly directory: string;
  readonly retainedSegmentIds: readonly string[];
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}): Promise<GenerationSweepResult> {
  const needed = new Set<number>();
  for (const segmentId of input.retainedSegmentIds) {
    const generation = generationOf(segmentId);
    if (generation !== null) needed.add(generation);
  }

  let entries: string[];
  try {
    entries = await readdir(input.directory);
  } catch {
    return { removed: [], kept: [...needed].sort((a, b) => a - b) };
  }

  const removed: number[] = [];
  const kept: number[] = [];
  for (const entry of entries) {
    const generation = initGenerationOfFile(entry);
    if (generation === null) continue;
    if (needed.has(generation)) {
      kept.push(generation);
      continue;
    }
    try {
      await rm(join(input.directory, entry), { force: true });
      removed.push(generation);
    } catch (error) {
      input.onProblem?.('an expired initialisation object could not be removed', {
        generation,
        code: (error as { code?: string }).code ?? 'unknown',
      });
    }
  }
  if (removed.length > 0) await syncDirectory(input.directory);
  return {
    removed: removed.sort((a, b) => a - b),
    kept: kept.sort((a, b) => a - b),
  };
}

/**
 * How long a file nothing references is left alone before it counts as litter.
 *
 * Generous on purpose. The window between a segment being made durable and the
 * timeline appending its reference is milliseconds, but a file being written
 * right now is indistinguishable from an abandoned one by inspection alone --
 * and deleting the first kills a live broadcast to tidy up after a dead one.
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export interface OrphanSweepResult {
  readonly removed: readonly string[];
  /** Files left alone because they are too recent to judge. */
  readonly tooRecent: number;
  readonly skipped: string | null;
}

/**
 * Remove spool files no timeline ever committed.
 *
 * ORPHANS ARE THE SAFE DIRECTION AND ARE EXPECTED. Media is made durable
 * before its reference is appended, so a process that dies between the two
 * leaves bytes nothing points at -- which is strictly better than a reference
 * pointing at bytes that are not there.
 *
 * WHAT THIS MUST NEVER BE is "delete what is not in memory". After a restart
 * NOTHING is in memory, and that rule would delete the entire retained window
 * of every recovered broadcast a moment before the audience needed it. So this
 * refuses to run until recovery has rebuilt the authoritative set, takes that
 * set as its input, and additionally leaves anything younger than the grace
 * period where it is.
 */
export async function sweepOrphans(input: {
  readonly directory: string;
  /** Files the timeline accounts for. Deleting one of these is data loss. */
  readonly referencedFileNames: readonly string[];
  /** False until recovery has reconstructed this run. */
  readonly recovered: boolean;
  readonly now?: number;
  readonly graceMs?: number;
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}): Promise<OrphanSweepResult> {
  if (!input.recovered) {
    return {
      removed: [],
      tooRecent: 0,
      skipped: 'recovery has not reconstructed this run, so nothing here is known to be an orphan',
    };
  }

  let entries: string[];
  try {
    entries = await readdir(input.directory);
  } catch {
    return { removed: [], tooRecent: 0, skipped: 'the run directory could not be read' };
  }

  const referenced = new Set(input.referencedFileNames);
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? ORPHAN_GRACE_MS;
  const removed: string[] = [];
  let tooRecent = 0;

  for (const entry of entries) {
    if (referenced.has(entry)) continue;
    /*
     * Init objects belong to the generation sweep, which counts references.
     * Age cannot decide them: the init of a long-running generation is by
     * definition the oldest file in the directory and is needed by every
     * fragment in it.
     */
    if (initGenerationOfFile(entry) !== null) continue;
    // The packager's own playlist, which is private to the encoder and is
    // rewritten continuously. Not ours to delete under a running run.
    if (entry.endsWith('.m3u8')) continue;

    const path = join(input.directory, entry);
    let modifiedMs: number;
    try {
      modifiedMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (now - modifiedMs < graceMs) {
      tooRecent += 1;
      continue;
    }
    try {
      await rm(path, { force: true });
      removed.push(entry);
    } catch (error) {
      input.onProblem?.('an orphaned spool file could not be removed', {
        code: (error as { code?: string }).code ?? 'unknown',
      });
    }
  }
  if (removed.length > 0) await syncDirectory(input.directory);
  return { removed, tooRecent, skipped: null };
}
