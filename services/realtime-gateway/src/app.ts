import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';
import { CONNECT_API_BASE_PATH, buildErrorEnvelope } from '@videofy-live/connect-contracts';
import { ADAPTER_CONTROL_BASE_PATH } from './adapter-control-routes.js';
import { buildIceServers, readTurnConfig } from './ice-credentials.js';
import { logger } from './logger.js';

export interface CreateAppOptions {
  /**
   * Developer-surface diagnostics provider (§5.1: engineering state is
   * role-gated). Exposed only when WEBRTC_DIAGNOSTICS_ENABLED=true, and only
   * to requests carrying the internal token when one is configured.
   */
  diagnostics?: () => unknown;
  /**
   * Whether a media ingest is connected to this gateway right now.
   *
   * Lazy, like the others: the app is built before the Gateway exists.
   */
  mediaIngestConnected?: () => boolean;
  internalToken?: string | null;
  /**
   * P6.5: lazy provider for the Connect /v1 router. A closure, not a router,
   * for the same reason diagnostics is a closure: index.ts builds this app
   * BEFORE the Gateway exists, and the router needs the Gateway's Connect
   * facade. Resolved once, on the first /v1 request.
   */
  connectV1Router?: () => express.Router;
  /**
   * P6.9 Step 8: lazy provider for the adapter control plane, for the same
   * reason as the two above -- it needs the Gateway's media bridge, and the
   * app is built first. Absent when the deployment runs no transport adapters.
   */
  adapterControlRouter?: () => express.Router;
  /**
   * The direct-call lifecycle, lazily (the app is built before the Gateway).
   * Serves the callee's PRE-JOIN CHECK ("should I ring for this push?"), the
   * RINGING acknowledgement and DECLINE -- the three things a device must be
   * able to say before it is in the call's socket room.
   */
  directCalls?: () => DirectCallsHttpLike;
  /** The account session secret, to verify the Bearer token on those routes. */
  sessionSecret?: string | undefined;
  /**
   * Conference setup (29 Aug): the public conference listing, lazily for
   * the same reason as the rest. Absent means the route is not mounted.
   */
  publicCalls?: () => PublicCallListing[];
  /**
   * Conference status (29 Aug): whether a call id is live, ended or never
   * seen, lazily like the rest. Absent means the route is not mounted.
   */
  callStatus?: (callId: string) => ConferenceStatus;
}

/** What GET /calls/:callId/status answers, and nothing more. */
export type ConferenceStatus = 'active' | 'ended' | 'unknown';

/** The shape of a call id worth asking the store about; anything else is 'unknown'. */
const CALL_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** One row of GET /calls/public; what a stranger may know before joining. */
export interface PublicCallListing {
  callId: string;
  title: string | null;
  participantCount: number;
  createdAtMs: number;
}

export interface DirectCallsHttpLike {
  get(callId: string): { state: string; mode: string; callerAccountId: string; callerName: string; peerAccountId: string; expiresAtMs: number } | null;
  shouldRing(callId: string, accountId: string): 'ring' | 'expired' | 'unknown';
  ringingAck(callId: string, accountId: string): boolean;
  answering(callId: string, accountId: string): boolean;
  decline(callId: string, accountId: string): boolean;
}

export function createApp(options: CreateAppOptions = {}): express.Application {
  const directCallRoutes = (app: express.Application): void => {
    const provider = options.directCalls;
    let secret: Buffer | null = null;
    try {
      secret = requireSessionSecret(options.sessionSecret, 'VIDEOFY_AUTH_SECRET');
    } catch {
      secret = null;
    }
    if (!provider || secret === null) return;
    const sessionSecret = secret;
    const accountOf = (req: Request): string | null => {
      const header = req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (token.length === 0) return null;
      const verified = verifySessionToken({
        secret: sessionSecret,
        token,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      return verified.ok ? verified.claims.accountId : null;
    };
    const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

    /*
     * THE PRE-JOIN CHECK. A push is only a wake-up; the device asks the
     * server whether the call is still live before it rings. A stale push
     * after NO ANSWER / DECLINED / ENDED gets 'expired' and stays silent.
     * Only the peer of the call is answered at all; everybody else sees the
     * same 404, so call ids are not probeable.
     */
    app.get('/calls/direct/:callId', (req: Request, res: Response) => {
      const accountId = accountOf(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const callId = String(req.params['callId'] ?? '');
      const lifecycle = provider();
      const verdict = CALL_ID.test(callId) ? lifecycle.shouldRing(callId, accountId) : 'unknown';
      const record = lifecycle.get(callId);
      if (verdict === 'unknown' || record === null || (record.peerAccountId !== accountId && record.callerAccountId !== accountId)) {
        res.status(404).json({ error: 'No such call.' });
        return;
      }
      res.json({ ring: verdict === 'ring', ...record });
    });

    app.post('/calls/direct/:callId/ringing', (req: Request, res: Response) => {
      const accountId = accountOf(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const callId = String(req.params['callId'] ?? '');
      const live = CALL_ID.test(callId) && provider().ringingAck(callId, accountId);
      res.json({ live });
    });

    app.post('/calls/direct/:callId/decline', (req: Request, res: Response) => {
      const accountId = accountOf(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const callId = String(req.params['callId'] ?? '');
      const declined = CALL_ID.test(callId) && provider().decline(callId, accountId);
      res.json({ declined });
    });
    // The person tapped Answer on the device: hold the ringing window while
    // the app comes up (native receiver, coherent wave 29 Aug).
    app.post('/calls/direct/:callId/answering', (req: Request, res: Response) => {
      const accountId = accountOf(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const callId = String(req.params['callId'] ?? '');
      const held = CALL_ID.test(callId) && provider().answering(callId, accountId);
      res.json({ held });
    });
    /*
     * The device's side of the ring timeline (T4 push received .. T11 media
     * connected), reported once per call by either party. Ids and times
     * only; joined with the gateway's own stamps in one log line so a slow
     * ring can be attributed to its stage.
     */
    app.post('/calls/direct/:callId/timing', (req: Request, res: Response) => {
      const accountId = accountOf(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const callId = String(req.params['callId'] ?? '');
      if (!CALL_ID.test(callId)) {
        res.status(404).json({ error: 'No such call.' });
        return;
      }
      const body = (req.body ?? {}) as { role?: unknown; stamps?: unknown; reportedAtMs?: unknown };
      const stamps: Record<string, number> = {};
      if (body.stamps !== null && typeof body.stamps === 'object') {
        for (const [key, value] of Object.entries(body.stamps as Record<string, unknown>)) {
          if (/^[a-z0-9_]{1,40}$/.test(key) && typeof value === 'number' && Number.isFinite(value)) {
            stamps[key] = value;
          }
        }
      }
      const record = provider().get(callId);
      logger.info('Direct call device timeline', {
        callId,
        role: body.role === 'caller' ? 'caller' : 'callee',
        stamps,
        server: record === null ? null : { state: record.state, expiresAtMs: record.expiresAtMs },
      });
      res.json({ recorded: true });
    });
  };
  const app = express();

  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug('HTTP request', { method: req.method, path: req.path });
    next();
  });

  directCallRoutes(app);

  /*
   * PUBLIC CONFERENCES. Deliberately unauthenticated: a public room is one a
   * stranger may find, and the listing carries only what the room itself
   * would show them on arrival -- title and headcount, never who is inside.
   * Private and restricted rooms are never in it, so nothing here is probeable.
   */
  if (options.publicCalls) {
    const provide = options.publicCalls;
    app.get('/calls/public', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ calls: provide() });
    });
  }

  /*
   * CONFERENCE STATUS. Founder ruling (29 Aug 2026): "An ended conference is
   * terminal. The Recent row should show Ended and must not silently recreate
   * a room under that old code." A client holding an old code asks here
   * before joining, and shows Ended instead of opening a fresh room.
   *
   * Unauthenticated, so it answers with the status word and NOTHING else --
   * no title, no roster, no timestamps. A private room's code must not turn
   * into a lookup oracle for what is inside it. A malformed id is 'unknown'
   * rather than 400 for the same reason: the shape of the answer never
   * changes with the input.
   */
  if (options.callStatus) {
    const provide = options.callStatus;
    app.get('/calls/:callId/status', (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const callId = req.params['callId'] ?? '';
      const status: ConferenceStatus = CALL_ID_SHAPE.test(callId) ? provide(callId) : 'unknown';
      res.json({ status });
    });
  }

  /**
   * PLATFORM UP IS NOT PROGRAMME MEDIA CAPABLE, and this endpoint used to say
   * otherwise.
   *
   * It answered `ok` unconditionally. In production the gateway and the
   * account service both reported healthy for days while media ingest crash-
   * looped 106,722 times and no programme could be transcribed, translated or
   * spoken at all. Every signal an operator checks first was green.
   *
   * So the gateway now reports what it can actually see: whether a media
   * ingest is connected to it. It does not go unhealthy for that -- calls and
   * signalling genuinely work without it -- but it stops claiming a capability
   * that is absent, and `programmeMediaCapable: false` is a thing a check can
   * alert on.
   */
  app.get('/health', (_req: Request, res: Response) => {
    const ingestConnected = options.mediaIngestConnected?.() ?? null;
    res.json({
      status: 'ok',
      service: 'realtime-gateway',
      /**
       * Null when this build cannot tell. Null is not false: "nobody asked"
       * and "asked and the answer was no" must not render the same, which is
       * the mistake that produced the incident this field exists for.
       */
      programmeMediaCapable: ingestConnected,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * The ICE servers a browser needs before it can connect call video.
   *
   * This is deliberately open: every participant needs it before a call
   * exists, so there is no session to authenticate against yet. What it hands
   * out is a credential that expires on its own, to a relay that refuses to
   * forward anything to a private address. It is served fresh each time
   * rather than baked into the bundle at build time -- that is precisely the
   * mistake that shipped a build with no ICE servers at all and left
   * peer-to-peer video unable to connect between networks.
   */
  app.get('/webrtc/ice', (_req: Request, res: Response) => {
    const turn = readTurnConfig(process.env);
    // No caching: the credential inside has an expiry, and a proxy holding
    // one past it would hand out a credential coturn now rejects.
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      iceServers: buildIceServers(turn, Date.now()),
      relayConfigured: turn !== null,
    });
  });

  if (options.diagnostics && process.env['WEBRTC_DIAGNOSTICS_ENABLED'] === 'true') {
    app.get('/internal/diagnostics', (req: Request, res: Response) => {
      if (options.internalToken && req.header('X-Videofy-Internal-Token') !== options.internalToken) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json(options.diagnostics!());
    });
  }

  // P6.5: the Connect control plane, mounted BEFORE the 404 catch-all.
  if (options.connectV1Router) {
    const provide = options.connectV1Router;
    let router: express.Router | null = null;
    app.use(CONNECT_API_BASE_PATH, (req: Request, res: Response, next: NextFunction) => {
      router ??= provide();
      router(req, res, next);
    });
  }

  // P6.9: the adapter control plane. Mounted with its OWN json parser inside
  // the router, before the 404 catch-all.
  if (options.adapterControlRouter) {
    const provide = options.adapterControlRouter;
    let router: express.Router | null = null;
    app.use(ADAPTER_CONTROL_BASE_PATH, (req: Request, res: Response, next: NextFunction) => {
      router ??= provide();
      router(req, res, next);
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // /v1 keeps its envelope discipline even for failures that happen before
    // the router runs — most notably express.json() refusing a body. The
    // rest of the gateway keeps its legacy error shape untouched.
    if (req.originalUrl.startsWith(`${CONNECT_API_BASE_PATH}/`) && !res.headersSent) {
      const status = (err as { status?: number }).status;
      const inboundRequestId = req.headers['x-request-id'];
      const requestId =
        typeof inboundRequestId === 'string' && inboundRequestId.trim() !== ''
          ? inboundRequestId.trim().slice(0, 128)
          : `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      res.setHeader('X-Request-Id', requestId);
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res
          .status(400)
          .json(
            buildErrorEnvelope(
              'INVALID_REQUEST',
              'The request body could not be parsed as JSON.',
              requestId,
            ),
          );
        return;
      }
      logger.error('Unhandled express error on /v1', { message: err.message });
      res
        .status(500)
        .json(buildErrorEnvelope('INTERNAL', 'Something went wrong handling this request.', requestId));
      return;
    }
    logger.error('Unhandled express error', { message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
