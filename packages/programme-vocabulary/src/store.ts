/** @author masterzee001 */
/**
 * Programme-scoped vocabulary storage.
 *
 * SCOPE IS A TENANT BOUNDARY, NOT A UI FILTER. A term entered for one
 * programme must never influence another, and "the console only shows you
 * yours" is a guarantee about a screen, not about the data.
 *
 * THE INVARIANT, stated precisely:
 *
 *     No application-level vocabulary read is permitted without an explicit,
 *     non-empty programme scope.
 *
 * An earlier version of this comment claimed there is "no single collection
 * holding everybody's terms". That describes the in-memory implementation and
 * would stop being true the moment this is backed by Postgres, where one table
 * naturally holds rows for every programme. The physical layout is not the
 * guarantee; the refusal to read without a scope is. Every method here takes a
 * programmeId, an empty one is refused rather than answered, and there is
 * deliberately no method that returns terms across programmes -- because an API
 * that CAN do that eventually will, from a path nobody reviewed.
 */

import {
  resolveConsumption,
  type ConsumptionCapabilities,
  type VocabularyConsumption,
  type VocabularyEntry,
} from './index.js';

export interface VocabularyRecord extends VocabularyEntry {
  /** The programme this term belongs to. Never optional, never inferred. */
  readonly programmeId: string;
  readonly updatedAt: string;
}

/**
 * The persistence seam. Postgres implements it in the account service; the
 * in-memory version below is for tests and for a deployment with no database.
 */
export interface VocabularyPort {
  list(programmeId: string): Promise<readonly VocabularyRecord[]>;
  upsert(record: VocabularyRecord): Promise<VocabularyRecord>;
  remove(programmeId: string, id: string): Promise<boolean>;
}

export function createInMemoryVocabularyPort(
  seed: readonly VocabularyRecord[] = [],
): VocabularyPort {
  // Keyed by programme FIRST, so a lookup cannot accidentally span programmes:
  // there is no single collection holding everybody's terms to read by mistake.
  const byProgramme = new Map<string, Map<string, VocabularyRecord>>();
  for (const record of seed) {
    const bucket = byProgramme.get(record.programmeId) ?? new Map();
    bucket.set(record.id, record);
    byProgramme.set(record.programmeId, bucket);
  }

  return {
    async list(programmeId) {
      return [...(byProgramme.get(programmeId)?.values() ?? [])];
    },
    async upsert(record) {
      const bucket = byProgramme.get(record.programmeId) ?? new Map();
      bucket.set(record.id, record);
      byProgramme.set(record.programmeId, bucket);
      return record;
    },
    async remove(programmeId, id) {
      return byProgramme.get(programmeId)?.delete(id) ?? false;
    },
  };
}

/**
 * What one programme's consumers should receive, for one language.
 *
 * The only way to obtain consumption. It takes a programmeId because there is
 * no correct answer without one.
 */
export async function consumptionForProgramme(
  port: VocabularyPort,
  programmeId: string,
  language: string,
  capabilities: ConsumptionCapabilities,
): Promise<VocabularyConsumption> {
  if (programmeId.trim() === '') {
    // An empty programme id is a caller bug, and answering it with "everything"
    // or "nothing" both hide it. Refusing names the mistake at the point it was
    // made rather than at the point somebody notices the wrong vocabulary.
    throw new Error('consumptionForProgramme requires a programmeId');
  }
  return resolveConsumption(await port.list(programmeId), language, capabilities);
}

/**
 * The observed state of one actionable field, for the console.
 *
 * `consumed` means something read it. `unsupported` means this deployment's
 * provider has no such mechanism. `unconsumed` means it was stored and nothing
 * reads it. There is deliberately no `active`: a saved record is not an effect,
 * and a console that says "active" because a write succeeded is telling the
 * operator something nobody verified.
 */
export type ConsumerState = 'consumed' | 'unconsumed' | 'unsupported';

export interface FieldStates {
  readonly doNotTranslate: ConsumerState;
  readonly canonicalRendering: ConsumerState;
  readonly sttKeyterm: ConsumerState;
  readonly pronunciationHint: ConsumerState;
}

export function describeFieldStates(
  entry: VocabularyEntry,
  capabilities: ConsumptionCapabilities,
): FieldStates {
  const set = (used: boolean, supported: boolean): ConsumerState =>
    !used ? 'unconsumed' : supported ? 'consumed' : 'unsupported';

  return {
    // Translation protection is implemented in the gate on every deployment,
    // so a term marked do-not-translate is genuinely consumed wherever
    // translation runs at all.
    doNotTranslate: set(entry.doNotTranslate && entry.enabled, true),
    canonicalRendering: set(
      entry.canonicalRendering.trim() !== '' && entry.enabled, true),
    sttKeyterm: set(entry.sttKeyterm && entry.enabled, capabilities.sttKeyterms),
    pronunciationHint: set(
      entry.pronunciationHint.trim() !== '' && entry.enabled,
      capabilities.pronunciationHints),
  };
}
