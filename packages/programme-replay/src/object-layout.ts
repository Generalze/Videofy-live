/** @author masterzee001 */
/**
 * Where a run's archived material lives in an object store, agreed on once.
 *
 * THE SAME DOCTRINE AS `filesystem-layout.ts`, AND FOR THE SAME REASONS. Two
 * things need this answer -- the archive deciding where to put an object, and
 * delivery deciding whether the object it has been asked for is the one it is
 * allowed to read -- and if each derived it separately, the day one changed
 * would be the day binding quietly stopped meaning anything.
 *
 * A KEY DERIVED FROM AN IDENTITY, NEVER THE IDENTITY. Run ids and segment ids
 * are opaque and arrive from the wire. Pasting one into an object key is how a
 * `/` becomes a prefix boundary, a `..` becomes a traversal on the stores that
 * normalise, and a control character becomes an unreachable object on the ones
 * that do not. A digest sidesteps every one of those, is the same length
 * everywhere, and is stable across restarts -- which is what recovery needs.
 * The original ids are written INSIDE the state document, because that is what
 * a person reads.
 *
 * AND A KEY IS NOT A LOCATOR. What gets persisted as a segment's
 * `archiveReference` is the key alone: no endpoint, no bucket, no region, no
 * credential, no `s3://` URL. Those are deployment facts that change when a
 * provider changes, they leak the shape of the infrastructure to anybody who
 * reads a state document, and an `s3://bucket/key` in a database is a
 * migration hazard the day the bucket is renamed. The reference is opaque and
 * canonical; where the bucket is, is the store's business.
 *
 * NO PROVIDER NAME APPEARS ANYWHERE IN THIS FILE. The layout is ordinary
 * object-store shape -- prefixes and keys -- and works identically on AWS S3,
 * Contabo, MinIO and anything else that speaks the same protocol.
 */

import { createHash } from 'node:crypto';

/** The prefix under which every run lives. */
export const REPLAY_RUNS_PREFIX = 'runs';
/** The prefix under which "this run keeps no replay" markers live. */
export const REPLAY_DECLINED_PREFIX = 'declined';

/** A stable, opaque, key-safe name for one logical id. */
export function replayObjectDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The prefix owned by one run. Everything of that run's is under it. */
export function replayRunPrefix(runId: string): string {
  return `${REPLAY_RUNS_PREFIX}/${replayObjectDigest(runId)}`;
}

/**
 * How many digits a state generation is padded to.
 *
 * LEXICOGRAPHIC ORDER MUST EQUAL NUMERIC ORDER. Object stores list keys as
 * strings, so `10` sorts before `9` unless the width is fixed -- and the
 * highest generation is how recovery finds the current state. Ten digits is
 * more state writes than a recording will ever take and costs nothing.
 */
const GENERATION_DIGITS = 10;

export function replayStateGenerationKey(runId: string, generation: number): string {
  return `${replayRunPrefix(runId)}/state/${String(generation).padStart(GENERATION_DIGITS, '0')}.json`;
}

/** The generation a state key names, or null when it is not one of ours. */
export function replayStateGenerationOf(key: string): number | null {
  const match = /\/state\/(\d{10})\.json$/u.exec(key);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function replayStatePrefix(runId: string): string {
  return `${replayRunPrefix(runId)}/state/`;
}

/**
 * THE one key a given encoder generation's initialisation material may occupy.
 *
 * Derived from the run and the generation -- neither of which comes from the
 * metadata being checked -- so a persisted reference stops being a way to
 * CHOOSE an object and becomes merely a claim that can be compared.
 */
export function replayInitialisationKey(runId: string, generation: number): string {
  return `${replayRunPrefix(runId)}/init/g${String(generation)}.bin`;
}

/** THE one key a given fragment may occupy. */
export function replaySegmentKey(runId: string, segmentId: string): string {
  return `${replayRunPrefix(runId)}/media/${replayObjectDigest(segmentId)}.bin`;
}

export function replayMediaPrefix(runId: string): string {
  return `${replayRunPrefix(runId)}/media/`;
}

export function replayInitialisationPrefix(runId: string): string {
  return `${replayRunPrefix(runId)}/init/`;
}

export function replayDeclinedKey(runId: string): string {
  return `${REPLAY_DECLINED_PREFIX}/${replayObjectDigest(runId)}.json`;
}

/**
 * Whether a persisted reference is a key this layout could have produced.
 *
 * A CHEAP GUARD, NOT THE BINDING. The real protection is comparing a reference
 * against the canonical key derived from the authorised identity, which is what
 * the archive and delivery both do. This catches the coarser thing: a reference
 * that is a URL, an absolute path, or anything else that would mean somebody
 * had put a LOCATOR where a key belongs -- including one carrying credentials.
 */
export function isReplayObjectKey(reference: string): boolean {
  if (reference.length === 0 || reference.length > 512) return false;
  if (reference.includes('://')) return false;
  if (reference.startsWith('/') || reference.includes('..')) return false;
  return /^[A-Za-z0-9/._-]+$/u.test(reference);
}
