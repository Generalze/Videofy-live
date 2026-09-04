/** @author masterzee001 */
/**
 * The document is READ, never trusted.
 *
 * Evidence is promoted into this registry by editing a JSON document, which is
 * the point -- a measured route becomes invocable without a code change or a
 * release. The cost of that convenience is that the file is edited by whoever
 * ran the measurement, at the moment they are most convinced, with no compiler
 * between them and production. So every rule the registry relies on is checked
 * here, and a document that breaks one is REFUSED WHOLE. There is no partial
 * load: dropping the bad record and keeping the rest would mean a typo in one
 * direction silently changes which directions are live, while the operator sees
 * a registry that loaded successfully.
 *
 * The refusals that matter, each with a real incident behind it:
 *
 *   PRODUCTION-APPROVED WITH NULL EVIDENCE. Approving a route nobody measured.
 *
 *   A SCOPE APPROVED WHILE HUMAN REVIEW IS OUTSTANDING, for a language on the
 *   review-required list. Yoruba, Hausa and Igbo came back HTTP 200 with wrong
 *   pronunciation; every server-side signal said fine. Machines cannot clear
 *   this and are not allowed to try.
 *
 *   PRODUCTION-APPROVED WITHOUT A PERMISSIVE LICENCE. NLLB-200 is CC-BY-NC-4.0
 *   and covers more languages than anything else here. Breadth we may not sell
 *   must not be one careless edit away from being sold.
 *
 *   A SCOPE APPROVED ON A ROUTE THAT IS NOT PRODUCTION-APPROVED. The scopes
 *   NARROW production approval; they cannot grant it. Otherwise `call-live`
 *   becomes a second, quieter way to say yes.
 *
 *   ANY BILLING FIELD AT ALL. See route-record.ts: allowance is a different
 *   system, and a `price` that arrives in a JSON document arrives without a
 *   reviewer.
 *
 *   THE SAME DIRECTION TWICE. Two records for `en->yo` mean the answer depends
 *   on iteration order, which is the kind of thing that is right in the tests
 *   and wrong in production.
 */
import {
  DEFAULT_REVIEW_REQUIRED_LANGUAGES,
  SERVICE_SCOPES,
  UNASSIGNED_PROVIDER,
  directionKey,
  normaliseLanguageTag,
  type CommercialUse,
  type ExecutionClass,
  type HumanReviewStatus,
  type LicenceStatus,
  type ScopeApproval,
  type ServiceScope,
  type TechnicalEvidence,
  type TranslationRouteRecord,
} from './route-record.js';

export interface DocumentProblem {
  /** Where in the document, e.g. `routes[3].serviceScopes.call-live`. */
  path: string;
  message: string;
}

export interface RouteDocument {
  version: number;
  author?: string;
  note?: string;
  reviewRequiredLanguages?: readonly string[];
  routes: readonly TranslationRouteRecord[];
}

export type DocumentParse =
  | { ok: true; document: RouteDocument; reviewRequiredLanguages: readonly string[] }
  | { ok: false; problems: readonly DocumentProblem[] };

export interface ParseOptions {
  /**
   * Overrides the list in the document. Provided so a deployment can be
   * STRICTER than the file it was handed. The two lists are not unioned and
   * not merged: an operator who wants FEWER mandatory reviews has to say so in
   * the document, in the open, where it is reviewable.
   */
  reviewRequiredLanguages?: readonly string[];
}

const RECORD_FIELDS = [
  'sourceLanguage',
  'targetLanguage',
  'provider',
  'modelId',
  'executionClass',
  'productionApproved',
  'technicalEvidence',
  'humanReviewStatus',
  'licenceStatus',
  'serviceScopes',
] as const;

const DOCUMENT_FIELDS = [
  'version',
  'author',
  'note',
  'reviewRequiredLanguages',
  'routes',
] as const;

const EVIDENCE_FIELDS = ['sampleCount', 'successRate', 'latencyMs', 'recordedAt', 'notes'];
const LATENCY_FIELDS = ['min', 'median', 'mean', 'max'];
const LICENCE_FIELDS = ['licence', 'commercialUse', 'evidence'];

const EXECUTION_CLASSES: readonly ExecutionClass[] = ['local', 'cloud'];
const HUMAN_REVIEW_STATUSES: readonly HumanReviewStatus[] = [
  'not-required',
  'required-not-done',
  'passed',
  'failed',
];
const SCOPE_APPROVALS: readonly ScopeApproval[] = ['approved', 'unapproved', 'refused'];
const COMMERCIAL_USES: readonly CommercialUse[] = ['permitted', 'restricted', 'unknown'];

/**
 * Vocabulary that must never appear as a FIELD NAME. Matched on the key only,
 * so a licence string that mentions commercial terms is untouched while a
 * `pricePerSecond` field is refused.
 */
const BILLING_VOCABULARY =
  /price|pricing|cost|credit|billing|billable|tariff|currency|charge|invoice|balance|quota|unitsper/i;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

class ProblemLog {
  readonly problems: DocumentProblem[] = [];

  add(path: string, message: string): void {
    this.problems.push({ path, message });
  }

  /** A billing field anywhere is refused at the point it is seen. */
  rejectBillingFields(path: string, value: Record<string, unknown>): void {
    const prefix = path === '' ? '' : `${path}.`;
    for (const key of Object.keys(value)) {
      if (BILLING_VOCABULARY.test(key)) {
        this.add(
          `${prefix}${key}`,
          'billing belongs to the credit system, not the route registry; this registry ' +
            'decides WHETHER a route may run, never whether anybody has paid for it',
        );
      }
    }
  }
}

function parseEvidence(log: ProblemLog, path: string, value: unknown): TechnicalEvidence | null {
  if (value === null) return null;
  if (!isRecordObject(value)) {
    log.add(path, 'must be an object or null');
    return null;
  }
  log.rejectBillingFields(path, value);
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_FIELDS.includes(key)) log.add(`${path}.${key}`, 'unknown field');
  }

  const sampleCount = value['sampleCount'];
  const successRate = value['successRate'];
  const latencyMs = value['latencyMs'];
  const recordedAt = value['recordedAt'];
  const notes = value['notes'];
  let sound = true;

  if (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount < 1) {
    log.add(`${path}.sampleCount`, 'must be an integer of at least 1');
    sound = false;
  }
  if (!isFiniteNumber(successRate) || successRate < 0 || successRate > 1) {
    log.add(`${path}.successRate`, 'must be a fraction between 0 and 1 inclusive');
    sound = false;
  }
  if (!isNonEmptyString(recordedAt) || Number.isNaN(Date.parse(recordedAt))) {
    log.add(`${path}.recordedAt`, 'must be an ISO-8601 timestamp');
    sound = false;
  }
  if (notes !== undefined && !isNonEmptyString(notes)) {
    log.add(`${path}.notes`, 'when present must be a non-empty string');
    sound = false;
  }

  let latency: TechnicalEvidence['latencyMs'] | undefined;
  if (!isRecordObject(latencyMs)) {
    log.add(`${path}.latencyMs`, 'must be an object with min, median, mean and max');
    sound = false;
  } else {
    for (const key of Object.keys(latencyMs)) {
      if (!LATENCY_FIELDS.includes(key)) {
        log.add(`${path}.latencyMs.${key}`, 'unknown field');
        sound = false;
      }
    }
    const min = latencyMs['min'];
    const median = latencyMs['median'];
    const mean = latencyMs['mean'];
    const max = latencyMs['max'];
    if (
      !isFiniteNumber(min) ||
      !isFiniteNumber(median) ||
      !isFiniteNumber(mean) ||
      !isFiniteNumber(max)
    ) {
      log.add(`${path}.latencyMs`, 'min, median, mean and max must all be finite numbers');
      sound = false;
    } else if (min < 0) {
      log.add(`${path}.latencyMs.min`, 'must not be negative');
      sound = false;
    } else if (!(min <= median && median <= max) || !(min <= mean && mean <= max)) {
      log.add(
        `${path}.latencyMs`,
        'must satisfy min <= median <= max and min <= mean <= max; a profile that does not ' +
          'is a transcription error rather than a measurement',
      );
      sound = false;
    } else {
      latency = { min, median, mean, max };
    }
  }

  if (!sound || latency === undefined) return null;

  // Assembled field by field rather than spread, so an unknown key that slipped
  // a check cannot ride into the loaded record.
  const evidence: TechnicalEvidence = {
    sampleCount: sampleCount as number,
    successRate: successRate as number,
    latencyMs: latency,
    recordedAt: recordedAt as string,
  };
  // exactOptionalPropertyTypes: `notes` is ABSENT, never present-and-undefined.
  return typeof notes === 'string' ? { ...evidence, notes } : evidence;
}

function parseLicence(log: ProblemLog, path: string, value: unknown): LicenceStatus | null {
  if (!isRecordObject(value)) {
    log.add(path, 'must be an object');
    return null;
  }
  log.rejectBillingFields(path, value);
  for (const key of Object.keys(value)) {
    if (!LICENCE_FIELDS.includes(key)) log.add(`${path}.${key}`, 'unknown field');
  }
  const licence = value['licence'];
  const commercialUse = value['commercialUse'];
  const evidence = value['evidence'];
  let sound = true;

  if (!isNonEmptyString(licence)) {
    log.add(`${path}.licence`, 'must name the licence, e.g. Apache-2.0 or CC-BY-NC-4.0');
    sound = false;
  }
  if (!COMMERCIAL_USES.includes(commercialUse as CommercialUse)) {
    log.add(`${path}.commercialUse`, `must be one of ${COMMERCIAL_USES.join(', ')}`);
    sound = false;
  }
  if (!isNonEmptyString(evidence)) {
    log.add(
      `${path}.evidence`,
      'must cite where the licence was read; an unsourced licence claim is a guess',
    );
    sound = false;
  }
  if (!sound) return null;
  return {
    licence: licence as string,
    commercialUse: commercialUse as CommercialUse,
    evidence: evidence as string,
  };
}

function parseScopes(
  log: ProblemLog,
  path: string,
  value: unknown,
): Record<ServiceScope, ScopeApproval> | null {
  if (!isRecordObject(value)) {
    log.add(path, 'must be an object naming every service scope');
    return null;
  }
  log.rejectBillingFields(path, value);
  for (const key of Object.keys(value)) {
    if (!(SERVICE_SCOPES as readonly string[]).includes(key)) {
      log.add(`${path}.${key}`, 'unknown service scope');
    }
  }
  const scopes: Partial<Record<ServiceScope, ScopeApproval>> = {};
  let sound = true;
  for (const scope of SERVICE_SCOPES) {
    const decision = value[scope];
    if (!SCOPE_APPROVALS.includes(decision as ScopeApproval)) {
      // An absent scope is NOT "unapproved by default". It means somebody added
      // a service and never decided about this route, and defaulting would hide
      // that behind a plausible-looking answer.
      log.add(
        `${path}.${scope}`,
        `must state ${SCOPE_APPROVALS.join(', ')} explicitly; an absent scope is an undecided one`,
      );
      sound = false;
      continue;
    }
    scopes[scope] = decision as ScopeApproval;
  }
  if (!sound) return null;
  return scopes as Record<ServiceScope, ScopeApproval>;
}

/**
 * The rules that make an approval mean something. Kept in one function so the
 * list reads as a list, and so the gate in registry.ts can be checked against
 * it rather than against a memory of it.
 */
function applyApprovalRules(
  log: ProblemLog,
  path: string,
  record: TranslationRouteRecord,
  reviewRequired: ReadonlySet<string>,
): void {
  const approvedScopes = SERVICE_SCOPES.filter(
    (scope) => record.serviceScopes[scope] === 'approved',
  );
  const reviewIsMandatory =
    reviewRequired.has(record.sourceLanguage) || reviewRequired.has(record.targetLanguage);

  if (record.productionApproved && record.technicalEvidence === null) {
    log.add(
      `${path}.productionApproved`,
      'claims production approval with technicalEvidence null; nothing has been measured, ' +
        'so there is nothing to approve',
    );
  }
  if (record.productionApproved && record.licenceStatus.commercialUse !== 'permitted') {
    log.add(
      `${path}.licenceStatus.commercialUse`,
      `is "${record.licenceStatus.commercialUse}" on a production-approved route; ` +
        'commercial use must be positively established, never assumed',
    );
  }
  if (record.productionApproved && record.provider === UNASSIGNED_PROVIDER) {
    log.add(
      `${path}.provider`,
      `is "${UNASSIGNED_PROVIDER}"; a direction with no model behind it cannot be approved`,
    );
  }

  for (const scope of approvedScopes) {
    if (!record.productionApproved) {
      log.add(
        `${path}.serviceScopes.${scope}`,
        'is approved on a route that is not productionApproved; scopes NARROW production ' +
          'approval and can never grant it',
      );
    }
    if (record.humanReviewStatus === 'failed') {
      log.add(`${path}.serviceScopes.${scope}`, 'is approved while human review has FAILED');
    }
    if (record.humanReviewStatus === 'required-not-done' && reviewIsMandatory) {
      log.add(
        `${path}.serviceScopes.${scope}`,
        'is approved while human review is outstanding for a review-required language ' +
          `(${record.sourceLanguage}->${record.targetLanguage}); no measurement stands in for ` +
          'a speaker of the language',
      );
    }
    if (record.provider === UNASSIGNED_PROVIDER) {
      log.add(
        `${path}.serviceScopes.${scope}`,
        `is approved with provider "${UNASSIGNED_PROVIDER}"`,
      );
    }
  }
}

function parseRoute(
  log: ProblemLog,
  path: string,
  value: unknown,
  reviewRequired: ReadonlySet<string>,
): TranslationRouteRecord | null {
  if (!isRecordObject(value)) {
    log.add(path, 'must be an object');
    return null;
  }
  log.rejectBillingFields(path, value);
  for (const key of Object.keys(value)) {
    if (!(RECORD_FIELDS as readonly string[]).includes(key)) {
      log.add(`${path}.${key}`, 'unknown field');
    }
  }

  const sourceLanguage = value['sourceLanguage'];
  const targetLanguage = value['targetLanguage'];
  const provider = value['provider'];
  const modelId = value['modelId'];
  const executionClass = value['executionClass'];
  const productionApproved = value['productionApproved'];
  const humanReviewStatus = value['humanReviewStatus'];
  let sound = true;

  if (!isNonEmptyString(sourceLanguage)) {
    log.add(`${path}.sourceLanguage`, 'must be a language tag');
    sound = false;
  }
  if (!isNonEmptyString(targetLanguage)) {
    log.add(`${path}.targetLanguage`, 'must be a language tag');
    sound = false;
  }
  if (
    isNonEmptyString(sourceLanguage) &&
    isNonEmptyString(targetLanguage) &&
    normaliseLanguageTag(sourceLanguage) === normaliseLanguageTag(targetLanguage)
  ) {
    log.add(path, 'source and target are the same language; that is not a translation route');
    sound = false;
  }
  if (!isNonEmptyString(provider)) {
    log.add(`${path}.provider`, 'must name the provider');
    sound = false;
  }
  if (!isNonEmptyString(modelId)) {
    log.add(`${path}.modelId`, 'must name the model');
    sound = false;
  }
  if (!EXECUTION_CLASSES.includes(executionClass as ExecutionClass)) {
    log.add(`${path}.executionClass`, `must be one of ${EXECUTION_CLASSES.join(', ')}`);
    sound = false;
  }
  if (typeof productionApproved !== 'boolean') {
    log.add(`${path}.productionApproved`, 'must be a boolean');
    sound = false;
  }
  if (!HUMAN_REVIEW_STATUSES.includes(humanReviewStatus as HumanReviewStatus)) {
    log.add(`${path}.humanReviewStatus`, `must be one of ${HUMAN_REVIEW_STATUSES.join(', ')}`);
    sound = false;
  }

  const hasEvidenceField = Object.prototype.hasOwnProperty.call(value, 'technicalEvidence');
  if (!hasEvidenceField) {
    log.add(
      `${path}.technicalEvidence`,
      'must be present, as null when nothing has been measured; an absent field reads as an ' +
        'oversight while null reads as a statement',
    );
    sound = false;
  }
  const evidence = hasEvidenceField
    ? parseEvidence(log, `${path}.technicalEvidence`, value['technicalEvidence'])
    : null;
  const licence = parseLicence(log, `${path}.licenceStatus`, value['licenceStatus']);
  const scopes = parseScopes(log, `${path}.serviceScopes`, value['serviceScopes']);

  if (!sound || licence === null || scopes === null) return null;

  const record: TranslationRouteRecord = {
    sourceLanguage: normaliseLanguageTag(sourceLanguage as string),
    targetLanguage: normaliseLanguageTag(targetLanguage as string),
    provider: provider as string,
    modelId: modelId as string,
    executionClass: executionClass as ExecutionClass,
    productionApproved: productionApproved as boolean,
    technicalEvidence: evidence,
    humanReviewStatus: humanReviewStatus as HumanReviewStatus,
    licenceStatus: licence,
    serviceScopes: scopes,
  };

  applyApprovalRules(log, path, record, reviewRequired);
  return record;
}

/**
 * Validate a parsed JSON document. PURE: no filesystem, no environment, no
 * clock. Where the bytes came from is the caller's business.
 */
export function parseRouteDocument(input: unknown, options: ParseOptions = {}): DocumentParse {
  const log = new ProblemLog();

  if (!isRecordObject(input)) {
    return { ok: false, problems: [{ path: '', message: 'document must be a JSON object' }] };
  }
  log.rejectBillingFields('', input);
  for (const key of Object.keys(input)) {
    if (!(DOCUMENT_FIELDS as readonly string[]).includes(key)) {
      log.add(key, 'unknown document field');
    }
  }

  const version = input['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    log.add('version', 'must be an integer of at least 1');
  }
  if (input['author'] !== undefined && !isNonEmptyString(input['author'])) {
    log.add('author', 'when present must be a non-empty string');
  }
  if (input['note'] !== undefined && !isNonEmptyString(input['note'])) {
    log.add('note', 'when present must be a non-empty string');
  }

  const declaredReview = input['reviewRequiredLanguages'];
  let documentReview: readonly string[] | undefined;
  if (declaredReview !== undefined) {
    if (!Array.isArray(declaredReview) || !declaredReview.every(isNonEmptyString)) {
      log.add('reviewRequiredLanguages', 'when present must be an array of language tags');
    } else {
      documentReview = declaredReview.map(normaliseLanguageTag);
    }
  }
  const reviewRequiredLanguages = (
    options.reviewRequiredLanguages ??
    documentReview ??
    DEFAULT_REVIEW_REQUIRED_LANGUAGES
  ).map(normaliseLanguageTag);
  const reviewRequired = new Set(reviewRequiredLanguages);

  const rawRoutes = input['routes'];
  if (!Array.isArray(rawRoutes)) {
    log.add('routes', 'must be an array');
    return { ok: false, problems: log.problems };
  }

  const routes: TranslationRouteRecord[] = [];
  const seen = new Map<string, number>();
  rawRoutes.forEach((raw, index) => {
    const path = `routes[${index}]`;
    const record = parseRoute(log, path, raw, reviewRequired);
    if (record === null) return;
    const key = directionKey(record.sourceLanguage, record.targetLanguage);
    const previous = seen.get(key);
    if (previous !== undefined) {
      log.add(
        path,
        `duplicates the direction ${key} already declared at routes[${previous}]; ` +
          'one direction has exactly one record',
      );
      return;
    }
    seen.set(key, index);
    routes.push(record);
  });

  if (log.problems.length > 0) return { ok: false, problems: log.problems };

  const document: RouteDocument = { version: version as number, routes };
  if (isNonEmptyString(input['author'])) document.author = input['author'];
  if (isNonEmptyString(input['note'])) document.note = input['note'];
  if (documentReview !== undefined) document.reviewRequiredLanguages = documentReview;

  return { ok: true, document, reviewRequiredLanguages };
}
