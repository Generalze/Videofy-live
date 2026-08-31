/** @author masterzee001 */
/**
 * WHICH ROUTES MESSAGING MAY TRANSLATE ON -- the founder's ruling of
 * 30 Aug 2026, expressed as a decision this service can make before it
 * spends a single provider call.
 *
 * OPUS-MT IS THE PRIMARY TRANSLATOR FOR ORDINARY TEXT MESSAGING wherever an
 * APPROVED route exists. Four rules, in order, and no fifth:
 *
 *  1. SAME LANGUAGE BYPASSES TRANSLATION ENTIRELY. No provider call, no
 *     chargeable translation event, nothing to be honest about. Two people
 *     writing the same language are not using a translation product.
 *  2. AN APPROVED ROUTE TRANSLATES LOCALLY. Approved means the registry says
 *     so for THIS direction and THIS service scope -- en->yo is not yo->en,
 *     and a route approved for messaging is not thereby approved for the
 *     live programme or call paths.
 *  3. A MISSING, REFUSED OR FAILING ROUTE DELIVERS THE ORIGINAL and says
 *     translation is unavailable. Honestly: `unavailable` with a reason, not
 *     silence, and never invented words.
 *  4. NO AUTOMATIC PAID CLOUD FALLBACK. A `cloud` execution class is never
 *     selected automatically here, however approved it may be for other
 *     purposes; a route this path may take is a LOCAL one. Nothing in this
 *     file may reach a vendor, and nothing downstream of it may be reached
 *     without a decision from here.
 *
 * THE REGISTRY IS AUTHORITATIVE, NOT THIS FILE. The record type and the gate
 * both come from `@videofy-live/translation-routes`; nothing here re-states
 * what a record IS, because a second copy of a contract is worse than no copy
 * -- it compiles while it drifts. What this file adds is the three rules that
 * belong to MESSAGING and to nowhere else: the same-language bypass, OPUS-MT
 * first among approved routes, and no automatic cloud route. Those cannot
 * live in the registry, because the registry answers the same question for
 * the live programme and live calls, which are ruled on separately.
 */

import {
  normaliseLanguageTag,
  type TranslationRouteRecord,
} from '@videofy-live/translation-routes';

export type { TranslationRouteRecord };

/**
 * The one seam the messaging path has onto the registry. Deliberately a
 * single question -- "what records exist for this DIRECTION" -- so that the
 * approval rules live here, in one auditable function, rather than being
 * re-derived by whoever implements the store.
 */
export interface TranslationRouteRegistry {
  routesFor(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<readonly TranslationRouteRecord[]> | readonly TranslationRouteRecord[];
}

/** The founder's primary translator for ordinary text messaging. */
export const PRIMARY_MESSAGING_PROVIDER = 'opus-mt';

/** Why a message is going out untranslated. Reported, never guessed at. */
export type MessagingRouteUnavailableReason =
  /** The reader has told us no language to hear. */
  | 'no-target-language'
  /** The registry holds no record for this direction at all. */
  | 'no-route'
  /** A record exists and messaging is explicitly REFUSED on it. */
  | 'refused'
  /** Records exist but none is approved for messaging in production. */
  | 'unapproved'
  /** The only approved routes are cloud ones; rule 4 forbids taking them here. */
  | 'cloud-only';

export type MessagingRouteDecision =
  | { readonly kind: 'bypass' }
  | {
      readonly kind: 'approved';
      readonly provider: string;
      readonly modelId: string;
      readonly executionClass: 'local';
    }
  | { readonly kind: 'unavailable'; readonly reason: MessagingRouteUnavailableReason };

/**
 * Approved FOR MESSAGING, IN PRODUCTION, LOCALLY. Every clause is a separate
 * refusal an auditor can point at:
 *
 *  - the direction must match exactly (en->yo never stands in for yo->en);
 *  - `serviceScopes.messaging` must say `approved` -- a route approved for
 *    the live programme is not approved here;
 *  - `productionApproved` must be true;
 *  - there must be technical evidence AT ALL, and it must record at least one
 *    sample with a non-zero success rate: an empty record is not evidence;
 *  - human review must not be outstanding or failed;
 *  - the licence must permit commercial use -- CC-BY-NC weights are exactly
 *    the trap this clause exists for;
 *  - the execution class must be local (rule 4).
 */
export function isApprovedForMessaging(
  record: TranslationRouteRecord,
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
  if (!matchesDirection(record, sourceLanguage, targetLanguage)) return false;
  if (record.serviceScopes.messaging !== 'approved') return false;
  if (record.productionApproved !== true) return false;
  if (record.executionClass !== 'local') return false;
  if (record.humanReviewStatus === 'failed') return false;
  if (record.humanReviewStatus === 'required-not-done') return false;
  if (record.licenceStatus.commercialUse !== 'permitted') return false;
  const evidence = record.technicalEvidence;
  if (evidence === null) return false;
  if (!(evidence.sampleCount > 0)) return false;
  if (!(evidence.successRate > 0)) return false;
  return true;
}

/**
 * SAME LANGUAGE TAG, SAME ANSWER. The registry folds case and trims when it
 * keys a direction, and account language preferences are typed by people and
 * migrated by scripts; comparing raw strings here would turn `EN` into an
 * unknown direction and quietly refuse a route that is approved. The registry
 * package's own normaliser is used so there is exactly one rule about what
 * counts as the same language.
 */
function matchesDirection(
  record: TranslationRouteRecord,
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
  return (
    normaliseLanguageTag(record.sourceLanguage) === normaliseLanguageTag(sourceLanguage) &&
    normaliseLanguageTag(record.targetLanguage) === normaliseLanguageTag(targetLanguage)
  );
}

/**
 * OPUS-MT FIRST, then the best-evidenced of whatever else is approved.
 * Deterministic to the last tiebreak: a route chosen differently on two
 * boxes is a route nobody can certify.
 */
function preferPrimary(a: TranslationRouteRecord, b: TranslationRouteRecord): number {
  const aPrimary = a.provider === PRIMARY_MESSAGING_PROVIDER ? 0 : 1;
  const bPrimary = b.provider === PRIMARY_MESSAGING_PROVIDER ? 0 : 1;
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;
  const aRate = a.technicalEvidence?.successRate ?? 0;
  const bRate = b.technicalEvidence?.successRate ?? 0;
  if (aRate !== bRate) return bRate - aRate;
  const aLatency = a.technicalEvidence?.latencyMs.median ?? Number.POSITIVE_INFINITY;
  const bLatency = b.technicalEvidence?.latencyMs.median ?? Number.POSITIVE_INFINITY;
  if (aLatency !== bLatency) return aLatency - bLatency;
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

/**
 * The whole ruling in one pure function: languages and records in, a verdict
 * out. No I/O, no clock, no vendor -- so the rules can be pinned by tests
 * that cannot pass for the wrong reason.
 */
export function decideMessagingRoute(input: {
  readonly sourceLanguage: string;
  readonly targetLanguage: string | null;
  readonly records: readonly TranslationRouteRecord[];
}): MessagingRouteDecision {
  const { sourceLanguage, targetLanguage, records } = input;
  if (targetLanguage === null || targetLanguage.length === 0) {
    return { kind: 'unavailable', reason: 'no-target-language' };
  }
  // RULE 1, and it is checked before anything else can spend a call.
  if (normaliseLanguageTag(targetLanguage) === normaliseLanguageTag(sourceLanguage)) {
    return { kind: 'bypass' };
  }

  const forDirection = records.filter((record) =>
    matchesDirection(record, sourceLanguage, targetLanguage),
  );
  if (forDirection.length === 0) return { kind: 'unavailable', reason: 'no-route' };

  const approved = forDirection
    .filter((record) => isApprovedForMessaging(record, sourceLanguage, targetLanguage))
    .sort(preferPrimary);
  const chosen = approved[0];
  if (chosen !== undefined) {
    return {
      kind: 'approved',
      provider: chosen.provider,
      modelId: chosen.modelId,
      executionClass: 'local',
    };
  }

  /*
   * Nothing approved -- so WHY, precisely. A refusal is the loudest fact and
   * is reported first; a cloud-only approval is reported as such so nobody
   * later reads "unapproved" and goes looking for evidence that exists.
   */
  if (forDirection.some((record) => record.serviceScopes.messaging === 'refused')) {
    return { kind: 'unavailable', reason: 'refused' };
  }
  const cloudOnly = forDirection.some(
    (record) =>
      record.executionClass === 'cloud' &&
      record.serviceScopes.messaging === 'approved' &&
      record.productionApproved,
  );
  return { kind: 'unavailable', reason: cloudOnly ? 'cloud-only' : 'unapproved' };
}

/**
 * The adapter for a fixed list of records -- used by tests, and the
 * fail-closed answer when no document could be loaded. Given no records it
 * approves nothing, which is the correct answer to "may production invoke
 * this route" when no registry has spoken.
 */
export function createTranslationRouteRegistryFromRecords(
  records: readonly TranslationRouteRecord[],
): TranslationRouteRegistry {
  return {
    routesFor: (sourceLanguage, targetLanguage) =>
      records.filter((record) => matchesDirection(record, sourceLanguage, targetLanguage)),
  };
}

/**
 * The authoritative gate, as much of it as messaging needs. Structural rather
 * than an import so this policy compiles and is testable without the registry
 * package's build; the shape is the package's `mayTranslate`.
 */
export interface TranslationRouteGate {
  mayTranslate(
    sourceLanguage: string,
    targetLanguage: string,
    scope: 'messaging' | 'programme-live' | 'call-live',
  ):
    | { readonly allowed: true; readonly route: TranslationRouteRecord }
    | { readonly allowed: false; readonly route: TranslationRouteRecord | null };
}

/**
 * THE INTEGRATION SEAM. The registry decides approval; this file decides the
 * MESSAGING-ONLY rules on top of it -- the same-language bypass, OPUS-MT
 * first, and no automatic cloud route. The gate is asked about the
 * `messaging` scope and nothing else, so a route approved for the live
 * programme or a live call can never arrive here as an approval.
 *
 * Refusals hand back the record they consulted, where there is one, so the
 * policy can say `refused` rather than flatten every refusal into "no route".
 * An unknown direction has no record and stays unknown: nothing is widened,
 * substituted, or guessed.
 */
export function createTranslationRouteRegistryFromGate(
  gate: TranslationRouteGate,
): TranslationRouteRegistry {
  return {
    routesFor: (sourceLanguage, targetLanguage) => {
      const decision = gate.mayTranslate(sourceLanguage, targetLanguage, 'messaging');
      if (decision.allowed) return [decision.route];
      return decision.route === null ? [] : [decision.route];
    },
  };
}
