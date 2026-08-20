/** @author masterzee001 */
/**
 * Who may originate a call, and what any given connection may then touch.
 *
 * Three layers, because they answer three different questions and one token
 * blessed with omnipotence answers none of them properly:
 *
 *   Layer 1  SERVICE AUTHENTICATION   who are you?
 *   Layer 2  ROUTE AUTHORIZATION      what may this adapter originate?
 *   Layer 3  SESSION CAPABILITY       what session may you touch?
 *
 * The two secrets live in SEPARATE NAMESPACES, and that is the point. A route
 * credential presented where a capability belongs is not refused by a check
 * somebody might forget on one path — it is looked up in a table it was never
 * in. The same reasoning applies to session identity: `authorize` RESOLVES the
 * Videofy session from the capability and never accepts one as an argument, so
 * "write into someone else's session" has no way to be expressed.
 *
 * A route credential may create sessions. It may never inject audio. A leaked
 * one lets an attacker ask for a session it was already entitled to originate —
 * noisy, rate-limitable, revocable. One that could also inject audio would be a
 * master key.
 *
 * Secrets are stored hashed and never returned after issuance, never logged,
 * and never placed in an error message. Correlation is by `id`, which is public.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { videofySessionId, type VideofySessionId } from '@videofy-live/media-adapter-port/platform';

/** What a ROUTE credential may do. Deliberately one thing. */
export type RouteOperation = 'create-session';

/** What a SESSION capability may do. Deliberately not `create-session`. */
export type CapabilityOperation =
  | 'push-audio'
  | 'participant-join'
  | 'participant-leave'
  | 'stop-session';

export type AuthorityRefusal =
  | 'rejected-auth'
  | 'rejected-route'
  | 'rejected-session'
  | 'rejected-participant'
  | 'rejected-stale';

/** Distinct prefixes, so the two secrets cannot be confused even in a log. */
const ROUTE_PREFIX = 'vfr';
const CAPABILITY_PREFIX = 'vfc';
/** 32 bytes of randomness. A guessable credential is worse than none. */
const SECRET_BYTES = 32;

export interface IssuedRouteCredential {
  /** Public. Safe to log, and the handle for rotation and revocation. */
  readonly id: string;
  /** Returned ONCE, at issuance. Never recoverable afterwards. */
  readonly credential: string;
}

export interface SessionGrant {
  readonly videofySessionId: VideofySessionId;
  readonly capability: string;
  readonly capabilityId: string;
  readonly expiresAtMs: number;
  /** True when this matched an existing binding rather than making one. */
  readonly idempotentReplay: boolean;
}

export interface ResolvedCapability {
  /** The authoritative session. Resolved here; never supplied by a caller. */
  readonly videofySessionId: VideofySessionId;
  readonly adapterSessionRef: string;
  readonly adapterId: string;
  readonly routeRef: string;
}

interface RouteRecord {
  readonly id: string;
  readonly adapterId: string;
  readonly routes: Set<string>;
  secretHash: Buffer;
  expiresAtMs: number | null;
  revoked: boolean;
}

interface CapabilityRecord {
  readonly id: string;
  readonly videofySessionId: VideofySessionId;
  readonly adapterSessionRef: string;
  readonly adapterId: string;
  readonly routeRef: string;
  readonly participants: Set<string>;
  secretHash: Buffer;
  expiresAtMs: number;
  revoked: boolean;
  closed: boolean;
}

export interface AdapterAuthorityDeps {
  readonly now?: () => number;
  /** How long a session capability lives. Long calls renew rather than outlive. */
  readonly capabilityTtlMs?: number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly mintSessionId?: () => string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time over digests, so a presented value of any length is safe. */
function secretMatches(expected: Buffer, presented: string): boolean {
  return timingSafeEqual(expected, digest(presented));
}

function splitToken(token: string, prefix: string): { id: string; secret: string } | null {
  // The prefix is checked FIRST, so a route credential presented as a
  // capability is refused on shape before any table is consulted.
  const expected = `${prefix}_`;
  if (!token.startsWith(expected)) return null;
  const body = token.slice(expected.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  return { id: body.slice(0, dot), secret: body.slice(dot + 1) };
}

export class AdapterAuthority {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly capabilities = new Map<string, CapabilityRecord>();
  /** idempotencyKey → capability id, so a retry cannot make a second session. */
  private readonly bindings = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly random: (size: number) => Buffer;
  private readonly mintSessionId: () => string;
  private counter = 0;

  constructor(deps: AdapterAuthorityDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.capabilityTtlMs ?? 4 * 60 * 60 * 1000;
    this.random = deps.randomBytes ?? randomBytes;
    this.mintSessionId = deps.mintSessionId ?? (() => `cs_${randomBytes(12).toString('hex')}`);
  }

  // --- Layer 1 and 2: issuance ------------------------------------------

  issueRouteCredential(input: {
    adapterId: string;
    routes: readonly string[];
    expiresAtMs?: number | null;
  }): IssuedRouteCredential {
    const id = `r${(this.counter += 1)}${this.random(6).toString('hex')}`;
    const secret = this.random(SECRET_BYTES).toString('hex');
    this.routes.set(id, {
      id,
      adapterId: input.adapterId,
      routes: new Set(input.routes),
      secretHash: digest(secret),
      expiresAtMs: input.expiresAtMs ?? null,
      revoked: false,
    });
    return { id, credential: `${ROUTE_PREFIX}_${id}.${secret}` };
  }

  /**
   * Replace the secret, keeping the identity and its route scope.
   *
   * Rotation is not revocation: the old secret stops working immediately, and
   * anything already authorized by it keeps working, because a session that is
   * already live has its own capability.
   */
  rotateRouteCredential(id: string): IssuedRouteCredential | null {
    const record = this.routes.get(id);
    if (record === undefined || record.revoked) return null;
    const secret = this.random(SECRET_BYTES).toString('hex');
    record.secretHash = digest(secret);
    return { id, credential: `${ROUTE_PREFIX}_${id}.${secret}` };
  }

  revokeRouteCredential(id: string): void {
    const record = this.routes.get(id);
    if (record !== undefined) record.revoked = true;
  }

  // --- Layer 2 → 3: the exchange ----------------------------------------

  /**
   * Exchange a route credential for a session capability.
   *
   * The ONLY thing a route credential can do. Note what is not a parameter:
   * any Videofy session identity. The session is minted here, by the platform,
   * and the adapter learns only the opaque capability that resolves to it.
   */
  createSession(input: {
    credential: string;
    adapterSessionRef: string;
    routeRef: string;
    idempotencyKey: string;
  }): SessionGrant | AuthorityRefusal {
    const route = this.authenticateRoute(input.credential);
    if (typeof route === 'string') return route;
    if (!route.routes.has(input.routeRef)) {
      // Authenticated, but not for this route. One adapter must not be able to
      // originate calls on another's number.
      return 'rejected-route';
    }

    const existingId = this.bindings.get(input.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.capabilities.get(existingId);
      // The key must belong to the same adapter and route, or a caller could
      // adopt somebody else's binding by guessing a key.
      if (
        existing !== undefined &&
        !existing.closed &&
        existing.adapterId === route.adapterId &&
        existing.routeRef === input.routeRef &&
        existing.adapterSessionRef === input.adapterSessionRef
      ) {
        const reissued = this.random(SECRET_BYTES).toString('hex');
        existing.secretHash = digest(reissued);
        existing.expiresAtMs = this.now() + this.ttlMs;
        return {
          videofySessionId: existing.videofySessionId,
          capability: `${CAPABILITY_PREFIX}_${existing.id}.${reissued}`,
          capabilityId: existing.id,
          expiresAtMs: existing.expiresAtMs,
          idempotentReplay: true,
        };
      }
      if (existing !== undefined && !existing.closed) return 'rejected-auth';
    }

    const id = `c${(this.counter += 1)}${this.random(6).toString('hex')}`;
    const secret = this.random(SECRET_BYTES).toString('hex');
    const expiresAtMs = this.now() + this.ttlMs;
    const record: CapabilityRecord = {
      id,
      // Minted by the platform. Nothing the adapter sent contributes to it.
      videofySessionId: videofySessionId(this.mintSessionId()),
      adapterSessionRef: input.adapterSessionRef,
      adapterId: route.adapterId,
      routeRef: input.routeRef,
      participants: new Set(),
      secretHash: digest(secret),
      expiresAtMs,
      revoked: false,
      closed: false,
    };
    this.capabilities.set(id, record);
    this.bindings.set(input.idempotencyKey, id);
    return {
      videofySessionId: record.videofySessionId,
      capability: `${CAPABILITY_PREFIX}_${id}.${secret}`,
      capabilityId: id,
      expiresAtMs,
      idempotentReplay: false,
    };
  }

  // --- Layer 3: what a capability may do ---------------------------------

  /**
   * Resolve a capability to the session it names, for one operation.
   *
   * There is no `videofySessionId` parameter, and there must never be. Session
   * identity is an OUTPUT here: the caller says what it wants to do and proves
   * which session it holds, and the platform says which session that is.
   */
  authorize(
    capability: string,
    operation: CapabilityOperation,
    participantId?: string,
  ): ResolvedCapability | AuthorityRefusal {
    const parsed = splitToken(capability, CAPABILITY_PREFIX);
    // A route credential lands here as `null`: wrong prefix, so it is refused
    // before any table is consulted. Not a check — a shape.
    if (parsed === null) return 'rejected-auth';
    const record = this.capabilities.get(parsed.id);
    if (record === undefined) return 'rejected-auth';
    if (!secretMatches(record.secretHash, parsed.secret)) return 'rejected-auth';
    if (record.revoked) return 'rejected-auth';
    if (record.closed) return 'rejected-stale';
    if (record.expiresAtMs <= this.now()) return 'rejected-stale';

    if (operation === 'push-audio') {
      // Media only for someone the platform has been told about.
      if (participantId === undefined || !record.participants.has(participantId)) {
        return 'rejected-participant';
      }
    }
    return {
      videofySessionId: record.videofySessionId,
      adapterSessionRef: record.adapterSessionRef,
      adapterId: record.adapterId,
      routeRef: record.routeRef,
    };
  }

  /** Widen a capability's participant scope. Only the platform may do this. */
  announceParticipant(capability: string, participantId: string): ResolvedCapability | AuthorityRefusal {
    const resolved = this.authorize(capability, 'participant-join');
    if (typeof resolved === 'string') return resolved;
    const parsed = splitToken(capability, CAPABILITY_PREFIX)!;
    this.capabilities.get(parsed.id)!.participants.add(participantId);
    return resolved;
  }

  withdrawParticipant(capability: string, participantId: string): ResolvedCapability | AuthorityRefusal {
    const resolved = this.authorize(capability, 'participant-leave');
    if (typeof resolved === 'string') return resolved;
    const parsed = splitToken(capability, CAPABILITY_PREFIX)!;
    this.capabilities.get(parsed.id)!.participants.delete(participantId);
    return resolved;
  }

  /** End the session. The capability stops working immediately and for good. */
  closeSession(capability: string): ResolvedCapability | AuthorityRefusal {
    const resolved = this.authorize(capability, 'stop-session');
    if (typeof resolved === 'string') return resolved;
    const parsed = splitToken(capability, CAPABILITY_PREFIX)!;
    const record = this.capabilities.get(parsed.id)!;
    record.closed = true;
    record.participants.clear();
    return resolved;
  }

  revokeCapability(capabilityId: string): void {
    const record = this.capabilities.get(capabilityId);
    if (record !== undefined) record.revoked = true;
  }

  // --- internals ---------------------------------------------------------

  private authenticateRoute(credential: string): RouteRecord | AuthorityRefusal {
    const parsed = splitToken(credential, ROUTE_PREFIX);
    // A session capability presented as a route credential fails here for the
    // same structural reason, in the opposite direction.
    if (parsed === null) return 'rejected-auth';
    const record = this.routes.get(parsed.id);
    if (record === undefined) return 'rejected-auth';
    if (!secretMatches(record.secretHash, parsed.secret)) return 'rejected-auth';
    if (record.revoked) return 'rejected-auth';
    if (record.expiresAtMs !== null && record.expiresAtMs <= this.now()) return 'rejected-auth';
    return record;
  }
}
