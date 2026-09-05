/** @author masterzee001 */
/**
 * A broadcast that is over, kept because somebody may still want to watch it.
 *
 * WHY THIS IS NOT THE SAFETY BUFFER. The live spool already retains programme
 * media, and it is tempting to read that as "we have recording". It is not the
 * same thing and must never be made to be. The spool holds SECONDS -- the
 * configured delay plus a margin -- for one purpose: so the audience can be
 * held behind the live edge and a reconnecting viewer caught up. It is sized
 * by the delay, pruned as the cursor advances, and released when the broadcast
 * ends. Every one of those properties is right for a safety buffer and wrong
 * for a replay.
 *
 * Replay retention is measured in hours, days, months or forever; it is chosen
 * by an operator rather than derived from a delay grade; and it has to survive
 * exactly the moment the spool is designed to clean up, which is the end of
 * the programme. Widening the spool to cover it would mean holding every
 * broadcast's entire video inside the live path, sized by a constant that
 * exists to protect a cursor -- and it would make a replay's lifetime move
 * whenever somebody changed a delay setting. So there are two retentions, and
 * this package is the second one. Nothing here reads the first one.
 *
 * WHAT THIS WAVE IS. Contracts, a state machine, and a port. Nothing here is
 * wired into the live runtime, nothing here writes to a disk or an object
 * store, and nothing here schedules anything. Landing it alone is what lets
 * the invariants a recording has to satisfy -- run isolation, idempotence,
 * initialisation completeness, truthful failure, and above all that a replay
 * problem is never a broadcast problem -- be pinned before any of them is
 * load-bearing for a live programme.
 *
 * REPLAY IS MEDIA INFRASTRUCTURE. It has no opinion about transcription,
 * language routes, synthesised speech or provider certification, and no
 * dependency on any of them. A recording of a broadcast is a recording of a
 * broadcast whether or not anybody ever said a word in it.
 */

import type { ReplayRecord } from './archive.js';
import { expiryOf } from './policy.js';

/**
 * Whether this replay has outlived its retention.
 *
 * A QUESTION, NOT A SCHEDULER. Nothing in this package watches a clock; a
 * caller that has one asks. `keep` never expires, so it answers false however
 * long ago the broadcast was.
 */
export function hasExpired(record: ReplayRecord, nowMs: number): boolean {
  const at = expiryOf(record.retention);
  return at !== null && nowMs >= at;
}

/** The states a recording moves through, and the moves it is allowed to make. */
export * from './lifecycle.js';
/** What was asked for: how long to keep it, and who may watch it. */
export * from './policy.js';
/** The material a recording is made of, and what makes it playable. */
export * from './media.js';
/** How Replay refuses without taking a broadcast off air. */
export * from './outcome.js';
/** The archive port, and the record it keeps. */
export * from './archive.js';
/** Turning a finished recording into a seekable playlist. Storage-neutral. */
export * from './playback.js';
/** The history a broadcast leaves behind, whether or not it was recorded. */
export * from './airing.js';
/** Who may be told what about that history, and what a public answer looks like. */
export * from './audience.js';
/** An implementation with no storage, for tests and for development. */
export * from './memory-archive.js';
/*
 * `FilesystemReplayArchive` IS DELIBERATELY NOT HERE.
 *
 * It lives behind `@videofy-live/programme-replay/filesystem`, because the
 * moment a durable archive is reachable from this root every importer of the
 * Replay CONTRACTS drags `node:fs/promises` along with them -- including the
 * ones that have no filesystem to offer. The domain stays portable; storage is
 * asked for by name.
 *
 * `recording.ts` is absent for a different reason: it is how the archives
 * agree with each other, not something a caller should be building against.
 */
