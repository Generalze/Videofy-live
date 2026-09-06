/** @author masterzee001 */
/**
 * The object-storage archive, behind its own subpath.
 *
 * SEPARATE FROM THE ROOT, exactly as `./filesystem` is, and for a sharper
 * reason. The Replay CONTRACTS are imported by things with no storage at all --
 * a browser bundle reads the airing types, the account service reads the
 * audience rules -- and the moment an object-store client is reachable from the
 * root, every one of those drags a signer, a stream conversion and a network
 * client along with it. Storage is asked for by name.
 *
 * `./filesystem` AND `./object` ARE SIBLINGS, NOT ALTERNATIVES IN SEQUENCE.
 * Both remain supported: a single-box deployment keeps a volume, a
 * multi-instance one moves to a bucket, and both satisfy the same frozen
 * `ProgrammeReplayArchive`. Nothing in the domain knows which is in use.
 */

export * from './object-layout.js';
export * from './object-store.js';
export * from './object-archive.js';
/** A store with no network, so the archive can be driven without one. */
export * from './memory-object-store.js';
