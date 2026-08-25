/**
 * Per-request context: the correlation id every security event is stamped with.
 *
 * WHY IT IS NOT PART OF THE CALLER. Most of the events worth watching happen on
 * requests that have no caller at all — a failed sign-in, a password reset for
 * an address that may not exist, a signup flood. Hanging the correlation id off
 * an authenticated caller would leave exactly those unattributable, and they are
 * the ones an incident is reconstructed from.
 *
 * WHY THE CLIENT MAY NOT SUPPLY ONE. Accepting an inbound `x-correlation-id`
 * is a common convenience and a bad idea here: anybody could then stamp their
 * requests with somebody else's id, poisoning a trace that an investigation
 * later depends on, or flood one id to make a search useless. The value is
 * generated server-side, always. If a trusted upstream ever needs to propagate
 * one, that is a deliberate change gated on knowing the upstream is trusted —
 * which, behind a proxy that forwards arbitrary client headers, we do not.
 *
 * It IS echoed back on the response, so somebody reporting a problem can quote
 * the id and have it found. That direction is safe: we are disclosing an
 * identifier we just invented for a request the caller already made.
 */
import type express from 'express';
import { newCorrelationId } from '@videofy-live/account-trust';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Assign a correlation id to every request.
 *
 * Registered before the routes, so that a handler cannot run without one and
 * no call site has to defend against it being missing.
 */
export function correlationMiddleware(
  generate: () => string = newCorrelationId,
): express.RequestHandler {
  return (_req, res, next) => {
    const correlationId = generate();
    res.locals['correlationId'] = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    next();
  };
}

/**
 * The correlation id for this response.
 *
 * Falls back to a fresh id rather than to an empty string. An event recorded
 * with `''` joins every other unattributed event into one meaningless group,
 * which is worse than an id that correlates with nothing: the first hides a
 * bug, the second is merely unhelpful.
 */
export function correlationIdOf(res: express.Response): string {
  const existing = res.locals['correlationId'];
  return typeof existing === 'string' && existing.length > 0 ? existing : newCorrelationId();
}
