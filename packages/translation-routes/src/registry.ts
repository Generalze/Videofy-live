/** @author masterzee001 */
/**
 * THE GATE. `mayTranslate(source, target, scope)` is the only question this
 * package answers, and it answers it for ONE DIRECTION and ONE SERVICE.
 *
 * Three properties are deliberate and each one is a defect that has happened:
 *
 * IT REFUSES BY DEFAULT AND NAMES WHY. A boolean `false` sends the caller to
 * read the JSON document and guess. A refusal that says
 * `human-review-outstanding` sends them to find a speaker of the language.
 * Different refusals need different people, so the gate distinguishes them.
 *
 * AN UNKNOWN DIRECTION IS REFUSED, NOT DEFAULTED. There is no fallback route,
 * no "nearest approved pair", no widening from `yo` to some other Nigerian
 * language. A direction nobody has written down is a direction nobody has
 * checked, and the safe answer is no.
 *
 * IT RE-CHECKS WHAT VALIDATION ALREADY GUARANTEED. validate.ts refuses a
 * document whose approvals contradict its evidence, so a loaded record should
 * never reach here in a contradictory state. The gate checks anyway: a registry
 * can also be constructed in a test or a future caller from records that never
 * went through the document path, and a guard that only works when the other
 * guard worked is not a guard. The order below is deliberate -- it reports the
 * MOST FUNDAMENTAL missing thing first, so an operator fixes the licence before
 * they go hunting for a reviewer for a route that could never ship anyway.
 */
import {
  SERVICE_SCOPES,
  UNASSIGNED_PROVIDER,
  directionKey,
  isServiceScope,
  normaliseLanguageTag,
  type ServiceScope,
  type TranslationRouteRecord,
} from './route-record.js';
import {
  parseRouteDocument,
  type DocumentProblem,
  type ParseOptions,
  type RouteDocument,
} from './validate.js';

/**
 * Why a translation was refused. Five values, because five different people fix
 * five different problems.
 *
 * `unknown-direction` is kept separate from `no-approved-route` on purpose:
 * "we have never heard of this pair" and "we have a record and it is not
 * approved" look identical to a boolean and mean completely different things to
 * whoever is on call.
 */
export type TranslationRefusal =
  | 'unknown-direction'
  | 'no-approved-route'
  | 'not-approved-for-scope'
  | 'human-review-outstanding'
  | 'licence-unresolved';

export interface TranslationAllowed {
  allowed: true;
  route: TranslationRouteRecord;
}

export interface TranslationRefused {
  allowed: false;
  reason: TranslationRefusal;
  /** Plain sentence naming the direction, the scope and the missing thing. */
  explanation: string;
  /** The record consulted, or null when the direction is unknown. */
  route: TranslationRouteRecord | null;
}

export type TranslationDecision = TranslationAllowed | TranslationRefused;

export interface RegistryOptions extends ParseOptions {}

export type RegistryCreation =
  | { ok: true; registry: TranslationRouteRegistry }
  | { ok: false; problems: readonly DocumentProblem[] };

export interface RouteDirection {
  sourceLanguage: string;
  targetLanguage: string;
}

function deepFreezeRecord(record: TranslationRouteRecord): TranslationRouteRecord {
  // Frozen because a consumer holding a reference to a live approval record and
  // flipping `productionApproved` on it would be a global switch by accident --
  // exactly the thing this package refuses to have. ESM is strict mode, so the
  // attempt throws rather than passing silently.
  if (record.technicalEvidence !== null) {
    Object.freeze(record.technicalEvidence.latencyMs);
    Object.freeze(record.technicalEvidence);
  }
  Object.freeze(record.licenceStatus);
  Object.freeze(record.serviceScopes);
  return Object.freeze(record);
}

export class TranslationRouteRegistry {
  readonly #byDirection: ReadonlyMap<string, TranslationRouteRecord>;
  readonly #order: readonly TranslationRouteRecord[];
  readonly #reviewRequired: ReadonlySet<string>;

  private constructor(
    routes: readonly TranslationRouteRecord[],
    reviewRequiredLanguages: readonly string[],
  ) {
    const byDirection = new Map<string, TranslationRouteRecord>();
    const order: TranslationRouteRecord[] = [];
    for (const route of routes) {
      const frozen = deepFreezeRecord(route);
      byDirection.set(directionKey(frozen.sourceLanguage, frozen.targetLanguage), frozen);
      order.push(frozen);
    }
    this.#byDirection = byDirection;
    this.#order = Object.freeze(order);
    this.#reviewRequired = new Set(reviewRequiredLanguages.map(normaliseLanguageTag));
    Object.freeze(this);
  }

  /**
   * Build from a parsed JSON document. FAIL-CLOSED: an invalid document yields
   * no registry at all, never a partial one. A caller that cannot get a
   * registry translates nothing, which is the correct behaviour when the file
   * describing what may be translated cannot be trusted.
   */
  static fromDocument(input: unknown, options: RegistryOptions = {}): RegistryCreation {
    const parsed = parseRouteDocument(input, options);
    if (!parsed.ok) return { ok: false, problems: parsed.problems };
    return {
      ok: true,
      registry: new TranslationRouteRegistry(
        parsed.document.routes,
        parsed.reviewRequiredLanguages,
      ),
    };
  }

  /** Every record, in document order. Frozen. */
  routes(): readonly TranslationRouteRecord[] {
    return this.#order;
  }

  /** Every direction the document names, whether approved or not. */
  directions(): readonly RouteDirection[] {
    return this.#order.map((route) => ({
      sourceLanguage: route.sourceLanguage,
      targetLanguage: route.targetLanguage,
    }));
  }

  /** The languages this registry will not approve without a human. Sorted. */
  reviewRequiredLanguages(): readonly string[] {
    return Object.freeze([...this.#reviewRequired].sort());
  }

  /** True when a human must clear this language before any scope may be approved. */
  requiresHumanReview(language: string): boolean {
    return this.#reviewRequired.has(normaliseLanguageTag(language));
  }

  /**
   * The record for exactly this direction, or undefined. `lookup('en','yo')`
   * and `lookup('yo','en')` are different questions with different answers.
   */
  lookup(sourceLanguage: string, targetLanguage: string): TranslationRouteRecord | undefined {
    return this.#byDirection.get(directionKey(sourceLanguage, targetLanguage));
  }

  /** Every scope this direction may currently be invoked for. Often empty. */
  approvedScopes(sourceLanguage: string, targetLanguage: string): readonly ServiceScope[] {
    return SERVICE_SCOPES.filter(
      (scope) => this.mayTranslate(sourceLanguage, targetLanguage, scope).allowed,
    );
  }

  mayTranslate(
    sourceLanguage: string,
    targetLanguage: string,
    scope: ServiceScope,
  ): TranslationDecision {
    const source = normaliseLanguageTag(sourceLanguage);
    const target = normaliseLanguageTag(targetLanguage);
    const where = `${source}->${target}`;
    const route = this.#byDirection.get(directionKey(source, target));

    if (route === undefined) {
      return {
        allowed: false,
        reason: 'unknown-direction',
        explanation:
          `No route record exists for ${where}. A direction nobody has written down is a ` +
          'direction nobody has checked; there is no fallback and no nearest match.',
        route: null,
      };
    }

    if (!isServiceScope(scope)) {
      return {
        allowed: false,
        reason: 'not-approved-for-scope',
        explanation:
          `${where} was asked about for "${String(scope)}", which is not a service scope this ` +
          `registry knows (${SERVICE_SCOPES.join(', ')}).`,
        route,
      };
    }

    if (route.provider === UNASSIGNED_PROVIDER) {
      return {
        allowed: false,
        reason: 'no-approved-route',
        explanation:
          `${where} is a declared gap: no model in this deployment covers it, so its provider ` +
          `is "${UNASSIGNED_PROVIDER}". The direction is written down precisely so the gap is ` +
          'visible rather than guessed at.',
        route,
      };
    }

    if (!route.productionApproved) {
      return {
        allowed: false,
        reason: 'no-approved-route',
        explanation:
          `${where} has a record for ${route.provider} (${route.modelId}) but it is not ` +
          `production-approved${route.technicalEvidence === null ? ' and nothing has been measured' : ''}.`,
        route,
      };
    }

    if (route.licenceStatus.commercialUse !== 'permitted') {
      return {
        allowed: false,
        reason: 'licence-unresolved',
        explanation:
          `${where} runs on ${route.modelId} under ${route.licenceStatus.licence}, whose ` +
          `commercial use is "${route.licenceStatus.commercialUse}". Reach we may not sell is ` +
          'not reach.',
        route,
      };
    }

    if (route.humanReviewStatus === 'failed') {
      return {
        allowed: false,
        reason: 'human-review-outstanding',
        explanation: `${where} FAILED human review. Nothing measurable overturns that.`,
        route,
      };
    }

    if (
      route.humanReviewStatus === 'required-not-done' &&
      (this.#reviewRequired.has(source) || this.#reviewRequired.has(target))
    ) {
      return {
        allowed: false,
        reason: 'human-review-outstanding',
        explanation:
          `${where} touches a review-required language and no human has reviewed it. ` +
          'Availability and latency cannot tell you whether the output is right; only a ' +
          'speaker of the language can.',
        route,
      };
    }

    if (route.serviceScopes[scope] !== 'approved') {
      return {
        allowed: false,
        reason: 'not-approved-for-scope',
        explanation:
          `${where} is production-approved but "${scope}" is ` +
          `"${route.serviceScopes[scope]}" for it. Approval for one service is never ` +
          'approval for another: messaging is text a reader can challenge, live audio is not.',
        route,
      };
    }

    return { allowed: true, route };
  }
}

/** Convenience wrapper around `TranslationRouteRegistry.fromDocument`. */
export function createTranslationRouteRegistry(
  document: unknown,
  options: RegistryOptions = {},
): RegistryCreation {
  return TranslationRouteRegistry.fromDocument(document, options);
}

export type { DocumentProblem, RouteDocument };
