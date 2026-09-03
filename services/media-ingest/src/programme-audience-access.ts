/** @author masterzee001 */
/**
 * Who may watch a broadcast, decided here rather than assumed at the door.
 *
 * The egress routes ask one question -- "may this request see this run" -- and
 * refuse to exist without an answer. This module is the answer for a real
 * deployment, and every branch in it is a founder ruling rather than a
 * preference:
 *
 *   public   listed and open. Anybody who reaches the URL may watch.
 *   private  not listed; THE LINK IS THE ADMISSION. "A doorbell without a
 *            sign, not a lock." Somebody holding a run id is somebody who was
 *            given it, so they are admitted -- and calling this an access
 *            control would be the lie the ruling explicitly warns against.
 *   locked   the link is NOT enough: a join code must be presented. This
 *            service cannot check one; the code lives with the gateway. So it
 *            REFUSES, which is the correct answer for a control it cannot
 *            enforce, and is written down below as the gap it is.
 *
 * FAIL CLOSED WHEN VISIBILITY IS UNKNOWN. A channel with no profile, or an
 * account service that will not answer, produces a refusal rather than a
 * guess. Guessing wrong in this direction publishes somebody's private
 * broadcast, and there is no version of that which is recoverable.
 *
 * BUT NOT AT THE COST OF A LIVE BROADCAST. A visibility this service has
 * already SEEN is served stale for a grace window when the account service
 * stops answering. Serving a value we read five minutes ago is not a guess;
 * refusing an audience mid-programme because a different service restarted
 * would be an outage we inflicted on ourselves. A channel we have never
 * resolved gets no such grace, because there is nothing to be stale about.
 */

import type express from 'express';
import type { ChannelVisibility } from '@videofy-live/shared-types';
import type { AuthenticateRequest } from './account-authentication.js';
import type { AudienceVerdict, ProgrammeAudienceAccess } from './programme-egress-routes.js';
import type { OperatorEntitlement } from './programme-control-auth.js';
import { INTERNAL_TOKEN_HEADER } from './programme-control-auth.js';
import { logger } from './logger.js';

/** Where a run's channel visibility comes from. Null means "not established". */
export interface ChannelVisibilityPort {
  visibilityOf(channelId: string): Promise<ChannelVisibility | null>;
}

export interface ProgrammeAudienceAccessDeps {
  /** The channel a run belongs to, or null when this process is not running it. */
  readonly channelOf: (runId: string) => string | null;
  readonly visibility: ChannelVisibilityPort;
  readonly authenticate: AuthenticateRequest;
  readonly entitlement: OperatorEntitlement;
  /** True when the presented internal token is this deployment's. */
  readonly internalTokenAllowed: (presented: string | undefined) => boolean;
}

export function createProgrammeAudienceAccess(
  deps: ProgrammeAudienceAccessDeps,
): ProgrammeAudienceAccess {
  return {
    async mayView(runId: string, request: express.Request): Promise<AudienceVerdict> {
      const channelId = deps.channelOf(runId);
      if (channelId === null) return 'unknown-run';

      /*
       * The gateway, presenting the credential it already uses to create
       * sessions and inject audio. It is the trusted front door, and a probe
       * holding this token can already do more than watch.
       */
      if (deps.internalTokenAllowed(request.header(INTERNAL_TOKEN_HEADER) ?? undefined)) {
        return 'allow';
      }

      /*
       * The operator watching their own programme. Checked BEFORE visibility
       * so a locked channel's own console still has a picture -- otherwise the
       * one person who must be able to see the output is the one person who
       * cannot.
       */
      const accountId = deps.authenticate(request);
      if (accountId !== null && deps.entitlement.hasEntitlement(accountId)) return 'allow';

      const visibility = await deps.visibility.visibilityOf(channelId);
      switch (visibility) {
        case 'public':
        case 'private':
          // Private is unlisted, not locked: holding the link IS the admission.
          return 'allow';
        case 'locked':
          /*
           * THE KNOWN GAP, stated rather than papered over. The join code is
           * the gateway's; this service has never held one. Until a viewing
           * grant crosses that boundary, a locked channel's audience reaches
           * the media through the gateway or not at all.
           */
          return accountId === null ? 'sign-in' : 'forbidden';
        case null:
          return 'forbidden';
      }
    },
  };
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 60_000;
/** How long an already-read visibility survives an account service outage. */
const STALE_GRACE_MS = 300_000;

interface VisibilityEntry {
  readonly visibility: ChannelVisibility | null;
  readonly freshUntilMs: number;
  readonly staleUntilMs: number;
}

export interface ChannelVisibilityClientOptions {
  readonly accountServiceUrl: string;
  /** Presented as X-Videofy-Internal-Token. Never logged, here or anywhere. */
  readonly internalToken: string;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly warn?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Read channel visibility from the account service, with a cache.
 *
 * One request per channel per TTL, however many viewers arrive meanwhile: a
 * popular programme must not turn one join into thousands of internal reads.
 */
export function createChannelVisibilityClient(
  options: ChannelVisibilityClientOptions,
): ChannelVisibilityPort {
  const base = options.accountServiceUrl.replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? ((): number => Date.now());
  const warn =
    options.warn ??
    ((message: string, detail: Record<string, unknown>): void => logger.warn(message, detail));

  const cache = new Map<string, VisibilityEntry>();
  const inflight = new Map<string, Promise<ChannelVisibility | null>>();

  async function read(channelId: string): Promise<ChannelVisibility | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${base}/internal/channels/profiles?ids=${encodeURIComponent(channelId)}`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: options.internalToken },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as {
        profiles?: Record<string, { visibility?: unknown }>;
      };
      const value = body.profiles?.[channelId]?.visibility;
      /*
       * An unrecognised tier is treated as unknown, not as public. A future
       * tier this service has not learned about must not be admitted by a
       * default branch written before it existed.
       */
      return value === 'public' || value === 'private' || value === 'locked' ? value : null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async visibilityOf(channelId: string): Promise<ChannelVisibility | null> {
      const at = now();
      const held = cache.get(channelId);
      if (held !== undefined && at < held.freshUntilMs) return held.visibility;

      const existing = inflight.get(channelId);
      if (existing !== undefined) return existing;

      const attempt = read(channelId)
        .then((visibility) => {
          cache.set(channelId, {
            visibility,
            freshUntilMs: now() + ttlMs,
            staleUntilMs: now() + ttlMs + STALE_GRACE_MS,
          });
          return visibility;
        })
        .catch((error: unknown) => {
          // NO CHANNEL ID IN THE WARNING. It is an operational identifier and
          // the message is just as useful without it.
          warn('Channel visibility could not be read; falling back', {
            message: error instanceof Error ? error.message : 'unknown failure',
            servingStale: held !== undefined && now() < held.staleUntilMs,
          });
          if (held !== undefined && now() < held.staleUntilMs) return held.visibility;
          return null;
        })
        .finally(() => {
          inflight.delete(channelId);
        });

      inflight.set(channelId, attempt);
      return attempt;
    },
  };
}

/**
 * The policy for a deployment that cannot resolve visibility at all.
 *
 * ACCOUNT_SERVICE_URL unset, or no internal token: there is no way to tell a
 * public channel from a locked one, so nobody watches through this service.
 * Named, exported and logged at boot rather than left as an implicit default,
 * because a silent refuse-everybody looks identical to a broken encoder.
 */
export const VISIBILITY_UNRESOLVABLE: ChannelVisibilityPort = {
  async visibilityOf() {
    return null;
  },
};
