/** @author masterzee001 */
/**
 * One programme session consumes ONE vocabulary revision.
 *
 * THE PROBLEM THIS PREVENTS. Vocabulary feeds two consumers that acquire it at
 * different moments: the recogniser takes keyterms when its session opens, and
 * the translation gate takes protected terms per sentence. Without a snapshot,
 * an operator editing a term mid-programme leaves the gate on revision 18 while
 * the open Deepgram session is still on 17 -- one programme, internally
 * inconsistent, and nothing anywhere reports it. A name would be protected in
 * translation and unheard by the recogniser, which looks like a model failure
 * and is not.
 *
 * So a session takes a SNAPSHOT: programme, revision, and every consumer's
 * configuration resolved together from the same rows. Consumers read the
 * snapshot, never the store.
 *
 * EDITS APPLY TO THE NEXT SESSION. Not to one that is already running. Live
 * re-acquisition is not safely supported by every consumer -- an open
 * recogniser session cannot take new keyterms -- and pretending otherwise is
 * how "I changed it and nothing happened" becomes a support ticket nobody can
 * reproduce. The operator UI must say when a change takes effect, and
 * `appliesFrom` below is what it says it from.
 */

import {
  normaliseKeyterms,
  resolveConsumption,
  type ConsumptionCapabilities,
  type VocabularyConsumption,
} from './index.js';
import type { VocabularyPort, VocabularyRecord } from './store.js';

/**
 * Which language each consumer is actually working in.
 *
 * SOURCE AND TARGET ARE DIFFERENT QUESTIONS and conflating them sends a
 * Portuguese rendering into English recognition merely because both belong to
 * one programme. The recogniser hears the SOURCE; canonical renderings and
 * pronunciation apply to the TARGET; do-not-translate is about a direction.
 */
export interface SessionLanguages {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface VocabularySnapshot {
  readonly programmeId: string;
  readonly revision: number;
  readonly takenAt: string;
  readonly languages: SessionLanguages;
  /** Terms the recogniser receives. Resolved against the SOURCE language. */
  readonly sttKeyterms: readonly string[];
  /** Terms the gate protects for this direction. */
  readonly doNotTranslate: readonly string[];
  /** Agreed spellings for the TARGET language. */
  readonly canonical: ReadonlyMap<string, string>;
  /** Hints for the TARGET voice. */
  readonly pronunciation: ReadonlyMap<string, string>;
  /** Set and read by nothing on this deployment. */
  readonly unconsumed: readonly string[];
}

export interface RevisionedVocabularyPort extends VocabularyPort {
  /** Monotonic per programme. Incremented by every mutation. */
  revision(programmeId: string): Promise<number>;
  /** The atomic read. See VocabularySnapshotSource. */
  snapshotRead(programmeId: string): Promise<{
    revision: number;
    entries: readonly VocabularyRecord[];
  }>;
}

/**
 * ONE ATOMIC READ. Not a revision plus a list.
 *
 * An earlier revision of this file declared this as `{ revision, list }` on the
 * reasoning that those are the smallest operations `takeSnapshot` uses. That
 * was wrong, and it reopened a race the durable port had already been built to
 * close: two independent reads let a writer commit between them, producing
 * revision N paired with rows from N+1 -- a snapshot whose number is a lie
 * about its own contents, and nothing anywhere reports it.
 *
 * The smallest thing this needs is not the smallest set of CALLS, it is the
 * smallest COHERENT read. Postgres provides it with a transaction and FOR
 * SHARE; the in-memory port provides it by construction. Neither is weakened to
 * match the other.
 */
export interface VocabularySnapshotSource {
  snapshotRead(programmeId: string): Promise<{
    revision: number;
    entries: readonly VocabularyRecord[];
  }>;
}

/**
 * Just the number, for asking whether a running session is stale.
 *
 * Separate because that question genuinely needs one value and no rows, and
 * requiring the atomic read for it would push callers toward the wider
 * interface for no gain.
 */
export interface RevisionSource {
  revision(programmeId: string): Promise<number>;
}

/**
 * Take the snapshot a session will use for its whole life.
 *
 * Resolved ONCE, from one read, so every consumer is on the same revision by
 * construction rather than by everybody remembering to re-read at the same
 * moment.
 */
export async function takeSnapshot(
  port: VocabularySnapshotSource,
  programmeId: string,
  languages: SessionLanguages,
  capabilities: ConsumptionCapabilities,
  now: () => Date = () => new Date(),
): Promise<VocabularySnapshot> {
  if (programmeId.trim() === '') {
    throw new Error('takeSnapshot requires a programmeId');
  }
  // EXACTLY ONE CALL. The revision and the rows come from the same read, so
  // there is no window in which a writer can commit between them.
  const { revision, entries: rows } = await port.snapshotRead(programmeId);

  // Resolved TWICE against the same rows, because the two sides of a session
  // are different languages. One call cannot answer both.
  const forSource = resolveConsumption(rows, languages.sourceLanguage, capabilities);
  const forTarget = resolveConsumption(rows, languages.targetLanguage, capabilities);

  return {
    programmeId,
    revision,
    takenAt: now().toISOString(),
    languages,
    // The recogniser hears the source. A term tagged only for the target
    // language has no business being offered to it. Bounded here, so every
    // consumer of a snapshot receives a list a provider will actually accept.
    sttKeyterms: normaliseKeyterms(forSource.sttKeyterms),
    // Protection spans the direction: a name must survive whether it appears
    // in the source or is expected in the output.
    doNotTranslate: [...new Set([...forSource.doNotTranslate, ...forTarget.doNotTranslate])],
    canonical: forTarget.canonical,
    pronunciation: forTarget.pronunciation,
    unconsumed: [...new Set([...forSource.unconsumed, ...forTarget.unconsumed])],
  };
}

/**
 * Is a running session's snapshot still current?
 *
 * Used to TELL somebody, never to hot-swap: the answer drives a console line
 * that says an edit applies to the next session, not a silent re-acquisition
 * that half the consumers cannot perform.
 */
export async function snapshotIsCurrent(
  port: RevisionSource,
  snapshot: VocabularySnapshot,
): Promise<{ current: boolean; storedRevision: number; appliesFrom: 'this-session' | 'next-session' }> {
  const storedRevision = await port.revision(snapshot.programmeId);
  const current = storedRevision === snapshot.revision;
  return {
    current,
    storedRevision,
    appliesFrom: current ? 'this-session' : 'next-session',
  };
}

/** In-memory port with revisions, for tests and database-less deployments. */
export function createRevisionedInMemoryPort(
  seed: readonly VocabularyRecord[] = [],
): RevisionedVocabularyPort {
  const byProgramme = new Map<string, Map<string, VocabularyRecord>>();
  const revisions = new Map<string, number>();

  for (const record of seed) {
    const bucket = byProgramme.get(record.programmeId) ?? new Map();
    bucket.set(record.id, record);
    byProgramme.set(record.programmeId, bucket);
    revisions.set(record.programmeId, 1);
  }

  const bump = (programmeId: string): void => {
    revisions.set(programmeId, (revisions.get(programmeId) ?? 0) + 1);
  };

  return {
    async revision(programmeId) {
      if (programmeId.trim() === '') throw new Error('revision requires a programmeId');
      return revisions.get(programmeId) ?? 0;
    },
    async list(programmeId) {
      if (programmeId.trim() === '') throw new Error('list requires a programmeId');
      return [...(byProgramme.get(programmeId)?.values() ?? [])];
    },
    /*
     * Coherent BY CONSTRUCTION: both values are read synchronously, with no
     * await between them, so nothing can interleave. Implemented here rather
     * than composed from revision() and list() -- composing them would rebuild
     * the exact race this method exists to prevent.
     */
    async snapshotRead(programmeId) {
      if (programmeId.trim() === '') throw new Error('snapshotRead requires a programmeId');
      return {
        revision: revisions.get(programmeId) ?? 0,
        entries: [...(byProgramme.get(programmeId)?.values() ?? [])],
      };
    },
    async upsert(record) {
      const bucket = byProgramme.get(record.programmeId) ?? new Map();
      bucket.set(record.id, record);
      byProgramme.set(record.programmeId, bucket);
      bump(record.programmeId);
      return record;
    },
    async remove(programmeId, id) {
      const removed = byProgramme.get(programmeId)?.delete(id) ?? false;
      // Only a real change moves the revision. Bumping on a no-op delete would
      // tell every running session it is stale for nothing.
      if (removed) bump(programmeId);
      return removed;
    },
  };
}

/**
 * A short, stable identity for a snapshot, safe to put in a log line.
 *
 * Vocabulary is a broadcaster's own material and may be commercially
 * sensitive, so nothing may log its contents. An operator asking why a name
 * was misheard still needs to know WHICH vocabulary a session was running, so
 * diagnostics carry the programme, the revision, the count and this.
 *
 * FNV-1a rather than a cryptographic digest: this identifies, it does not
 * protect, and it must run unchanged in a browser console and a Node service.
 */
export function snapshotFingerprint(snapshot: {
  readonly programmeId: string;
  readonly revision: number;
  readonly sttKeyterms: readonly string[];
}): string {
  const material = `${snapshot.programmeId}|${snapshot.revision}|${snapshot.sttKeyterms.join('\u0000')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    // The FNV prime, by shifts, so the arithmetic stays in 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
