/** @author masterzee001 */
/**
 * Getting archived bytes to a viewer, without the route knowing where they are.
 *
 * WHY AN ABSTRACTION AND NOT A PATH. Today a replay lives on a volume; the wave
 * after next it may live in object storage. A route that opened files itself
 * would have to be rewritten for that, and rewriting an access-checked delivery
 * path is exactly the kind of change that loses a check. So the HTTP layer asks
 * for an object by the reference the archive recorded, and gets back something
 * it can size and stream.
 *
 * THE REFERENCE IS NOT TRUSTED, EVEN THOUGH WE WROTE IT.
 *
 * It arrives from a `ReplayRecord`, which came from a JSON file on a disk that
 * other things can reach. If that file is ever edited -- by a bug, a restore
 * from the wrong backup, or somebody -- then a string inside it becomes an
 * instruction to open a file, and the process running this has whatever the
 * service account can read. Containment is therefore checked at the moment of
 * opening rather than assumed from provenance: persisted metadata must never
 * become a path-traversal capability.
 *
 * AND THE ARCHIVE ROOT IS THE WRONG BOUNDARY TO CHECK IT AGAINST.
 *
 * Every recording on the box lives under that root. A reference tampered into
 * naming a NEIGHBOUR'S fragment -- a real file, of a plausible size, written by
 * this very archive -- passes a root-only check completely, and a viewer
 * authorised for one broadcast is handed another. If the neighbour is private,
 * that is the whole of its privacy gone, and nothing about the request looks
 * wrong.
 *
 * SO THE REFERENCE DOES NOT CHOOSE THE OBJECT. THE IDENTITY DOES.
 *
 * Scoping to the run was necessary and is still not enough. Every fragment of a
 * recording lives in one directory, so a reference edited to name the NEXT
 * fragment -- or the run's own initialisation object -- stays inside the run,
 * is a real file, may be exactly the recorded length, and is simply not the
 * material that was asked for. A viewer authorised for segment 3 gets segment 4
 * and nothing anywhere reports a problem.
 *
 * What the caller asks for is therefore a logical object: this run, this
 * segment id, or this run, this generation. The adapter DERIVES the one path
 * that object may occupy, using the same helper the archive used to write it,
 * and the persisted reference is demoted from an instruction into a claim that
 * has to match. Authorisation is per object; so is the material it can reach.
 *
 * OPENED FIRST, MEASURED SECOND, STREAMED FROM THE SAME HANDLE. Checking a path
 * and then reopening it later leaves a window where the name can come to mean
 * a different file. Everything below works from one open descriptor, so the
 * bytes that were validated are the bytes that are served.
 */

import { open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  replayInitialisationPath,
  replayRunDirectory,
  replaySegmentPath,
} from '@videofy-live/programme-replay/filesystem';

/** Why an archived object could not be served. Each has a different cause. */
export type ReplayDeliveryRefusal =
  /** Nothing is there. Retention, a lost volume, or a restore that missed it. */
  | 'not-found'
  /**
   * The reference is not the canonical object for what was asked for.
   *
   * Covers every escape: out of the archive entirely, into another recording's
   * directory, and -- the one that survives run-scoping -- into a different
   * object belonging to the very same recording.
   */
  | 'outside-archive'
  /** It is there and it is not what the record says it is. */
  | 'byte-mismatch'
  /** The store could not be read at all. */
  | 'unavailable';

/** One archived object, already open and already checked. */
export interface ReplayObject {
  readonly sizeBytes: number;
  /** Bytes for the whole object, or for one inclusive range of it. */
  stream(range: { readonly start: number; readonly end: number } | null): Readable;
  close(): Promise<void>;
}

export type ReplayObjectOpening =
  | { readonly ok: true; readonly object: ReplayObject }
  | { readonly ok: false; readonly refusal: ReplayDeliveryRefusal; readonly detail: string };

/**
 * WHICH archived object is wanted, said in logical terms.
 *
 * `runId`, `generation` and `segmentId` are the identities the caller
 * authorised, and they are the only parts of this that anybody has checked --
 * the run id came from the route and was matched against the record, the
 * object id came from the record's own list. `reference` is the one field that
 * came out of persisted metadata, and it is here to be VERIFIED rather than
 * followed.
 *
 * `expectedBytes` is not advisory either. The caller knows what the archive
 * recorded, and an object of a different length is not a smaller fragment but a
 * different one.
 */
export type ReplayMediaLocator =
  | {
      readonly kind: 'initialisation';
      readonly runId: string;
      readonly generation: number;
      readonly reference: string;
      readonly expectedBytes: number;
    }
  | {
      readonly kind: 'segment';
      readonly runId: string;
      readonly segmentId: string;
      readonly reference: string;
      readonly expectedBytes: number;
    };

/** Where archived replay bytes come from. */
export interface ReplayMediaDelivery {
  open(locator: ReplayMediaLocator): Promise<ReplayObjectOpening>;
}

/**
 * Archived objects on a local volume, bound to the object that was asked for.
 *
 * THREE THINGS ARE PROVED BEFORE A BYTE MOVES, and each catches what the one
 * before it lets through:
 *
 *   1. THE REFERENCE IS THE CANONICAL PATH for this exact logical object,
 *      derived here from the authorised ids. A reference naming any other
 *      object -- in another run, or in this one -- fails immediately, and the
 *      persisted string never gets to select anything.
 *   2. THE FOLDER IT SITS IN really is this run's own. Resolved, so a junction
 *      standing where `media` should be does not quietly redirect the whole
 *      directory somewhere else.
 *   3. THE LEAF IS THE CANONICAL LEAF, compared as an exact path rather than a
 *      prefix. A symlink at the right name pointing at the wrong object
 *      resolves elsewhere and is refused; "somewhere under the right folder"
 *      would have accepted it.
 *
 * Then the file is opened once, measured from that handle, and streamed from
 * the same handle -- so the bytes that were checked are the bytes that go out.
 */
export class FilesystemReplayDelivery implements ReplayMediaDelivery {
  constructor(private readonly archiveRoot: string) {}

  async open(locator: ReplayMediaLocator): Promise<ReplayObjectOpening> {
    /*
     * DERIVED, NEVER READ. The path comes from the identities that were
     * authorised; if it were taken from the reference, the check would be
     * asking the suspect for its own alibi.
     */
    const canonical =
      locator.kind === 'initialisation'
        ? replayInitialisationPath(this.archiveRoot, locator.runId, locator.generation)
        : replaySegmentPath(this.archiveRoot, locator.runId, locator.segmentId);

    if (resolve(locator.reference) !== resolve(canonical)) {
      /*
       * The record is naming something other than the one object this request
       * is for. It may exist, it may be the right size, and it may belong to
       * this very recording -- none of which makes it the material that was
       * asked for.
       */
      return {
        ok: false,
        refusal: 'outside-archive',
        detail: 'the recorded reference is not the canonical archive object for this request',
      };
    }

    let folder: string;
    try {
      folder = await realpath(dirname(canonical));
    } catch (error) {
      return {
        ok: false,
        refusal: 'unavailable',
        detail: `the archive directory for this replay could not be read: ${describe(error)}`,
      };
    }

    let owned: string;
    try {
      owned = await realpath(resolve(replayRunDirectory(this.archiveRoot, locator.runId)));
    } catch (error) {
      return {
        ok: false,
        refusal: 'unavailable',
        detail: `the archive directory for this replay could not be read: ${describe(error)}`,
      };
    }

    if (folder !== join(owned, basename(dirname(canonical)))) {
      // The folder itself has been redirected -- a junction where `media`
      // should be. The name looked right; the place is not.
      return {
        ok: false,
        refusal: 'outside-archive',
        detail: 'the archive directory for this object does not belong to this replay',
      };
    }

    let target: string;
    try {
      target = await realpath(canonical);
    } catch {
      // Absent, or a broken link. Either way there is nothing to serve, and
      // saying which would describe the filesystem to a caller.
      return { ok: false, refusal: 'not-found', detail: 'the archived object is not there' };
    }

    if (target !== join(folder, basename(canonical))) {
      /*
       * EXACT LEAF, not "inside the right folder". A link sitting under the
       * canonical name and pointing at the neighbouring fragment satisfies
       * every prefix test there is, and serves the wrong material under the
       * right name.
       */
      return {
        ok: false,
        refusal: 'outside-archive',
        detail: 'the archived object is not the canonical object for this request',
      };
    }

    let handle: FileHandle;
    try {
      handle = await open(target, 'r');
    } catch (error) {
      return { ok: false, refusal: 'not-found', detail: `the archived object could not be opened: ${describe(error)}` };
    }

    let sizeBytes: number;
    try {
      sizeBytes = (await handle.stat()).size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      return { ok: false, refusal: 'unavailable', detail: `the archived object could not be measured: ${describe(error)}` };
    }

    if (sizeBytes !== locator.expectedBytes) {
      await handle.close().catch(() => undefined);
      return {
        ok: false,
        refusal: 'byte-mismatch',
        detail: `the archived object holds ${sizeBytes} bytes where the replay records ${locator.expectedBytes}`,
      };
    }

    return {
      ok: true,
      object: {
        sizeBytes,
        // From the handle that was measured, not from the name that was
        // measured: there is no second lookup to disagree with the first.
        stream: (range) =>
          range === null
            ? handle.createReadStream({ autoClose: true })
            : handle.createReadStream({ start: range.start, end: range.end, autoClose: true }),
        close: async () => {
          await handle.close().catch(() => undefined);
        },
      },
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
