/** @owner masterzee001 */
/**
 * The Videofy Connect /v1 control-plane router (R1: lives IN the gateway
 * process, mounted through the narrow ConnectCallFacade — no standalone
 * service, no second source of call truth).
 *
 * Discipline, uniformly applied:
 * - EVERY error body is built through connect-contracts' buildErrorEnvelope,
 *   so `retryable` can never contradict the taxonomy.
 * - X-Request-Id is accepted inbound (sane values only) and always present on
 *   the response, errors included.
 * - Bearer vfk_ keys authenticate against sha256 hashes with a constant-time
 *   sweep over every project record.
 * - Idempotency-Key on POSTs replays the stored response for the same body
 *   and refuses IDEMPOTENCY_CONFLICT for a different one.
 * - A per-project token bucket answers RATE_LIMITED with RateLimit headers.
 * - Per-project CORS: the Access-Control-Allow-Origin header appears only for
 *   an Origin the authenticated project has registered. (This is decoration
 *   for browser dev tools; AUTHORIZATION by origin happens on the join path,
 *   R7.)
 * - Internal call ids never appear in any response body: the public↔internal
 *   mapping stays inside the live-call registry.
 *
 * Nothing here logs a request body, a bearer key, a token, or a jti.
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import {
  CapabilitiesResponseSchema,
  CreateCallRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  JoinTokenRequestSchema,
  REQUEST_ID_HEADER,
  UpdateCallModeRequestSchema,
  buildErrorEnvelope,
  createPublicCallId,
  parsePublicCallId,
  type CallResource,
  type CallStateResponse,
  type CapabilitiesResponse,
  type ConnectErrorCode,
  type PublicCallId,
} from '@videofy-live/connect-contracts';
import type { ConnectCallFacade, ConnectFacadeSnapshot } from './connect-facade.js';
import { issueConnectJoinToken } from './join-token.js';
import {
  type ConnectLiveCallRecord,
  type ConnectLiveCallRegistry,
  type ConnectProjectRecord,
  type ConnectProjectRegistry,
} from './project-registry.js';

/** R9: today's language set. Additive-only evolution; never provider detail. */
export const CONNECT_SUPPORTED_LANGUAGES: readonly string[] = ['en', 'es', 'fr'];

/** R9: EXACT shape. The schema parse at the end is the growth tripwire. */
export function buildConnectCapabilitiesResponse(): CapabilitiesResponse {
  return CapabilitiesResponseSchema.parse({
    languages: [...CONNECT_SUPPORTED_LANGUAGES],
    limits: { personalParticipants: 2, conferenceParticipants: 4 },
    features: {
      personalCall: true,
      conference: true,
      video: true,
      translatedCalls: true,
      personalVoice: false,
    },
  });
}

export interface ConnectRouterLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ConnectRouterLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface ConnectV1RouterOptions {
  /** Null = registry file absent: /v1 answers 503 UNSUPPORTED_CAPABILITY on every route. */
  registry: ConnectProjectRegistry | null;
  liveCalls: ConnectLiveCallRegistry;
  facade: ConnectCallFacade;
  /** Null = CONNECT_AUTH_SECRET unusable: join-token minting answers 503. */
  tokenSecret: Buffer | null;
  logger?: ConnectRouterLogger;
  /** Injectable clock (ms) driving createdAt, expiresAt, rate limits, idempotency TTL. */
  nowMs?: () => number;
  /** Injectable randomness (hex string of byteCount*2 chars). */
  randomHex?: (byteCount: number) => string;
  rateLimit?: { capacity?: number; refillPerSecond?: number };
  idempotencyTtlMs?: number;
}

const DEFAULT_RATE_CAPACITY = 30;
const DEFAULT_RATE_REFILL_PER_SECOND = 10;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Inbound request ids are correlation values, not content: shaped or replaced. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

interface RequestContext {
  requestId: string;
  project: ConnectProjectRecord | null;
}

function contextOf(res: Response): RequestContext {
  const locals = res.locals as { connect?: RequestContext };
  if (!locals.connect) locals.connect = { requestId: 'unset', project: null };
  return locals.connect;
}

interface IdempotencyEntry {
  bodyHash: string;
  status: number;
  body: unknown;
  expiresAtMs: number;
}

interface RateBucket {
  tokens: number;
  updatedAtMs: number;
}

export function createConnectV1Router(options: ConnectV1RouterOptions): Router {
  const logger = options.logger ?? NOOP_LOGGER;
  const nowMs = options.nowMs ?? (() => Date.now());
  const randomHex = options.randomHex ?? ((byteCount: number) => randomBytes(byteCount).toString('hex'));
  const rateCapacity = options.rateLimit?.capacity ?? DEFAULT_RATE_CAPACITY;
  const rateRefillPerSecond = options.rateLimit?.refillPerSecond ?? DEFAULT_RATE_REFILL_PER_SECOND;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;

  const idempotencyEntries = new Map<string, IdempotencyEntry>();
  const rateBuckets = new Map<string, RateBucket>();

  const router = express.Router();

  function fail(
    res: Response,
    status: number,
    code: ConnectErrorCode,
    message: string,
  ): void {
    res.status(status).json(buildErrorEnvelope(code, message, contextOf(res).requestId));
  }

  /** Async-safe route wrapper: an unexpected throw becomes a 500 INTERNAL envelope. */
  function guarded(
    handler: (req: Request, res: Response) => void | Promise<void>,
  ): (req: Request, res: Response) => void {
    return (req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error: unknown) => {
          logger.error('Connect /v1 handler failed', {
            method: req.method,
            path: req.path,
            message: error instanceof Error ? error.message : 'unknown handler failure',
          });
          if (!res.headersSent) {
            fail(res, 500, 'INTERNAL', 'Something went wrong handling this request.');
          }
        });
    };
  }

  // ---- correlation id: first, so even a parse failure carries one back. ----
  router.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const requestId =
      inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : `req_${randomHex(8)}`;
    contextOf(res).requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  });

  // Self-sufficient body parsing (a no-op when the host app already parsed).
  router.use(express.json());

  // ---- R12: no registry file means /v1 is cleanly OFF, and says so. -------
  if (!options.registry) {
    router.use((_req: Request, res: Response) => {
      fail(
        res,
        503,
        'UNSUPPORTED_CAPABILITY',
        'Videofy Connect is not enabled on this gateway (no project registry).',
      );
    });
    return router;
  }
  const registry = options.registry;

  // ---- bearer vfk_ key auth --------------------------------------------
  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.header('Authorization');
    const match = header ? /^Bearer (.+)$/.exec(header.trim()) : null;
    const outcome = registry.authenticate(match?.[1]?.trim() || null);
    if (!outcome.ok) {
      if (outcome.reason === 'inactive-project') {
        fail(res, 403, 'FORBIDDEN_PROJECT', 'This project is deactivated.');
      } else {
        fail(res, 401, 'AUTH_INVALID_KEY', 'A valid project API key is required.');
      }
      return;
    }
    contextOf(res).project = outcome.project;
    // Per-project CORS decoration: only an origin the project registered is
    // ever reflected. No wildcard, no other project's origin.
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (typeof origin === 'string' && outcome.project.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', REQUEST_ID_HEADER);
    }
    next();
  });

  function requireProject(res: Response): ConnectProjectRecord {
    const project = contextOf(res).project;
    if (!project) throw new Error('Connect project middleware did not run.');
    return project;
  }

  // ---- per-project token bucket ----------------------------------------
  router.use((_req: Request, res: Response, next: NextFunction) => {
    const project = requireProject(res);
    const now = nowMs();
    const bucket = rateBuckets.get(project.projectId) ?? {
      tokens: rateCapacity,
      updatedAtMs: now,
    };
    const elapsedMs = Math.max(0, now - bucket.updatedAtMs);
    bucket.tokens = Math.min(rateCapacity, bucket.tokens + (elapsedMs / 1000) * rateRefillPerSecond);
    bucket.updatedAtMs = now;
    res.setHeader('RateLimit-Limit', String(rateCapacity));
    if (bucket.tokens < 1) {
      rateBuckets.set(project.projectId, bucket);
      res.setHeader('RateLimit-Remaining', '0');
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / rateRefillPerSecond));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      fail(res, 429, 'RATE_LIMITED', 'Too many requests for this project; retry shortly.');
      return;
    }
    bucket.tokens -= 1;
    rateBuckets.set(project.projectId, bucket);
    res.setHeader('RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    next();
  });

  // ---- Idempotency-Key on POSTs ----------------------------------------
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const key = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!key || key.length > 255) {
      next();
      return;
    }
    const project = requireProject(res);
    const now = nowMs();
    for (const [mapKey, entry] of idempotencyEntries) {
      if (entry.expiresAtMs <= now) idempotencyEntries.delete(mapKey);
    }
    const mapKey = `${project.projectId}\n${req.method}\n${req.originalUrl}\n${key}`;
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null), 'utf8')
      .digest('hex');
    const existing = idempotencyEntries.get(mapKey);
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        fail(
          res,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used with a different request body.',
        );
        return;
      }
      res.status(existing.status).json(existing.body);
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      // 5xx outcomes are never memoized: a retry deserves a fresh attempt.
      if (res.statusCode < 500) {
        idempotencyEntries.set(mapKey, {
          bodyHash,
          status: res.statusCode,
          body,
          expiresAtMs: now + idempotencyTtlMs,
        });
      }
      return originalJson(body);
    }) as Response['json'];
    next();
  });

  // ---- shared resolution helpers ---------------------------------------

  function isoNow(): string {
    return new Date(nowMs()).toISOString();
  }

  function callResource(record: ConnectLiveCallRecord): CallResource {
    return {
      callId: record.publicCallId as PublicCallId,
      type: record.callType,
      mode: record.mode,
      createdAt: record.createdAt,
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      ...(record.ended ? { ended: true } : {}),
    };
  }

  /**
   * Resolve a public id within the authenticated project's scope, and
   * reconcile with the store: a call that died natively (last seat left) is
   * discovered here and recorded as ended. Cross-project ids read as
   * CALL_NOT_FOUND — never as somebody else's call.
   */
  function resolveCall(
    req: Request,
    res: Response,
  ): { record: ConnectLiveCallRecord; snapshot: ConnectFacadeSnapshot | null } | null {
    const publicId = parsePublicCallId(req.params['callId']);
    const project = requireProject(res);
    const record = publicId ? options.liveCalls.lookup(project.projectId, publicId) : null;
    if (!record) {
      fail(res, 404, 'CALL_NOT_FOUND', 'No call with this id exists for this project.');
      return null;
    }
    if (record.ended) return { record, snapshot: null };
    const snapshot = options.facade.snapshot(record.internalCallId);
    if (!snapshot) {
      // The store no longer knows it: the call ended natively (its last seat
      // left). The registry learns that truth at read time.
      options.liveCalls.markEnded(record.publicCallId);
      return { record, snapshot: null };
    }
    record.mode = snapshot.callMode;
    return { record, snapshot };
  }

  // ---- the seven endpoints ---------------------------------------------

  router.post(
    '/calls',
    guarded((req, res) => {
      const parsed = CreateCallRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'INVALID_REQUEST', 'The call creation request body is invalid.');
        return;
      }
      const project = requireProject(res);
      const proj8 =
        project.projectId.replace(/^proj_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'proj0000';
      // Collisions are astronomically unlikely but preregister refuses them
      // loudly, so a couple of fresh draws cost nothing and guessing costs a lot.
      for (let attempt = 0; attempt < 3; attempt++) {
        const publicCallId = createPublicCallId(() => randomHex(8));
        const internalCallId = `connect_${proj8}_${randomHex(6)}`;
        const preregistered = options.facade.preregisterCall(internalCallId, {
          callType: parsed.data.type,
          callMode: parsed.data.mode,
          projectTag: project.projectId,
        });
        if (!preregistered.ok) {
          if (preregistered.reason === 'call-already-exists') continue;
          fail(res, 500, 'INTERNAL', 'The call could not be created.');
          return;
        }
        const record: ConnectLiveCallRecord = {
          publicCallId,
          internalCallId,
          projectId: project.projectId,
          callType: parsed.data.type,
          mode: parsed.data.mode,
          createdAt: isoNow(),
          ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
          ended: false,
        };
        options.liveCalls.register(record);
        logger.info('Connect call created', {
          publicCallId,
          callType: parsed.data.type,
          callMode: parsed.data.mode,
        });
        res.status(201).json(callResource(record));
        return;
      }
      fail(res, 500, 'INTERNAL', 'The call could not be created.');
    }),
  );

  router.get(
    '/calls/:callId',
    guarded((req, res) => {
      const resolved = resolveCall(req, res);
      if (!resolved) return;
      res.status(200).json(callResource(resolved.record));
    }),
  );

  router.get(
    '/calls/:callId/state',
    guarded((req, res) => {
      const resolved = resolveCall(req, res);
      if (!resolved) return;
      if (resolved.record.ended || !resolved.snapshot) {
        fail(res, 410, 'CALL_ENDED', 'This call has ended.');
        return;
      }
      const body: CallStateResponse = {
        callId: resolved.record.publicCallId as PublicCallId,
        type: resolved.record.callType,
        mode: resolved.snapshot.callMode,
        participants: resolved.snapshot.participants.map((participant) => ({
          participantId: participant.participantId,
          // Every Connect seat joined with a token-carried subject; the prefix
          // rule keeps subjectless native joins out of connect_* calls, so
          // the fallback below is unreachable in practice and merely total.
          subject: participant.subject ?? '',
          displayName: participant.displayName,
          speakLanguage: participant.speakLanguage,
          hearLanguage: participant.hearLanguage,
          connected: participant.connected,
        })),
      };
      res.status(200).json(body);
    }),
  );

  router.post(
    '/calls/:callId/join-tokens',
    guarded((req, res) => {
      const resolved = resolveCall(req, res);
      if (!resolved) return;
      if (resolved.record.ended || !resolved.snapshot) {
        fail(res, 410, 'CALL_ENDED', 'This call has ended; mint tokens for a new call.');
        return;
      }
      if (!options.tokenSecret) {
        fail(
          res,
          503,
          'UNSUPPORTED_CAPABILITY',
          'Join tokens are unavailable: CONNECT_AUTH_SECRET is not configured on this gateway.',
        );
        return;
      }
      const parsed = JoinTokenRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'INVALID_REQUEST', 'The join-token request body is invalid.');
        return;
      }
      const participant = parsed.data.participant;
      if (
        !CONNECT_SUPPORTED_LANGUAGES.includes(participant.speakLanguage) ||
        !CONNECT_SUPPORTED_LANGUAGES.includes(participant.hearLanguage)
      ) {
        fail(
          res,
          400,
          'INVALID_LANGUAGE',
          `Supported languages are: ${CONNECT_SUPPORTED_LANGUAGES.join(', ')}.`,
        );
        return;
      }
      const nowSeconds = Math.floor(nowMs() / 1000);
      const issued = issueConnectJoinToken({
        secret: options.tokenSecret,
        proj: requireProject(res).projectId,
        call: resolved.record.publicCallId,
        sub: participant.subject,
        name: participant.displayName,
        prefs: {
          speak: participant.speakLanguage,
          hear: participant.hearLanguage,
          audioMode: participant.audioMode,
          captions: participant.captionsEnabled,
          voiceGender: participant.voiceGender,
        },
        jti: `jti_${randomHex(12)}`,
        nowSeconds,
        ...(parsed.data.expiresInSeconds !== undefined
          ? { ttlSeconds: parsed.data.expiresInSeconds }
          : {}),
      });
      res.status(201).json({
        token: issued.token,
        expiresAt: new Date(issued.expiresAtSeconds * 1000).toISOString(),
        participant,
      });
    }),
  );

  router.patch(
    '/calls/:callId',
    guarded(async (req, res) => {
      const parsed = UpdateCallModeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'INVALID_REQUEST', 'The mode-change request body is invalid.');
        return;
      }
      const resolved = resolveCall(req, res);
      if (!resolved) return;
      if (resolved.record.ended || !resolved.snapshot) {
        fail(res, 410, 'CALL_ENDED', 'This call has ended.');
        return;
      }
      // Through the runtime facade, NEVER the store: the STATE broadcast and
      // the ingest-plan consequences ride the same path an in-call owner uses.
      const outcome = await options.facade.applyAuthorityModeChange(
        resolved.record.internalCallId,
        parsed.data.mode,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'unknown-call') {
          options.liveCalls.markEnded(resolved.record.publicCallId);
          fail(res, 410, 'CALL_ENDED', 'This call has ended.');
        } else {
          fail(res, 400, 'INVALID_MODE', 'That call mode is not available.');
        }
        return;
      }
      resolved.record.mode = parsed.data.mode;
      logger.info('Connect call mode changed by project authority', {
        publicCallId: resolved.record.publicCallId,
        mode: parsed.data.mode,
      });
      res.status(200).json(callResource(resolved.record));
    }),
  );

  router.post(
    '/calls/:callId/end',
    guarded(async (req, res) => {
      const resolved = resolveCall(req, res);
      if (!resolved) return;
      const { record } = resolved;
      if (record.ended || !resolved.snapshot) {
        // Idempotent: ending an ended call restates the outcome.
        options.liveCalls.markEnded(record.publicCallId);
        record.ended = true;
        res.status(200).json(callResource(record));
        return;
      }
      const outcome = await options.facade.endCallByAuthority(record.internalCallId);
      // unknown-call means it raced to its natural death; either way it is over.
      void outcome;
      options.liveCalls.markEnded(record.publicCallId);
      record.ended = true;
      logger.info('Connect call ended by project authority', {
        publicCallId: record.publicCallId,
      });
      res.status(200).json(callResource(record));
    }),
  );

  router.get(
    '/capabilities',
    guarded((_req, res) => {
      res.status(200).json(buildConnectCapabilitiesResponse());
    }),
  );

  // ---- uniform envelope for unknown /v1 paths and stray methods. --------
  router.use((_req: Request, res: Response) => {
    fail(res, 404, 'INVALID_REQUEST', 'Unknown /v1 endpoint.');
  });

  // ---- body-parse and middleware errors, as envelopes. ------------------
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      fail(res, 400, 'INVALID_REQUEST', 'The request body could not be parsed as JSON.');
      return;
    }
    logger.error('Connect /v1 middleware failed', {
      message: err.message,
    });
    fail(res, 500, 'INTERNAL', 'Something went wrong handling this request.');
  });

  return router;
}
