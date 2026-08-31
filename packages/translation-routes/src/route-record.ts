/** @author masterzee001 */
/**
 * WHAT A TRANSLATION ROUTE IS, AND WHY IT IS DIRECTIONAL.
 *
 * A route is one SOURCE language translated into one TARGET language by one
 * model. `en->yo` and `yo->en` are two records, never one row with a pair of
 * languages in it, because they are two different pieces of evidence. A model
 * that renders English into Yoruba has demonstrated nothing whatsoever about
 * rendering Yoruba into English: different training data, different failure
 * modes, and -- the reason this repository keeps being bitten -- different
 * people qualified to tell you it is wrong. The 2026-08-26 finding that general
 * vendors answer Yoruba, Hausa and Igbo with HTTP 200 and confident, wrong
 * output is the whole reason a status code cannot promote anything here.
 *
 * WHAT THIS REGISTRY DECIDES: whether a route MAY RUN in production, for a
 * named service. That is all.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE: whether the user can afford it. The
 * CTO ruled those apart on 2026-08-30 and the separation is load-bearing, not
 * tidiness. Permission and allowance fail for different reasons, are owned by
 * different people, and change on different clocks: a licence review closing
 * must not touch anybody's balance, and a balance running out must not read as
 * "this language is not approved". So there is no price, no credit, no tariff
 * and no currency anywhere in this package, and `no-billing.test.ts` fails the
 * build if one appears -- including inside a JSON document, where a field can
 * arrive without a code review.
 *
 * THERE IS NO GLOBAL SWITCH. Nothing here turns OPUS-MT, or any other engine,
 * "on". Approval is per record, and a record is one direction for one service
 * scope. An engine-wide or provider-wide flag is precisely the mechanism that
 * would let en->es evidence carry en->yo into production, which is the defect
 * this package exists to make impossible.
 */

/** Where the model runs. `local` is our own hardware; `cloud` is a vendor. */
export type ExecutionClass = 'local' | 'cloud';

/**
 * The services that may invoke a translation. The SAME route may be approved
 * for one and refused for another, and usually should be: messaging is text a
 * reader can re-read and challenge, while `call-live` puts a synthetic voice in
 * somebody's ear in real time with nothing to check it against.
 */
export type ServiceScope = 'messaging' | 'programme-live' | 'call-live';

export const SERVICE_SCOPES: readonly ServiceScope[] = [
  'messaging',
  'programme-live',
  'call-live',
];

/**
 * `unapproved` is "not yet"; `refused` is "decided against". They behave
 * identically at the gate and differ in what a human should do next, which is
 * worth keeping distinguishable in the document.
 */
export type ScopeApproval = 'approved' | 'unapproved' | 'refused';

export type HumanReviewStatus =
  | 'not-required'
  | 'required-not-done'
  | 'passed'
  | 'failed';

export type CommercialUse = 'permitted' | 'restricted' | 'unknown';

/** Latency of the route as measured, in milliseconds. */
export interface LatencyProfile {
  min: number;
  median: number;
  mean: number;
  max: number;
}

/**
 * Measurement, and nothing more. Availability and latency are all a benchmark
 * can establish; whether the output is CORRECT is `humanReviewStatus`, which is
 * a separate field on purpose so that no amount of green here can be mistaken
 * for it.
 */
export interface TechnicalEvidence {
  sampleCount: number;
  successRate: number;
  latencyMs: LatencyProfile;
  recordedAt: string;
  notes?: string;
}

export interface LicenceStatus {
  licence: string;
  commercialUse: CommercialUse;
  evidence: string;
}

/** One direction, one model, one set of per-service decisions. */
export interface TranslationRouteRecord {
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  modelId: string;
  executionClass: ExecutionClass;
  productionApproved: boolean;
  technicalEvidence: TechnicalEvidence | null;
  humanReviewStatus: HumanReviewStatus;
  licenceStatus: LicenceStatus;
  serviceScopes: Record<ServiceScope, ScopeApproval>;
}

/**
 * Languages for which a human listener/reader is MANDATORY before any scope may
 * be approved -- both in validation, which refuses the document, and at the
 * gate, which refuses the call. Configurable because the list will grow; seeded
 * with the four Nigerian languages that produced the finding.
 */
export const DEFAULT_REVIEW_REQUIRED_LANGUAGES: readonly string[] = [
  'yo',
  'ha',
  'ig',
  'pcm',
];

/**
 * The provider name a seeded direction carries when NO model in this repository
 * covers it. It is a written-down gap rather than a plausible-looking guess,
 * and validation refuses to approve one, so the gap cannot be closed by
 * accident -- only by naming a real model.
 */
export const UNASSIGNED_PROVIDER = 'unassigned';

/** Case-folded, whitespace-trimmed. Never widens a lookup to a neighbour. */
export function normaliseLanguageTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** The map key for one direction. Ordered: source first, target second. */
export function directionKey(sourceLanguage: string, targetLanguage: string): string {
  return `${normaliseLanguageTag(sourceLanguage)}->${normaliseLanguageTag(targetLanguage)}`;
}

export function isServiceScope(value: unknown): value is ServiceScope {
  return typeof value === 'string' && (SERVICE_SCOPES as readonly string[]).includes(value);
}
