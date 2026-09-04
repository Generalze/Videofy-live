/** @author masterzee001 */
/**
 * The surface that sets what the platform charges.
 *
 * THREE ENDPOINTS, TWO AUDIENCES, AND THE SPLIT IS THE SECURITY DECISION.
 *
 *   GET  /billing/tariff        public. The price in force. Customers are
 *                               entitled to know what they are paying, and
 *                               hiding it buys nothing.
 *   GET  /admin/billing/tariff  operator. Adds history, pending changes, who
 *                               published each and why.
 *   POST /admin/billing/tariff  operator. Publishes a new version.
 *
 * A PENDING PRICE IS NOT PUBLIC. A published-but-not-yet-effective tariff is a
 * commercial decision that has not been announced -- a competitor reading next
 * month's prices from an unauthenticated endpoint is a real cost, and unlike
 * the current price there is no customer who needs it.
 *
 * DENIALS ARE 404, matching the organization routes. A 403 tells an
 * unauthorised caller that this endpoint exists and that they found the right
 * URL; a 404 tells them nothing. The true reason goes to the audit log, where
 * an operator debugging their own access can actually see it.
 *
 * EVERY PUBLISH AND EVERY DENIAL IS AUDITED. A price change is the single most
 * consequential thing a person can do through this API, and "who changed the
 * price, when, from what, to what" has to be answerable without reading a
 * diff of the database.
 */
import type express from 'express';
import {
  GRADES,
  admitPlatformOperator,
  minutesForSpend,
  type Grade,
  type GradeTerms,
  type Tariff,
} from '@videofy-live/billing-tariff';
import { resolveTrustState } from '@videofy-live/account-trust';
import type { Caller } from './routes.js';
import type { TariffStore } from './tariff-store.js';

export interface TariffRouteDependencies {
  readonly tariffs: TariffStore;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  /**
   * Account ids permitted to change platform pricing.
   *
   * Read once at registration from the deployment, not per request: this is a
   * deployment fact, and re-reading it per request would let a process pick up
   * a grant nobody restarted the service to apply.
   */
  readonly platformOperators: ReadonlySet<string>;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/** A reference spend, so an operator sees prices as minutes rather than ratios. */
const REFERENCE_SPEND_MINOR = 1000;

function refuse(res: express.Response): void {
  res.status(404).json({ error: 'Not found.' });
}

/**
 * What a tariff means, in the sentence an operator actually thinks in.
 *
 * The stored form is units-per-second and price-per-thousand-units, which is
 * exact and unreadable. Somebody changing a price needs to see "this buys
 * thirty minutes" or they will discover the effect from a customer.
 */
function summarise(tariff: Tariff): Record<string, unknown> {
  const perGrade: Record<string, unknown> = {};
  for (const grade of GRADES) {
    const terms = tariff.grades[grade];
    perGrade[grade] = {
      unitsPerSecond: terms.unitsPerSecond,
      pricePerThousandUnitsMinor: terms.pricePerThousandUnitsMinor,
      minutesPerReferenceSpend: Number(
        minutesForSpend(REFERENCE_SPEND_MINOR, grade, tariff).toFixed(2),
      ),
    };
  }
  return {
    version: tariff.version,
    currency: tariff.currency,
    effectiveFrom: tariff.effectiveFrom,
    referenceSpendMinor: REFERENCE_SPEND_MINOR,
    grades: perGrade,
  };
}

/** The operator view adds provenance the public view must not carry. */
function summariseForOperator(tariff: Tariff): Record<string, unknown> {
  return {
    ...summarise(tariff),
    publishedBy: tariff.publishedBy,
    publishedAt: tariff.publishedAt,
    note: tariff.note ?? null,
  };
}

/**
 * Read grade terms out of an untrusted body.
 *
 * Returns null rather than a partial object on anything unexpected. The domain
 * validator is the authority on whether the NUMBERS are acceptable; this only
 * establishes that they are numbers at all, so that a string price cannot reach
 * arithmetic and become NaN somewhere further in.
 */
function readGrades(body: unknown): Readonly<Record<Grade, GradeTerms>> | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>)['grades'];
  if (typeof raw !== 'object' || raw === null) return null;

  const out: Partial<Record<Grade, GradeTerms>> = {};
  for (const grade of GRADES) {
    const entry = (raw as Record<string, unknown>)[grade];
    if (typeof entry !== 'object' || entry === null) return null;
    const terms = entry as Record<string, unknown>;
    const unitsPerSecond = terms['unitsPerSecond'];
    const price = terms['pricePerThousandUnitsMinor'];
    if (typeof unitsPerSecond !== 'number' || typeof price !== 'number') return null;
    out[grade] = { unitsPerSecond, pricePerThousandUnitsMinor: price };
  }
  return out as Readonly<Record<Grade, GradeTerms>>;
}

export function registerTariffRoutes(
  app: express.Express,
  deps: TariffRouteDependencies,
): void {
  /**
   * Resolve a platform operator, or refuse.
   *
   * Verification is demanded live rather than inferred from the allowlist: an
   * allowlist entry is a durable grant, and an operator who has since lost a
   * second factor should not still be able to reprice the platform.
   */
  const operator = (req: express.Request, res: express.Response): string | null => {
    const caller = deps.callerAccountId(req);
    const admission = admitPlatformOperator({
      accountId: caller?.accountId ?? null,
      verified: caller === null ? false : resolveTrustState(caller.trust) === 'verified',
      allowlist: deps.platformOperators,
    });
    if (!admission.ok) {
      deps.onEvent?.('tariff.denied', {
        reason: admission.reason,
        accountId: caller?.accountId ?? 'anonymous',
      });
      refuse(res);
      return null;
    }
    return admission.accountId;
  };

  /** Public: what the platform charges right now. */
  app.get('/billing/tariff', async (_req, res) => {
    const current = await deps.tariffs.current();
    if (current === null) {
      res.status(503).json({ error: 'No tariff has been published yet.' });
      return;
    }
    res.json({ tariff: summarise(current) });
  });

  /** Operator: the whole picture, including what has not taken effect yet. */
  app.get('/admin/billing/tariff', async (req, res) => {
    if (operator(req, res) === null) return;
    const [current, pending, history] = await Promise.all([
      deps.tariffs.current(),
      deps.tariffs.pending(),
      deps.tariffs.history(),
    ]);
    res.json({
      current: current === null ? null : summariseForOperator(current),
      pending: pending.map(summariseForOperator),
      history: history.map(summariseForOperator),
    });
  });

  /** Operator: publish a new price. */
  app.post('/admin/billing/tariff', async (req, res) => {
    const accountId = operator(req, res);
    if (accountId === null) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const grades = readGrades(body);
    if (grades === null) {
      res.status(400).json({
        error: 'Every grade needs a numeric unitsPerSecond and pricePerThousandUnitsMinor.',
      });
      return;
    }

    const currency = typeof body['currency'] === 'string' ? body['currency'] : '';
    const effectiveFrom =
      typeof body['effectiveFrom'] === 'string' ? body['effectiveFrom'] : undefined;
    const note = typeof body['note'] === 'string' ? body['note'] : undefined;

    const before = await deps.tariffs.current();
    const result = await deps.tariffs.publish({
      grades,
      currency,
      effectiveFrom,
      publishedBy: accountId,
      note,
    });

    if (!result.ok) {
      deps.onEvent?.('tariff.rejected', {
        accountId,
        problems: result.problems.join(','),
      });
      res.status(400).json({ error: 'That tariff is not valid.', problems: result.problems });
      return;
    }

    /*
     * The audit line carries the BEFORE and AFTER, not just the after. "Version
     * 6 was published" does not answer the question anybody actually asks after
     * a billing complaint, which is what changed.
     */
    deps.onEvent?.('tariff.published', {
      accountId,
      version: result.tariff.version,
      previousVersion: before?.version ?? 0,
      currency: result.tariff.currency,
      standardUnitsPerSecond: result.tariff.grades.standard.unitsPerSecond,
      standardPricePerThousandMinor: result.tariff.grades.standard.pricePerThousandUnitsMinor,
      premiumUnitsPerSecond: result.tariff.grades.premium.unitsPerSecond,
      premiumPricePerThousandMinor: result.tariff.grades.premium.pricePerThousandUnitsMinor,
    });

    res.status(201).json({ tariff: summariseForOperator(result.tariff) });
  });
}
