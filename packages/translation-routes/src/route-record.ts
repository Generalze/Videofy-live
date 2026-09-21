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

/**
 * What a human review actually established, when one has been done.
 *
 * The enum above says WHETHER somebody judged this route. This says what they
 * judged, and it is a separate field because a verdict without its subject is
 * not evidence: a model version and a corpus hash are what make a
 * qualification checkable later, and what make a STALE one visible instead of
 * inherited when either moves on.
 *
 * The shape matches `ReviewEvidence` in `@videofy-live/programme-quality`
 * without importing it. This package builds before that one, so a dependency
 * would be a reordering; the mapping lives at the one place that consumes
 * both, and a structural mismatch there is a compiler error rather than a
 * silent divergence.
 */
export interface RouteReviewEvidence {
  engine: string;
  /**
   * The model the reviewer actually read the output of. Must equal the record's
   * `modelId`: a review of one model says nothing about another, and until
   * 2026-09-21 this field was collected, stored and compared to nothing, so a
   * block naming `opus-mt-en-fr` could approve `en->yo`. validate.ts refuses
   * the mismatch now.
   */
  model: string;
  modelVersion: string;
  /** Which corpus, by content hash. A renamed corpus is not a new one. */
  corpusHash: string;
  corpusVersion: string;
  /** Who is accountable for the judgement. A person or a named process. */
  evaluator: string;
  assessedAt: string;
  method: string;
  /** The score, on the scale its method defines. */
  score: number;
  scale: string;
  /**
   * THE SCALE AS NUMBERS, because prose cannot be checked.
   *
   * `scale` says what was counted; these two say what the count means, so a
   * validator can tell a pass from a failure without reading English. The
   * convention is fixed and one-directional: the floor is 0, HIGHER IS BETTER,
   * and `scaleMaximum` is the best attainable score. A method whose natural
   * scale runs the other way (errors per hundred words) records its complement
   * and says so in `method`.
   *
   * Before these existed, `--review-score 0 --review-scale "materially correct
   * out of 8"` recorded a review that scored ZERO as PASSED and switched
   * translation on for real users.
   */
  scaleMaximum: number;
  /** The score at or above which THIS method calls the output usable. */
  passThreshold: number;
  /** Where the working is kept: a document, a run id, a ticket. */
  evidenceReference: string;
}

/**
 * WHO APPROVED THIS ROUTE, AS A FIELD.
 *
 * The audit line in `document.note` is prose: optional, free-text, and one
 * `delete` away from an approval nobody signed. A reviewer demonstrated exactly
 * that -- the approver's name removed, the approval still live, every gate and
 * report silent. So provenance is recorded here as well, structurally, and
 * validate.ts refuses a record that has an approved scope and no `approval`.
 *
 * `scopes` is what the recorded act opened. It is allowed to name scopes that
 * have since been withdrawn: this is the record of a decision, not a grant, and
 * the grant is `serviceScopes`.
 */
export interface RouteApprovalRecord {
  approvedBy: string;
  approvedAt: string;
  scopes: readonly ServiceScope[];
}

/**
 * A REVIEW THAT WAS SUPERSEDED, KEPT RATHER THAN OVERWRITTEN.
 *
 * `humanReviewStatus` and `reviewEvidence` are one slot, and a promotion used
 * to overwrite both, so a named speaker of the language recording `failed`
 * could be erased by the next person to run the command -- verdict, score,
 * evidence reference and all. Somebody has to be able to read later that a
 * speaker said no and who decided otherwise, so the old block moves here
 * instead of being replaced.
 */
export interface SupersededReview {
  /** The status this evidence was recorded under: usually `failed`. */
  status: HumanReviewStatus;
  supersededAt: string;
  supersededBy: string;
  reason: string;
  /** The block itself, when the record carried one. */
  evidence?: RouteReviewEvidence;
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
  /**
   * What that review established, when it has been done.
   *
   * Optional because most routes have not been reviewed and saying so is the
   * honest state. Absent means UNASSESSED wherever it is read -- never
   * "passed by default", which is the one reading that could put an
   * unreviewed language to air.
   */
  reviewEvidence?: RouteReviewEvidence;
  /**
   * Reviews this record used to carry, oldest first. Append-only in practice:
   * nothing in this package removes an entry.
   */
  reviewHistory?: readonly SupersededReview[];
  /** Who approved this route, when, and for what. Required once a scope is. */
  approval?: RouteApprovalRecord;
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
