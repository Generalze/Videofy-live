/** @author masterzee001 */
/**
 * The Connect Reference product API — six routes the browser talks to.
 *
 * Every Videofy interaction goes through @videofy/server-sdk; the vfk_ key
 * exists only inside that client. The browser sees ROOM ids ("room_...") and
 * join tokens only: no vc_ call id, no /v1 shape, and no Connect vocabulary
 * ever crosses this boundary — in responses or in logs.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  VideofyApiError,
  VideofyContractError,
  VideofyInputError,
  type JoinToken,
  type VideofyConnectClient,
} from '@videofy/server-sdk';
import { RefError, refErrorBody, scrubSecrets, type RefErrorCode } from './errors.js';
import { hashHostKey, mintHostKey, mintRoomId, verifyHostKey } from './ids.js';
import { isCallGoneError, LiveCallDirectory, type LiveCallPersistence } from './live-calls.js';
import { RoomModeSchema, type RoomRecord, type RoomStore } from './room-store.js';

/** Same shape check the Connect contract applies to language tags. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
/**
 * Members need no account: the browser mints a stable guest id and keeps it
 * in localStorage. Total length stays within the 128-character subject cap.
 */
const MEMBER_SUBJECT = /^guest_[A-Za-z0-9_-]{1,119}$/;

const CreateRoomSchema = z
  .object({
    name: z.string().trim().min(1, 'name must not be empty').max(80, 'name is limited to 80 characters'),
    mode: RoomModeSchema,
    scheduledFor: z
      .string()
      .datetime({ offset: true, message: 'scheduledFor must be an ISO-8601 date-time' })
      .optional(),
  })
  .strict();

const JoinTokenRequestSchema = z
  .object({
    displayName: z.string().trim().min(1, 'displayName must not be empty').max(80),
    speakLanguage: z
      .string()
      .max(35)
      .regex(LANGUAGE_TAG, 'speakLanguage must be a language tag such as "en" or "pt-BR"'),
    hearLanguage: z
      .string()
      .max(35)
      .regex(LANGUAGE_TAG, 'hearLanguage must be a language tag such as "en" or "pt-BR"'),
    subject: z.string().max(128).regex(MEMBER_SUBJECT, 'subject must be a "guest_..." member id'),
  })
  .strict();

const ChangeModeSchema = z.object({ mode: RoomModeSchema, hostKey: z.string().min(1) }).strict();
const EndRoomSchema = z.object({ hostKey: z.string().min(1) }).strict();

export interface ReferenceAppOptions {
  /** The server SDK client; tests inject one whose fetch is a fake /v1. */
  connect: VideofyConnectClient;
  roomStore: RoomStore;
  /** Injectable for directory-level tests; a fresh one is built otherwise. */
  liveCalls?: LiveCallDirectory;
  /** Request/error log sink. Secrets are scrubbed before lines reach it. */
  log?: (line: string) => void;
  /** Clock, injectable for cache-expiry tests. */
  now?: () => number;
  /** How long GET /api/config may serve a cached answer (default 60s). */
  capabilitiesCacheMs?: number;
}

interface PublicRoom {
  roomId: string;
  name: string;
  mode: 'normal' | 'translated';
  scheduledFor?: string;
  createdAt: string;
  transcriptDownloadAllowed: boolean;
  ended: boolean;
}

function toPublicRoom(room: RoomRecord): PublicRoom {
  return {
    roomId: room.roomId,
    name: room.name,
    mode: room.mode,
    ...(room.scheduledFor !== undefined ? { scheduledFor: room.scheduledFor } : {}),
    createdAt: room.createdAt,
    transcriptDownloadAllowed: room.transcriptDownloadAllowed,
    ended: room.ended,
  };
}

/** Express 4 does not forward async rejections; hand them to the error middleware. */
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

/** An express body-parser refusal (bad JSON, oversized payload, ...). */
function isBodyParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    String((error as { type: unknown }).type).startsWith('entity.')
  );
}

interface TranslatedError {
  status: number;
  code: RefErrorCode;
  message: string;
}

/**
 * Every failure leaves in Connect Reference words. Upstream codes stay
 * server-side; the few member-actionable ones map to product codes, and the
 * rest collapse to REF_UPSTREAM_UNAVAILABLE.
 */
function translateError(error: unknown): TranslatedError {
  if (error instanceof RefError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    const detail = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    return {
      status: 400,
      code: 'REF_INVALID_REQUEST',
      message: detail === '' ? 'Invalid request body.' : detail,
    };
  }
  if (error instanceof VideofyInputError) {
    const detail = error.issues.slice(0, 3).join('; ');
    return {
      status: 400,
      code: 'REF_INVALID_REQUEST',
      message: detail === '' ? 'The request was refused.' : detail,
    };
  }
  if (error instanceof VideofyApiError) {
    switch (error.code) {
      case 'CALL_FULL':
        return { status: 409, code: 'REF_ROOM_FULL', message: 'The room is full.' };
      case 'DISPLAY_NAME_TAKEN':
        return {
          status: 409,
          code: 'REF_NAME_TAKEN',
          message: 'That display name is already in use in this room.',
        };
      case 'SUBJECT_ALREADY_ACTIVE':
        return {
          status: 409,
          code: 'REF_ALREADY_JOINED',
          message: 'You are already in this room from another tab or device.',
        };
      case 'INVALID_LANGUAGE':
        return {
          status: 400,
          code: 'REF_INVALID_REQUEST',
          message: 'One of the selected languages is not supported.',
        };
      case 'RATE_LIMITED':
        return {
          status: 429,
          code: 'REF_RATE_LIMITED',
          message: 'Too many requests; try again in a moment.',
        };
      default:
        return {
          status: 502,
          code: 'REF_UPSTREAM_UNAVAILABLE',
          message: 'The conference backend could not complete the request.',
        };
    }
  }
  if (error instanceof VideofyContractError) {
    return {
      status: 502,
      code: 'REF_UPSTREAM_UNAVAILABLE',
      message: 'The conference backend answered in an unexpected way.',
    };
  }
  if (isBodyParseError(error)) {
    return { status: 400, code: 'REF_INVALID_REQUEST', message: 'The request body must be valid JSON.' };
  }
  return { status: 500, code: 'REF_INTERNAL', message: 'Something went wrong on our side.' };
}

export function buildReferenceApp(options: ReferenceAppOptions): express.Express {
  const { connect, roomStore } = options;
  // The room registry doubles as the mapping's durable memory (server-side
  // only — toPublicRoom never carries it), so a restart of THIS process
  // re-adopts the call the members are still in.
  const persistence: LiveCallPersistence = {
    recall: (roomId) => roomStore.get(roomId)?.liveCallId,
    remember: async (roomId, publicCallId) => {
      if (roomStore.get(roomId) !== undefined) {
        await roomStore.update(roomId, { liveCallId: publicCallId });
      }
    },
    forget: async (roomId) => {
      if (roomStore.get(roomId)?.liveCallId !== undefined) {
        await roomStore.update(roomId, { liveCallId: null });
      }
    },
  };
  const liveCalls = options.liveCalls ?? new LiveCallDirectory(connect, persistence);
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const capabilitiesCacheMs = options.capabilitiesCacheMs ?? 60_000;

  interface ConfigAnswer {
    languages: string[];
    limits: { personalParticipants: number; conferenceParticipants: number };
  }
  let capabilitiesCache: { value: ConfigAnswer; fetchedAt: number } | null = null;

  /**
   * A network-level failure (the SDK re-throws raw fetch errors) means the
   * backend is unreachable, not that the request was wrong.
   */
  async function upstream<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof RefError ||
        error instanceof VideofyApiError ||
        error instanceof VideofyContractError ||
        error instanceof VideofyInputError
      ) {
        throw error;
      }
      throw new RefError(503, 'REF_UPSTREAM_UNAVAILABLE', 'The conference backend is unreachable right now.');
    }
  }

  function requireRoom(roomId: string | undefined): RoomRecord {
    const room = roomId === undefined ? undefined : roomStore.get(roomId);
    if (room === undefined) throw new RefError(404, 'REF_ROOM_NOT_FOUND', 'No such room.');
    return room;
  }

  function requireHost(room: RoomRecord, hostKey: string): void {
    if (!verifyHostKey(hostKey, room.hostKeyHash)) {
      throw new RefError(403, 'REF_HOST_UNAUTHORIZED', 'The host key does not match this room.');
    }
  }

  /**
   * Mint against the ensured live call; if the call vanished between the
   * liveness check and the mint, recover exactly once.
   */
  async function mintJoinToken(
    room: RoomRecord,
    member: z.infer<typeof JoinTokenRequestSchema>,
  ): Promise<JoinToken> {
    const participant = {
      subject: member.subject,
      displayName: member.displayName,
      speakLanguage: member.speakLanguage,
      hearLanguage: member.hearLanguage,
    };
    return upstream(async () => {
      const live = await liveCalls.ensure(room);
      try {
        return await connect.joinTokens.create(live.publicCallId, { participant });
      } catch (error) {
        if (!isCallGoneError(error)) throw error;
        liveCalls.invalidate(room.roomId, live.publicCallId);
        // The call being gone may MEAN the host just ended the room: re-read
        // before creating anything, or a parked mint resurrects an ended
        // room with a live, invisible call.
        const fresh = roomStore.get(room.roomId);
        if (fresh === undefined || fresh.ended) {
          throw new RefError(410, 'REF_ROOM_ENDED', 'This room has ended.');
        }
        const replacement = await liveCalls.ensure(fresh);
        return await connect.joinTokens.create(replacement.publicCallId, { participant });
      }
    });
  }

  /**
   * Fixed-window per-address limiter on the injectable clock. Unauthenticated
   * room creation writes durable records; without a ceiling one loop fills
   * the disk. The windows map is swept opportunistically so it cannot grow
   * without bound either.
   */
  function limiter(limitPerMinute: number) {
    const windows = new Map<string, { windowStart: number; count: number }>();
    return (req: Request, _res: Response, next: NextFunction): void => {
      const at = now();
      const key = req.ip ?? 'unknown';
      const entry = windows.get(key);
      if (entry === undefined || at - entry.windowStart >= 60_000) {
        if (windows.size > 10_000) {
          for (const [stale, value] of windows) {
            if (at - value.windowStart >= 60_000) windows.delete(stale);
          }
        }
        windows.set(key, { windowStart: at, count: 1 });
        next();
        return;
      }
      entry.count += 1;
      if (entry.count <= limitPerMinute) next();
      else next(new RefError(429, 'REF_RATE_LIMITED', 'Too many requests; try again in a moment.'));
    };
  }
  const createLimit = limiter(10);
  const joinLimit = limiter(30);
  const hostLimit = limiter(30);

  const app = express();
  app.use(express.json({ limit: '16kb' }));

  // Request log without secrets: method, path, status, duration. Bodies are
  // never logged (they can carry host keys); neither are tokens or keys.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = now();
    res.on('finish', () => {
      log(
        scrubSecrets(
          `[connect-reference] ${req.method} ${req.path} ${res.statusCode} ${now() - startedAt}ms`,
        ),
      );
    });
    next();
  });

  app.post(
    '/api/rooms',
    createLimit,
    asyncRoute(async (req, res) => {
      const body = CreateRoomSchema.parse(req.body ?? {});
      const hostKey = mintHostKey();
      const record: RoomRecord = {
        roomId: mintRoomId(),
        name: body.name,
        mode: body.mode,
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
        createdAt: new Date(now()).toISOString(),
        hostKeyHash: hashHostKey(hostKey),
        transcriptDownloadAllowed: true,
        ended: false,
      };
      await roomStore.create(record);
      // The host_ key exists in this response and nowhere else, ever again.
      res.status(201).json({ room: toPublicRoom(record), hostKey });
    }),
  );

  app.get(
    '/api/rooms',
    asyncRoute(async (_req, res) => {
      const summaries = await Promise.all(
        roomStore.list().map(async (room) => {
          const base = { ...toPublicRoom(room), live: false, participantCount: 0 };
          if (room.ended) return base;
          // stateIfLive never throws — a Connect outage degrades to live:false.
          const state = await liveCalls.stateIfLive(room.roomId);
          if (state === null) return base;
          return {
            ...base,
            live: true,
            participantCount: state.participants.filter((participant) => participant.connected)
              .length,
          };
        }),
      );
      res.json(summaries);
    }),
  );

  app.get(
    '/api/rooms/:roomId',
    asyncRoute(async (req, res) => {
      const room = requireRoom(req.params['roomId']);
      const state = room.ended ? null : await liveCalls.stateIfLive(room.roomId);
      const participants =
        state === null
          ? []
          : state.participants.map((participant) => ({
              // The product identity is displayName + a KC-side stable index;
              // Videofy participant internals stay on this side of the line.
              index: liveCalls.memberIndex(room.roomId, participant.subject),
              displayName: participant.displayName,
              speakLanguage: participant.speakLanguage,
              hearLanguage: participant.hearLanguage,
              connected: participant.connected,
            }));
      // Flat by design: the detail IS the room, plus liveness. (The nested
      // {room: ...} shape survives only on POST /api/rooms, where hostKey
      // rides beside it.)
      res.json({
        ...toPublicRoom(room),
        live: state !== null,
        participantCount: participants.filter((participant) => participant.connected).length,
        participants,
      });
    }),
  );

  app.post(
    '/api/rooms/:roomId/join-tokens',
    joinLimit,
    asyncRoute(async (req, res) => {
      const room = requireRoom(req.params['roomId']);
      if (room.ended) throw new RefError(410, 'REF_ROOM_ENDED', 'This room has ended.');
      const body = JoinTokenRequestSchema.parse(req.body ?? {});

      // Capacity and name rules are enforced HERE, where the product's 409s
      // can actually be spoken — the media plane's refusals never reach this
      // seam. A member's OWN seat never counts against them: re-minting for
      // the same subject is seat replacement (recovery depends on it), and
      // Connect enforces one connected seat per subject itself. When live
      // state is unreadable the checks degrade open; the mint itself will
      // fail honestly if the backend is truly down.
      const state = await liveCalls.stateIfLive(room.roomId);
      if (state !== null) {
        const connected = state.participants.filter(
          (participant) => participant.connected && participant.subject !== body.subject,
        );
        const limit = (await capabilitiesAnswer())?.limits.conferenceParticipants;
        if (limit !== undefined && connected.length >= limit) {
          throw new RefError(409, 'REF_ROOM_FULL', 'The room is full.');
        }
        const wantedName = body.displayName.trim().toLowerCase();
        const nameTaken = connected.some(
          (participant) => participant.displayName.trim().toLowerCase() === wantedName,
        );
        if (nameTaken) {
          throw new RefError(
            409,
            'REF_NAME_TAKEN',
            'That display name is already in use in this room.',
          );
        }
      }

      const minted = await mintJoinToken(room, body);

      // The host may have ended the room while the mint was in flight. The
      // token must not leave, and a call the recovery just created must not
      // outlive the room it belonged to.
      const after = roomStore.get(room.roomId);
      if (after === undefined || after.ended) {
        const mapping = liveCalls.peek(room.roomId);
        if (mapping !== undefined) {
          try {
            await connect.calls.end(mapping.publicCallId);
          } catch {
            // Already gone is exactly the outcome we wanted.
          }
          liveCalls.clear(room.roomId);
        }
        throw new RefError(410, 'REF_ROOM_ENDED', 'This room has ended.');
      }

      // Claim the member's stable index at first join.
      liveCalls.memberIndex(room.roomId, body.subject);
      res.status(201).json({ token: minted.token, expiresAt: minted.expiresAt });
    }),
  );

  app.post(
    '/api/rooms/:roomId/mode',
    hostLimit,
    asyncRoute(async (req, res) => {
      const room = requireRoom(req.params['roomId']);
      const body = ChangeModeSchema.parse(req.body ?? {});
      requireHost(room, body.hostKey);
      if (room.ended) throw new RefError(410, 'REF_ROOM_ENDED', 'This room has ended.');
      // An establishment in flight IS a mapping this route must wait for: a
      // switch landing while the first join's create is parked would
      // otherwise never reach the call being created, and the room record
      // and live call would disagree for the call's whole lifetime.
      const inFlight = liveCalls.settled(room.roomId);
      let mapping = liveCalls.peek(room.roomId);
      if (mapping === undefined && inFlight !== undefined) {
        mapping = await inFlight.catch(() => undefined);
      }
      if (mapping !== undefined) {
        try {
          await upstream(() => connect.calls.setMode(mapping.publicCallId, body.mode));
        } catch (error) {
          // A vanished call is fine — the next join recreates it in the new
          // mode. Anything else must NOT persist a mode the live call never
          // accepted.
          if (!isCallGoneError(error)) throw error;
          liveCalls.invalidate(room.roomId, mapping.publicCallId);
        }
      }
      const updated = await roomStore.update(room.roomId, { mode: body.mode });
      res.json({ room: toPublicRoom(updated) });
    }),
  );

  app.post(
    '/api/rooms/:roomId/end',
    hostLimit,
    asyncRoute(async (req, res) => {
      const room = requireRoom(req.params['roomId']);
      const body = EndRoomSchema.parse(req.body ?? {});
      requireHost(room, body.hostKey);
      const mapping = liveCalls.peek(room.roomId);
      if (mapping !== undefined) {
        try {
          await upstream(() => connect.calls.end(mapping.publicCallId));
        } catch (error) {
          // Already gone is exactly the outcome we wanted.
          if (!isCallGoneError(error)) throw error;
        }
        liveCalls.clear(room.roomId);
      }
      const updated = room.ended ? room : await roomStore.update(room.roomId, { ended: true });
      res.json({ room: toPublicRoom(updated) });
    }),
  );

  /** Cached capabilities, or null when the platform is unreachable AND cold. */
  async function capabilitiesAnswer(): Promise<ConfigAnswer | null> {
    const at = now();
    if (capabilitiesCache !== null && at - capabilitiesCache.fetchedAt < capabilitiesCacheMs) {
      return capabilitiesCache.value;
    }
    try {
      const capabilities = await connect.capabilities();
      capabilitiesCache = {
        value: {
          languages: capabilities.languages,
          limits: {
            personalParticipants: capabilities.limits.personalParticipants,
            conferenceParticipants: capabilities.limits.conferenceParticipants,
          },
        },
        fetchedAt: at,
      };
    } catch {
      // Degrade gracefully: a slightly stale answer beats a dead lobby.
    }
    return capabilitiesCache?.value ?? null;
  }

  app.get(
    '/api/config',
    asyncRoute(async (_req, res) => {
      const answer = await capabilitiesAnswer();
      if (answer === null) {
        throw new RefError(
          503,
          'REF_UPSTREAM_UNAVAILABLE',
          'Language options are unavailable right now; try again shortly.',
        );
      }
      res.json(answer);
    }),
  );

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json(refErrorBody('REF_NOT_FOUND', 'No such API route.'));
  });
  app.use((_req: Request, res: Response) => {
    res.status(404).json(refErrorBody('REF_NOT_FOUND', 'No such route.'));
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const translated = translateError(error);
    const detail = error instanceof Error ? error.message : String(error);
    log(
      scrubSecrets(
        `[connect-reference] ${req.method} ${req.path} failed ${translated.code}: ${detail}`,
      ),
    );
    res.status(translated.status).json(refErrorBody(translated.code, translated.message));
  });

  return app;
}
