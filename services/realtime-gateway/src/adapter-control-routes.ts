/** @author masterzee001 */
/**
 * HTTP around `AdapterControlPlane`, and nothing more.
 *
 * Deliberately the thinnest layer in this milestone. Every handler does exactly
 * four things:
 *
 *     parse and validate  ->  authenticate the SERVICE  ->  call the control
 *     plane  ->  map its outcome to a status code
 *
 * No authorization decision is made here. The control plane and the authority
 * behind it own that, they are mutation-tested for it, and a second place that
 * decides who may do what is a second place for the two to disagree. If a
 * reviewer ever finds a policy branch in this file, it is in the wrong file.
 *
 * TWO CREDENTIALS, TWO POWERS, ONE REQUEST.
 *
 *     service credential   header, on every request
 *                          "this process may talk to the adapter API at all"
 *     route credential     header, on session creation only
 *                          "this adapter may originate calls on this route"
 *     session capability   body, on everything after creation
 *                          "this request concerns the session I already hold"
 *
 * Both credentials travel in HEADERS rather than in the body. Bodies are what
 * get logged when a request 400s, echoed into error trackers, and pasted into
 * tickets; the platform's own logger already redacts headers and does not
 * serialise them by default.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  closeSessionRequestSchema,
  createSessionRequestSchema,
  participantRequestSchema,
  type AdapterWireOutcome,
} from '@videofy-live/adapter-wire';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import type { AdapterControlPlane } from './adapter-control-plane.js';

export const ADAPTER_CONTROL_BASE_PATH = '/internal/adapter/v1';
export const ADAPTER_SERVICE_TOKEN_HEADER = 'x-videofy-adapter-token';
export const ROUTE_CREDENTIAL_HEADER = 'x-videofy-route-credential';

export interface AdapterControlRouterDeps {
  readonly controlPlane: AdapterControlPlane;
  readonly serviceAuth: InternalIngressAuthResolution;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

/**
 * One place that turns a domain outcome into a status code.
 *
 * The distinction that matters: 401 means the PROCESS was not recognised, 403
 * means the process was recognised and the thing it presented was not good
 * enough. An adapter operator debugging a failure needs to know which of those
 * two it is, because they are fixed in completely different places.
 */
export function statusForOutcome(outcome: AdapterWireOutcome): number {
  switch (outcome) {
    case 'accepted':
      return 200;
    case 'rejected-auth':
    case 'rejected-route':
      return 403;
    case 'rejected-session':
      return 404;
    case 'rejected-participant':
    case 'rejected-stale':
      // Not a permission problem: the request was well formed and the platform
      // simply is not in a state where it means anything any more. A retry
      // with the same input will not start working.
      return 409;
    case 'protocol-error':
      return 400;
    case 'dropped-backpressure':
      return 503;
    case 'timed-out':
      return 504;
    case 'internal-failure':
      return 500;
  }
}

function bodyOf<T>(schema: z.ZodType<T>, request: Request): T | null {
  const parsed = schema.safeParse(request.body);
  return parsed.success ? parsed.data : null;
}

export function createAdapterControlRouter(deps: AdapterControlRouterDeps): Router {
  const router = express.Router();
  const log = deps.log ?? (() => {});

  // A modest body limit of its own. These are small JSON control messages, and
  // the media channel is where volume belongs.
  router.use(express.json({ limit: '16kb' }));

  /**
   * Layer 1, before anything else runs.
   *
   * A caller without a valid service identity never reaches a handler, so no
   * amount of getting a later check wrong can be reached from the open
   * internet by an unauthenticated stranger.
   */
  router.use((request: Request, response: Response, next: NextFunction) => {
    const presented = request.header(ADAPTER_SERVICE_TOKEN_HEADER) ?? undefined;
    if (!internalIngressRequestAllowed(deps.serviceAuth, presented)) {
      // No detail about WHY. A caller that cannot authenticate is not owed a
      // description of the credential it failed to present.
      log('adapter control request refused: service credential', { path: request.path });
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post('/sessions', (request: Request, response: Response) => {
    const body = bodyOf(createSessionRequestSchema, request);
    if (body === null) {
      response.status(400).json({ error: 'protocol-error' });
      return;
    }
    const credential = request.header(ROUTE_CREDENTIAL_HEADER);
    if (typeof credential !== 'string' || credential === '') {
      // Authenticated as a service, but presenting nothing that says which
      // routes it may originate on. Layer 1 passed; layer 2 was not attempted.
      response.status(403).json({ error: 'rejected-route' });
      return;
    }

    const created = deps.controlPlane.createSession({
      credential,
      adapterSessionRef: body.adapterSessionRef,
      routeRef: body.routeRef,
      idempotencyKey: body.idempotencyKey,
    });
    if (!('grant' in created)) {
      log('adapter session refused', { outcome: created.outcome, routeRef: body.routeRef });
      response.status(statusForOutcome(created.outcome)).json({ error: created.outcome });
      return;
    }

    // 201 only when something was actually created. A retransmit that matched
    // an existing binding is a 200: SIP retransmits constantly, and an adapter
    // watching status codes should be able to see that it did not just open a
    // second call.
    response.status(created.grant.idempotentReplay ? 200 : 201).json({
      protocolVersion: 1,
      adapterSessionRef: body.adapterSessionRef,
      sessionCapability: created.grant.capability,
      idempotentReplay: created.grant.idempotentReplay,
    });
  });

  router.post('/sessions/participants', (request: Request, response: Response) => {
    const body = bodyOf(participantRequestSchema, request);
    if (body === null) {
      response.status(400).json({ error: 'protocol-error' });
      return;
    }
    const result = deps.controlPlane.announceParticipant({
      capability: body.sessionCapability,
      participantId: body.participantId,
    });
    response.status(statusForOutcome(result.outcome)).json(
      result.outcome === 'accepted' ? { protocolVersion: 1 } : { error: result.outcome },
    );
  });

  router.delete('/sessions/participants', (request: Request, response: Response) => {
    const body = bodyOf(participantRequestSchema, request);
    if (body === null) {
      response.status(400).json({ error: 'protocol-error' });
      return;
    }
    const result = deps.controlPlane.withdrawParticipant({
      capability: body.sessionCapability,
      participantId: body.participantId,
    });
    response.status(statusForOutcome(result.outcome)).json(
      result.outcome === 'accepted' ? { protocolVersion: 1 } : { error: result.outcome },
    );
  });

  router.post('/sessions/close', (request: Request, response: Response) => {
    const body = bodyOf(closeSessionRequestSchema, request);
    if (body === null) {
      response.status(400).json({ error: 'protocol-error' });
      return;
    }
    const result = deps.controlPlane.closeSession({
      capability: body.sessionCapability,
      reason: body.reason,
    });
    response.status(statusForOutcome(result.outcome)).json(
      result.outcome === 'accepted' ? { protocolVersion: 1 } : { error: result.outcome },
    );
  });

  return router;
}
