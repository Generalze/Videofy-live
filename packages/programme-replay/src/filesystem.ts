/** @author masterzee001 */
/**
 * The Node filesystem adapter, behind a door of its own.
 *
 * WHY A SECOND ENTRYPOINT. The Replay domain is contracts: what a recording
 * is, what may be kept, what may never be called available. Nothing in it
 * needs a disk, and plenty of things that will import it -- a browser bundle,
 * an edge worker, a service that only reads policy -- have no disk to give it.
 * Once `FilesystemReplayArchive` was exported from the root, every one of those
 * would pull `node:fs/promises` in behind it, and would find out at build time
 * or, worse, at run time.
 *
 * So the root stays storage-neutral and this subpath is the only way to reach
 * an implementation that touches a filesystem. A caller that wants durable
 * replays asks for it by name:
 *
 *     import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
 *
 * which is also a readable statement about what that deployment now depends on.
 */

export {
  FilesystemReplayArchive,
  REPLAY_ARCHIVE_SCHEMA_VERSION,
  type CorruptReplayRun,
  type ReplayArchiveOpening,
} from './filesystem-archive.js';
