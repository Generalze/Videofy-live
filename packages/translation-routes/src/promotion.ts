/** @author masterzee001 */
/**
 * PROMOTION AND REVOCATION: the deliberate act of saying yes, and the cheap act
 * of taking it back.
 *
 * Until this module existed there was a registry that could refuse everything
 * and no way at all to approve anything. The only path was to hand-edit a
 * 400-line JSON document, get four separate fields consistent with one another
 * on the first attempt, and find out at the next service boot whether the
 * fail-closed validator agreed -- because a document that breaks one rule loads
 * NOTHING, and messaging, programme and call translation go dark together. That
 * is not a control. That is a dare.
 *
 * WHY NOT THE GENERATOR. `scripts/certify/build-route-document.mjs` builds the
 * document from measurements and hard-throws if any route in it is approved.
 * That refusal is correct and stays: evidence that generates itself must not
 * also approve itself, or a rebuild becomes a promotion. So approval is a
 * SEPARATE act, performed by a person, against evidence they have to produce,
 * recorded under their name.
 *
 * WHAT THIS MODULE IS NOT. It is not a switch, and it is not an exception to
 * anything. Every rule in validate.ts and registry.ts applies to the document
 * it produces -- it just applies BEFORE the file is written rather than after,
 * so a promotion that would take the registry down is refused with the field
 * named instead of discovered at boot. If this module and the validator ever
 * disagree, the validator wins, because the validator is what production reads.
 *
 * THE BAR IS THE STRICTER OF THE TWO GATES, NOT EITHER ONE.
 * `registry.ts` refuses `required-not-done` only for the review-required
 * languages; `services/account/src/translation-route-policy.ts` refuses it for
 * every language. A tool that cleared only the first would hand somebody a
 * document that validates, loads, reports the route as approved -- and still
 * sends every message out untranslated, with no field to point at. So the bar
 * here is the union: a human read it and it PASSED, in every language, with the
 * evidence block filled in. Anything looser is a promotion that does not
 * promote.
 *
 * PURE. No filesystem, no clock, no environment. It takes the parsed document
 * in and hands a new one back; `document-write.ts` is what puts it on disk,
 * atomically, and only after this has agreed.
 */
import {
  SERVICE_SCOPES,
  UNASSIGNED_PROVIDER,
  directionKey,
  isServiceScope,
  type CommercialUse,
  type RouteReviewEvidence,
  type ScopeApproval,
  type ServiceScope,
} from './route-record.js';
import { parseRouteDocument, type DocumentProblem } from './validate.js';

/**
 * A licence finding, when the person promoting is also the one who read the
 * obligations. Separate from review evidence because they are separate
 * judgements by separate people: a speaker of the language cannot tell you
 * whether the weights may be sold, and a lawyer cannot tell you whether the
 * Yoruba is right.
 */
export interface LicenceFinding {
  /** The identifier, when the reading corrected it. Left alone when absent. */
  licence?: string;
  commercialUse: CommercialUse;
  /** Where the obligations were read. An unsourced licence claim is a guess. */
  evidence: string;
}

export interface PromotionRequest {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  /** One or more. `messaging` alone is a real and common answer. */
  readonly scopes: readonly ServiceScope[];
  /** Who performed this act. Named in the document's audit line. */
  readonly approver: string;
  /** When they performed it, ISO-8601. Supplied, never read off a clock here. */
  readonly decidedAt: string;
  /** The human review. Required unless the record already carries a full one. */
  readonly reviewEvidence?: RouteReviewEvidence;
  /** A licence reading, when this act includes one. */
  readonly licence?: LicenceFinding;
  /**
   * Required to move a scope recorded as `refused`. `refused` is a decision
   * somebody made and wrote down -- the seed's six Nigerian `call-live` cells
   * say so in as many words -- and overturning one silently would erase it.
   */
  readonly overturnRefusalReason?: string;
  /**
   * Required to promote a route whose `humanReviewStatus` is `failed`. At least
   * the ceremony a refused scope costs, because the signal is stronger: a
   * refused scope is a policy note, a failed review is a speaker of the
   * language having read the output. The reason is written into the document
   * next to the review it supersedes.
   */
  readonly overturnFailedReviewReason?: string;
}

export interface RevocationRequest {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  /** The scopes to withdraw. Empty means every scope. */
  readonly scopes: readonly ServiceScope[];
  readonly approver: string;
  readonly decidedAt: string;
  /** Optional, always. A withdrawal is never held up for paperwork. */
  readonly reason?: string;
  /**
   * `refused` rather than `unapproved`: "decided against", not "not yet". Use
   * it when the route is being turned off because it was found wrong, so the
   * next person does not read the gap as an oversight and close it.
   */
  readonly markRefused?: boolean;
}

export type DocumentDecision =
  | {
      readonly ok: true;
      /** The document to write. Identical to the input when `changed` is false. */
      readonly document: unknown;
      readonly changed: boolean;
      /** One sentence a person can read back to themselves before writing. */
      readonly summary: string;
    }
  | { readonly ok: false; readonly problems: readonly DocumentProblem[] };

const REVIEW_EVIDENCE_KEYS = [
  'engine',
  'model',
  'modelVersion',
  'corpusHash',
  'corpusVersion',
  'evaluator',
  'assessedAt',
  'method',
  'score',
  'scale',
  'scaleMaximum',
  'passThreshold',
  'evidenceReference',
] as const;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The route objects, as they literally appear in the file.
 *
 * Deliberately the RAW array and not the parsed records: whatever else the
 * document contains -- field order, a note somebody wrote by hand, a key a
 * newer version of this package would not recognise -- survives a promotion
 * untouched. Re-serialising the parsed form would silently rewrite the parts of
 * the file this act has no business touching.
 */
function rawRoutes(document: unknown): Record<string, unknown>[] | null {
  if (!isRecordObject(document)) return null;
  const routes = document['routes'];
  if (!Array.isArray(routes)) return null;
  return routes.every(isRecordObject) ? (routes as Record<string, unknown>[]) : null;
}

function findRoute(
  routes: readonly Record<string, unknown>[],
  sourceLanguage: string,
  targetLanguage: string,
): { route: Record<string, unknown>; index: number } | null {
  const wanted = directionKey(sourceLanguage, targetLanguage);
  for (const [index, route] of routes.entries()) {
    const source = route['sourceLanguage'];
    const target = route['targetLanguage'];
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    if (directionKey(source, target) === wanted) return { route, index };
  }
  return null;
}

function scopeMapOf(route: Record<string, unknown>): Record<string, unknown> | null {
  const scopes = route['serviceScopes'];
  return isRecordObject(scopes) ? scopes : null;
}

/**
 * Every missing thing, never the first one.
 *
 * A promoter who is told "no technical evidence", fixes it, and is then told
 * "no licence" has been made to discover the bar one refusal at a time. The
 * refusal IS the specification, so it lists the lot.
 */
function checkPromotionEvidence(
  problems: DocumentProblem[],
  path: string,
  route: Record<string, unknown>,
  request: PromotionRequest,
): void {
  const provider = route['provider'];
  if (provider === UNASSIGNED_PROVIDER) {
    problems.push({
      path: `${path}.provider`,
      message:
        `is "${UNASSIGNED_PROVIDER}": this direction is a declared gap, with no model in this ` +
        'deployment behind it. Name a real model in the document first; there is nothing here ' +
        'to approve.',
    });
  }

  const evidence = route['technicalEvidence'];
  if (!isRecordObject(evidence)) {
    problems.push({
      path: `${path}.technicalEvidence`,
      message:
        'is null: nothing has been measured, so there is nothing to approve. Run the ' +
        'certification lane (scripts/certify/build-route-document.mjs) and promote against ' +
        'what it recorded.',
    });
  } else {
    /*
     * NOT CHECKED HERE: sampleCount. validate.ts:parseEvidence already demands
     * an integer of at least 1 for ANY evidence block, and promoteRoute refuses
     * a document that fails validation before it edits anything, so a record
     * reaching this line with no samples does not exist. The rail was removed
     * rather than defended with a test that cannot fail -- see the note on the
     * yo/ha/ig/pcm evaluator rail below. successRate IS checked, because
     * validate.ts permits 0 (a real measurement of a route that answered
     * nothing) and approving that is a different question from loading it.
     */
    const successRate = evidence['successRate'];
    if (typeof successRate !== 'number' || !(successRate > 0)) {
      problems.push({
        path: `${path}.technicalEvidence.successRate`,
        message:
          'must be above zero; a route that never returned anything cannot be approved on the ' +
          'strength of having been asked',
      });
    }
  }

  const licenceAfter = request.licence ?? null;
  const licenceStatus = route['licenceStatus'];
  const commercialUse = licenceAfter
    ? licenceAfter.commercialUse
    : isRecordObject(licenceStatus)
      ? licenceStatus['commercialUse']
      : undefined;
  if (commercialUse !== 'permitted') {
    problems.push({
      path: `${path}.licenceStatus.commercialUse`,
      message:
        `is "${String(commercialUse)}": reach we may not sell is not reach. Either the ` +
        'document must already record commercial use as permitted, or this act must carry a ' +
        'licence reading (commercialUse and the source it was read from).',
    });
  }
  /*
   * NOT CHECKED HERE: that a licence finding cites its source. The finding is
   * written into `licenceStatus.evidence`, and validate.ts:parseLicence refuses
   * a document whose licence does not say where it was read, on the whole
   * document, before a byte is written. Two rails, one wall.
   */

  /*
   * THE REVIEW. `passed` is the only status that opens a scope here, for every
   * language and not merely the review-required four -- see the header. Saying
   * `passed` costs an evidence block: a model version and a corpus hash are
   * what make the judgement checkable later, and what make a STALE one visible
   * instead of inherited when either moves on.
   */
  const supplied = request.reviewEvidence;
  const existing = route['reviewEvidence'];
  const status = route['humanReviewStatus'];
  if (supplied === undefined) {
    if (status !== 'passed' || !isRecordObject(existing)) {
      problems.push({
        path: `${path}.humanReviewStatus`,
        message:
          `is "${String(status)}" with no review evidence supplied. A human who reads the ` +
          'language must have read this direction and passed it, and this act must carry what ' +
          'they established: engine, model, modelVersion, corpusHash, corpusVersion, ' +
          'evaluator, assessedAt, method, score, scale, evidenceReference. Availability and ' +
          'latency cannot tell you whether the output is right.',
      });
    }
  }
  /*
   * NOT CHECKED HERE: that a supplied review block is complete, that its
   * timestamp is a date, that its model matches the record's, or that its score
   * cleared its own threshold. All four are validate.ts rules
   * (`parseReviewEvidence` and `applyApprovalRules`), applied to the WHOLE
   * document after the edit and before any byte is written, and every one of
   * them names the same `routes[n].reviewEvidence.<field>` path a duplicate
   * here would. Duplicating them bought a second refusal that no mutation could
   * make fire.
   */

  /*
   * A FAILED REVIEW IS THE STRONGEST THING THIS DOCUMENT CAN CARRY, AND WAS THE
   * CHEAPEST THING IN IT TO ERASE.
   *
   * Moving a scope out of `refused` demands an explicit flag and a written
   * reason. Overturning `failed` -- a named speaker of the language having read
   * the output and said it is wrong -- demanded nothing at all, and the
   * promotion replaced the failing evidence block wholesale, so the finding was
   * destroyed rather than superseded. The ceremony is now at least equal, and
   * the superseded block is kept (see `supersedeReview`).
   */
  if (status === 'failed' && !isNonEmptyString(request.overturnFailedReviewReason)) {
    problems.push({
      path: `${path}.humanReviewStatus`,
      message:
        'is "failed": somebody who reads the language read this output and said it is wrong. ' +
        'Overturning that requires saying so explicitly and giving the reason, which is ' +
        'recorded in the document alongside the review being superseded. A fresh review block ' +
        'on its own is not enough -- the next person has to be able to read that a speaker ' +
        'said no, and who decided otherwise.',
    });
  }

  /*
   * THERE IS NO EXTRA CLAUSE FOR yo, ha, ig AND pcm HERE, AND THAT IS CORRECT.
   *
   * One was written, and mutation testing showed nothing could make it fire:
   * it demanded a named evaluator for a review-required language, but the bar
   * above already demands a PASSED review with a complete evidence block --
   * evaluator included -- for EVERY language, and validate.ts refuses a
   * document carrying a half-filled block, so a record reaching here with
   * `passed` and no evaluator does not exist. It was a safety rail bolted to a
   * wall. Removed rather than defended with a test that cannot fail.
   *
   * What protects those four languages is the bar being uniform, plus
   * validate.ts and registry.ts refusing `not-required` on them outright.
   */

  // MESSAGING IS LOCAL-ONLY. Rule 4 of the founder's messaging ruling: no
  // automatic paid cloud fallback, however approved a cloud route may be
  // elsewhere. Approving a cloud route for messaging produces a record the
  // messaging path will never select -- an approval that reads as live and is
  // not, which is worse than a refusal.
  if (request.scopes.includes('messaging') && route['executionClass'] !== 'local') {
    problems.push({
      path: `${path}.executionClass`,
      message:
        `is "${String(route['executionClass'])}". Messaging takes LOCAL routes only, so ` +
        'approving this one for messaging would record an approval the messaging path can ' +
        'never act on.',
    });
  }
}

/**
 * Does the approval already on the record account for every approved scope?
 *
 * Deliberately shallow: whether the block is WELL FORMED is validate.ts's
 * question, asked of the whole document before anything is written. This only
 * answers whether re-stamping it would say anything new.
 */
function approvalCovers(approval: unknown, approvedScopes: readonly ServiceScope[]): boolean {
  if (!isRecordObject(approval)) return false;
  const scopes = approval['scopes'];
  if (!Array.isArray(scopes)) return false;
  return approvedScopes.every((scope) => scopes.includes(scope));
}

/**
 * MOVE THE REVIEW BEING REPLACED INTO THE HISTORY, NEVER OVER IT.
 *
 * Called before a promotion writes a fresh review block. The case this exists
 * for is `failed`: a speaker read the output, said it was wrong, and the next
 * approve command used to erase the verdict, the score and the reference to
 * their working, leaving a document in which the finding had never happened.
 * A status with no evidence block is still worth keeping -- that a review
 * failed is the fact, the block is only its working.
 */
function supersedeReview(draftRoute: Record<string, unknown>, request: PromotionRequest): void {
  const status = draftRoute['humanReviewStatus'];
  const existing = draftRoute['reviewEvidence'];
  const hasEvidence = isRecordObject(existing);
  // Re-stating the review that is already recorded supersedes nothing, and a
  // history entry per re-run would cost the tool its idempotence.
  if (
    status === 'passed' &&
    hasEvidence &&
    request.reviewEvidence !== undefined &&
    REVIEW_EVIDENCE_KEYS.every((key) => existing[key] === request.reviewEvidence?.[key])
  ) {
    return;
  }
  if (status === 'passed' && !hasEvidence) return;
  if (!hasEvidence && status !== 'failed') return;

  const entry: Record<string, unknown> = {
    status,
    supersededAt: request.decidedAt,
    supersededBy: request.approver,
    reason: isNonEmptyString(request.overturnFailedReviewReason)
      ? request.overturnFailedReviewReason
      : 'superseded by a later review recorded in the same act',
  };
  if (hasEvidence) entry['evidence'] = existing;

  const history = draftRoute['reviewHistory'];
  draftRoute['reviewHistory'] = Array.isArray(history) ? [...history, entry] : [entry];
}

/** The one place the audit line is worded, so promotion and revocation match. */
function appendAuditLine(document: Record<string, unknown>, line: string): void {
  const existing = document['note'];
  document['note'] = isNonEmptyString(existing) ? `${existing}\n\n${line}` : line;
}

function validateRequestShape(
  problems: DocumentProblem[],
  request: { approver: string; decidedAt: string; scopes: readonly ServiceScope[] },
  scopesMayBeEmpty: boolean,
): void {
  if (!isNonEmptyString(request.approver)) {
    problems.push({
      path: 'approver',
      message: 'must name who is performing this act; an unattributed decision is not auditable',
    });
  }
  if (!isNonEmptyString(request.decidedAt) || Number.isNaN(Date.parse(request.decidedAt))) {
    problems.push({ path: 'decidedAt', message: 'must be an ISO-8601 timestamp' });
  }
  for (const scope of request.scopes) {
    if (!isServiceScope(scope)) {
      problems.push({
        path: 'scopes',
        message: `"${String(scope)}" is not a service scope (${SERVICE_SCOPES.join(', ')})`,
      });
    }
  }
  if (!scopesMayBeEmpty && request.scopes.length === 0) {
    problems.push({
      path: 'scopes',
      message:
        `name at least one of ${SERVICE_SCOPES.join(', ')}. Approval for one service is never ` +
        'approval for another, so there is no "all" here.',
    });
  }
}

/**
 * Approve one direction for one or more service scopes.
 *
 * Returns the document to write, or every reason it will not. Never mutates the
 * input. Idempotent: promoting what is already promoted reports `changed:
 * false` and hands the original document straight back, so a re-run does not
 * append a second audit line saying something happened.
 */
export function promoteRoute(document: unknown, request: PromotionRequest): DocumentDecision {
  const problems: DocumentProblem[] = [];
  validateRequestShape(problems, request, false);

  /*
   * THE DOCUMENT MUST BE SOUND BEFORE IT IS EDITED. Promoting on top of a file
   * that already fails validation would produce a file that still fails
   * validation, and the promoter would reasonably read the second failure as
   * something their edit caused. Refuse, and hand back the problems that were
   * already there.
   */
  const before = parseRouteDocument(document);
  if (!before.ok) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message:
            'the document is already invalid, so nothing may be promoted into it. The registry ' +
            'is not loading anywhere right now; fix these first.',
        },
        ...before.problems,
      ],
    };
  }

  const routes = rawRoutes(document);
  const root = document as Record<string, unknown>;
  if (routes === null) {
    return { ok: false, problems: [{ path: 'routes', message: 'must be an array of objects' }] };
  }

  const found = findRoute(routes, request.sourceLanguage, request.targetLanguage);
  const where = directionKey(request.sourceLanguage, request.targetLanguage);
  if (found === null) {
    problems.push({
      path: 'routes',
      message:
        `no record exists for ${where}. A direction nobody has written down is a direction ` +
        'nobody has checked: add the record, with its measurement, before approving it. There ' +
        'is no nearest match and nothing is widened.',
    });
    return { ok: false, problems };
  }

  const path = `routes[${found.index}]`;
  const scopeMap = scopeMapOf(found.route);
  if (scopeMap === null) {
    return {
      ok: false,
      problems: [{ path: `${path}.serviceScopes`, message: 'must be an object' }],
    };
  }

  for (const scope of request.scopes) {
    if (scopeMap[scope] === 'refused' && !isNonEmptyString(request.overturnRefusalReason)) {
      problems.push({
        path: `${path}.serviceScopes.${scope}`,
        message:
          'is "refused", which is a decision somebody made and wrote down, not a gap. ' +
          'Overturning it requires saying so explicitly and giving the reason, which is ' +
          'recorded in the document.',
      });
    }
  }

  checkPromotionEvidence(problems, path, found.route, request);
  if (problems.length > 0) return { ok: false, problems };

  const draft = structuredClone(root);
  const draftRoutes = rawRoutes(draft);
  const draftRoute = draftRoutes?.[found.index];
  if (draftRoute === undefined) {
    return { ok: false, problems: [{ path, message: 'could not be located in the draft copy' }] };
  }
  const draftScopes = scopeMapOf(draftRoute);
  if (draftScopes === null) {
    return {
      ok: false,
      problems: [{ path: `${path}.serviceScopes`, message: 'must be an object' }],
    };
  }

  draftRoute['productionApproved'] = true;
  if (request.reviewEvidence !== undefined) {
    supersedeReview(draftRoute, request);
    draftRoute['humanReviewStatus'] = 'passed';
    // Copied key by key rather than spread, so a caller's extra property cannot
    // ride into the document and be refused by a validator that never names it.
    const evidence: Record<string, unknown> = {};
    for (const key of REVIEW_EVIDENCE_KEYS) evidence[key] = request.reviewEvidence[key];
    draftRoute['reviewEvidence'] = evidence;
  }
  if (request.licence !== undefined) {
    const licence = isRecordObject(draftRoute['licenceStatus'])
      ? (draftRoute['licenceStatus'] as Record<string, unknown>)
      : {};
    if (request.licence.licence !== undefined) licence['licence'] = request.licence.licence;
    licence['commercialUse'] = request.licence.commercialUse;
    licence['evidence'] = request.licence.evidence;
    draftRoute['licenceStatus'] = licence;
  }
  for (const scope of request.scopes) draftScopes[scope] = 'approved';

  /*
   * PROVENANCE AS A FIELD. `scopes` is every scope approved AFTER this act, not
   * merely the ones it opened, because the record has to cover what is live --
   * validate.ts refuses an approved scope this does not name. The note keeps
   * the history of who did what and when; this keeps the current answer where
   * deleting a line of prose cannot reach it.
   *
   * Written only when this act actually changed something, or when what is
   * there does not already account for every approved scope. Stamping it
   * unconditionally would make a re-run of the same command differ from the
   * last one by a timestamp, which is idempotence lost to bookkeeping.
   */
  const approvedAfter = SERVICE_SCOPES.filter((scope) => draftScopes[scope] === 'approved');
  const substantive = JSON.stringify(draftRoute) !== JSON.stringify(found.route);
  if (substantive || !approvalCovers(draftRoute['approval'], approvedAfter)) {
    draftRoute['approval'] = {
      approvedBy: request.approver,
      approvedAt: request.decidedAt,
      scopes: approvedAfter,
    };
  }

  const changed = JSON.stringify(draftRoute) !== JSON.stringify(found.route);
  if (!changed) {
    return {
      ok: true,
      document,
      changed: false,
      summary:
        `${where} is already approved for ${request.scopes.join(', ')} on exactly this ` +
        'evidence. Nothing was changed and nothing was written.',
    };
  }

  const reviewer =
    request.reviewEvidence?.evaluator ??
    (isRecordObject(found.route['reviewEvidence'])
      ? String((found.route['reviewEvidence'] as Record<string, unknown>)['evaluator'])
      : 'unrecorded');
  appendAuditLine(
    draft,
    `APPROVED ${request.decidedAt} by ${request.approver}: ${where} for ` +
      `${request.scopes.join(', ')}, on a human review passed by ${reviewer}` +
      (isNonEmptyString(request.overturnRefusalReason)
        ? `. Overturns a recorded refusal: ${request.overturnRefusalReason}`
        : '.') +
      // Said in the note as well as in the record, because the note is what a
      // person reads top to bottom. A line that does not say a review FAILED
      // reads as an ordinary approval.
      (found.route['humanReviewStatus'] === 'failed'
        ? ` OVERTURNS A FAILED HUMAN REVIEW: ${String(request.overturnFailedReviewReason)}. ` +
          'The superseded review is kept in this record\'s reviewHistory.'
        : ''),
  );

  /*
   * THE WHOLE DOCUMENT, AFTER THE EDIT. Not the record -- the document. A
   * promotion that produces a file the validator refuses would take messaging,
   * programme and call translation down together at the next boot, and this is
   * the last place that can be caught before the bytes exist.
   */
  const after = parseRouteDocument(draft);
  if (!after.ok) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message:
            'this promotion would produce a document the validator refuses. The document it ' +
            'was given was sound, so everything below is something this act would have ' +
            'written -- and a document the validator refuses stops the registry loading ' +
            'anywhere. Nothing was written.',
        },
        ...after.problems,
      ],
    };
  }

  return {
    ok: true,
    document: draft,
    changed: true,
    summary: `${where} is now approved for ${request.scopes.join(', ')}.`,
  };
}

/**
 * Withdraw an approval. ALWAYS ALLOWED.
 *
 * Revocation demands none of the evidence promotion does, and it deliberately
 * tolerates a document that is already invalid -- which is only true END TO END
 * because `document-write.ts` writes a withdrawal at the
 * `no-worse-than-before` bar. This function used to say yes while every write
 * path said no, two green tests asserted the two halves, and nothing tested the
 * join. The first time a live route is
 * found corrupting phone numbers, the person turning it off is doing it under
 * pressure and possibly at night; making them satisfy a bar to take something
 * AWAY would be the bar working exactly backwards. The only thing refused here
 * is a revocation that would introduce a problem the document did not already
 * have -- and since this only ever removes approvals, that should be
 * unreachable. It is checked anyway.
 */
export function revokeRoute(document: unknown, request: RevocationRequest): DocumentDecision {
  const problems: DocumentProblem[] = [];
  validateRequestShape(problems, request, true);

  const routes = rawRoutes(document);
  if (routes === null) {
    return { ok: false, problems: [{ path: 'routes', message: 'must be an array of objects' }] };
  }
  const root = document as Record<string, unknown>;
  const found = findRoute(routes, request.sourceLanguage, request.targetLanguage);
  const where = directionKey(request.sourceLanguage, request.targetLanguage);
  if (found === null) {
    problems.push({
      path: 'routes',
      message: `no record exists for ${where}, so there is no approval here to withdraw.`,
    });
  }
  if (problems.length > 0 || found === null) return { ok: false, problems };

  const path = `routes[${found.index}]`;
  const draft = structuredClone(root);
  const draftRoute = rawRoutes(draft)?.[found.index];
  const draftScopes = draftRoute === undefined ? null : scopeMapOf(draftRoute);
  if (draftRoute === undefined || draftScopes === null) {
    return {
      ok: false,
      problems: [{ path: `${path}.serviceScopes`, message: 'must be an object' }],
    };
  }

  const targets = request.scopes.length === 0 ? SERVICE_SCOPES : request.scopes;
  const withdrawn: ScopeApproval = request.markRefused === true ? 'refused' : 'unapproved';
  for (const scope of targets) draftScopes[scope] = withdrawn;

  /*
   * PRODUCTION APPROVAL FOLLOWS THE LAST SCOPE OUT. A record left
   * `productionApproved: true` with nothing approved is valid and harmless
   * today, and reads as live to anybody scanning the file. When the last scope
   * goes, the headline goes with it.
   */
  const stillApproved = SERVICE_SCOPES.some((scope) => draftScopes[scope] === 'approved');
  if (!stillApproved) draftRoute['productionApproved'] = false;

  const changed = JSON.stringify(draftRoute) !== JSON.stringify(found.route);
  if (!changed) {
    return {
      ok: true,
      document,
      changed: false,
      summary: `${where} was not approved for ${targets.join(', ')}. Nothing was written.`,
    };
  }

  appendAuditLine(
    draft,
    `WITHDRAWN ${request.decidedAt} by ${request.approver}: ${where} for ` +
      `${targets.join(', ')}, now "${withdrawn}". ` +
      (isNonEmptyString(request.reason) ? `Reason: ${request.reason}` : 'No reason recorded.'),
  );

  const before = parseRouteDocument(document);
  const after = parseRouteDocument(draft);
  if (!after.ok) {
    const had = new Set(
      (before.ok ? [] : before.problems).map((problem) => `${problem.path}|${problem.message}`),
    );
    const introduced = after.problems.filter(
      (problem) => !had.has(`${problem.path}|${problem.message}`),
    );
    if (introduced.length > 0) {
      return {
        ok: false,
        problems: [
          { path: '', message: 'this withdrawal would introduce a new problem. Nothing written.' },
          ...introduced,
        ],
      };
    }
    // Already broken, and this makes it strictly less approved. Let it through:
    // refusing would leave a live approval in place to protect a file that is
    // not loading anywhere anyway.
  }

  return {
    ok: true,
    document: draft,
    changed: true,
    summary: `${where} is now "${withdrawn}" for ${targets.join(', ')}.`,
  };
}
