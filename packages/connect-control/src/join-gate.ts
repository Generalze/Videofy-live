/** @owner masterzee001 */
/**
 * The connect-join gate: everything a `call:join` carrying a connectToken must
 * survive BEFORE the call-session store hears about it, in one SYNCHRONOUS
 * decision (R6 — the jti claim is a check-and-set that must land before the
 * join path's first await, because two joins with the same token race on the
 * event loop, not across threads).
 *
 * Order of checks, and why:
 *  1. signature/shape/expiry — an UNSIGNED payload must never burn a jti;
 *     otherwise anyone could void a victim's token by guessing its jti.
 *  2. jti claim — from here on the token is BURNED whatever happens next.
 *     A claimed token that fails origin, membership, or the store is gone;
 *     the partner re-mints (R6 makes that cheap by design).
 *  3. project resolve + active — FORBIDDEN_PROJECT.
 *  4. handshake Origin vs THAT project's allowedOrigins (R7: authorization,
 *     not CORS decoration; allowOriginless only when explicit).
 *  5. live-registry membership, project-scoped — post-restart tokens die
 *     here (R13), and cross-project tokens read as CALL_NOT_FOUND.
 *  6. ended check — CALL_ENDED.
 *
 * The subject one-CONNECTED rule (R8) is enforced by the runtime after this
 * gate: only the store knows which seats are connected.
 */
import type { ConnectErrorCode } from '@videofy-live/connect-contracts';
import type { CallMode, CallType } from '@videofy-live/connect-contracts';
import {
  ConnectJtiRegistry,
  verifyConnectJoinToken,
  type ConnectJoinTokenPrefs,
} from './join-token.js';
import type { ConnectLiveCallRegistry, ConnectProjectRegistry } from './project-registry.js';

export const CONNECT_JOIN_REFUSAL_CODES = [
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED_TOKEN',
  'AUTH_TOKEN_USED',
  'FORBIDDEN_PROJECT',
  'FORBIDDEN_ORIGIN',
  'CALL_NOT_FOUND',
  'CALL_ENDED',
  'SUBJECT_ALREADY_ACTIVE',
  'INVALID_REQUEST',
] as const;
export type ConnectJoinRefusalCode = (typeof CONNECT_JOIN_REFUSAL_CODES)[number];

/** Compile-time proof the refusal vocabulary is a subset of the public taxonomy. */
const _refusalCodesAreConnectErrorCodes: readonly ConnectErrorCode[] =
  CONNECT_JOIN_REFUSAL_CODES;
void _refusalCodesAreConnectErrorCodes;

export const CONNECT_JOIN_REFUSAL_MESSAGES: Record<ConnectJoinRefusalCode, string> = {
  AUTH_INVALID_TOKEN: 'This join token is not valid.',
  AUTH_EXPIRED_TOKEN: 'This join token has expired.',
  AUTH_TOKEN_USED: 'This join token has already been used.',
  FORBIDDEN_PROJECT: 'This project cannot join calls right now.',
  FORBIDDEN_ORIGIN: 'This origin is not allowed to join calls for this project.',
  CALL_NOT_FOUND: 'This call was not found.',
  CALL_ENDED: 'This call has ended.',
  SUBJECT_ALREADY_ACTIVE: 'This participant is already connected to the call.',
  INVALID_REQUEST: 'This join request is not valid.',
};

/** Everything the runtime injects into the store join — strip-and-rederive values. */
export interface ConnectJoinGrant {
  readonly internalCallId: string;
  readonly publicCallId: string;
  readonly projectId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly speakLanguage: string;
  readonly hearLanguage: string;
  readonly audioMode: ConnectJoinTokenPrefs['audioMode'];
  readonly captionsEnabled: boolean;
  readonly voiceGender: ConnectJoinTokenPrefs['voiceGender'];
  /** Registry values; the preregistered call is authoritative anyway, these are belt-and-braces. */
  readonly callType: CallType;
  readonly callMode: CallMode;
}

export type ConnectJoinDecision =
  | { readonly ok: true; readonly grant: ConnectJoinGrant }
  | { readonly ok: false; readonly code: ConnectJoinRefusalCode; readonly message: string };

function refuse(code: ConnectJoinRefusalCode): ConnectJoinDecision {
  return { ok: false, code, message: CONNECT_JOIN_REFUSAL_MESSAGES[code] };
}

export interface ConnectJoinGateDependencies {
  /** Null when CONNECT_AUTH_SECRET is unusable: every connect join fails closed. */
  readonly secret: Buffer | null;
  /** Null when the registry file is absent: every connect join fails closed. */
  readonly registry: ConnectProjectRegistry | null;
  readonly liveCalls: ConnectLiveCallRegistry;
  readonly jti: ConnectJtiRegistry;
  readonly nowSeconds?: () => number;
}

export class ConnectJoinGate {
  private readonly secret: Buffer | null;
  private readonly registry: ConnectProjectRegistry | null;
  private readonly liveCalls: ConnectLiveCallRegistry;
  private readonly jti: ConnectJtiRegistry;
  private readonly nowSeconds: () => number;

  constructor(dependencies: ConnectJoinGateDependencies) {
    this.secret = dependencies.secret;
    this.registry = dependencies.registry;
    this.liveCalls = dependencies.liveCalls;
    this.jti = dependencies.jti;
    this.nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * SYNCHRONOUS from first line to last — no await may ever appear here.
   * The caller (the call runtime) invokes this before its own first await.
   */
  authorizeJoin(connectToken: string, origin: string | null): ConnectJoinDecision {
    if (!this.secret || !this.registry) {
      // Unconfigured is indistinguishable from a bad token on purpose: the
      // partner-facing truth is "this token does not work here".
      return refuse('AUTH_INVALID_TOKEN');
    }
    const now = this.nowSeconds();
    const verified = verifyConnectJoinToken({ secret: this.secret, token: connectToken, nowSeconds: now });
    if (!verified.ok) {
      return refuse(verified.reason === 'expired' ? 'AUTH_EXPIRED_TOKEN' : 'AUTH_INVALID_TOKEN');
    }
    const claims = verified.claims;
    // The point of no return: from here the token is burned, success or not.
    if (!this.jti.claim(claims.jti, claims.exp, now)) {
      return refuse('AUTH_TOKEN_USED');
    }
    const project = this.registry.getProject(claims.proj);
    if (!project || !project.active) {
      return refuse('FORBIDDEN_PROJECT');
    }
    if (!this.registry.isOriginAllowed(project, origin)) {
      return refuse('FORBIDDEN_ORIGIN');
    }
    // Live-map membership, scoped to the token's own project: a fresh process
    // (restart) or another project's call both land here as CALL_NOT_FOUND.
    const record = this.liveCalls.lookup(project.projectId, claims.call);
    if (!record) {
      return refuse('CALL_NOT_FOUND');
    }
    if (record.ended) {
      return refuse('CALL_ENDED');
    }
    return {
      ok: true,
      grant: {
        internalCallId: record.internalCallId,
        publicCallId: record.publicCallId,
        projectId: project.projectId,
        subject: claims.sub,
        displayName: claims.name,
        speakLanguage: claims.prefs.speak,
        hearLanguage: claims.prefs.hear,
        audioMode: claims.prefs.audioMode,
        captionsEnabled: claims.prefs.captions,
        voiceGender: claims.prefs.voiceGender,
        callType: record.callType,
        callMode: record.mode,
      },
    };
  }
}
