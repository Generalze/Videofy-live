/** @author masterzee001 */
/**
 * Asking the account service the two questions the media plane cannot answer.
 *
 * WHAT AN OPERATOR DECIDED, and WHAT THEY HAVE ASKED TO BE DELETED. Both are
 * account state; neither is guessable from here.
 *
 * BOUNDED IN TIME, BECAUSE A LIVE PATH IS WAITING. A programme opening asks for
 * its policy, and an account service that has stopped answering must not hold
 * the opening open: the request is abandoned after a deadline and Replay
 * reports that nothing could be resolved. That is the correct outcome and it is
 * not a guess -- the broadcast is already going out either way, and the one
 * thing that must not happen is a retention invented because a socket hung.
 *
 * A TIMEOUT AND A REFUSAL ARE DIFFERENT ANSWERS. A refusal is the account
 * service saying "this channel has decided nothing", which is a thing an
 * operator can fix. A timeout is this deployment being unable to ask. Both mean
 * "record nothing", and they are reported separately because only one of them is
 * a reason to look at the account service.
 *
 * NOTHING HERE INVENTS A POLICY. There is no fallback retention in this file,
 * no default visibility, and no cache that could serve yesterday's answer as
 * today's -- a stale policy is a wrong policy applied to somebody's video.
 */

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type {
  ReplayDeletionQueue,
  ReplayDeletionRequest,
  ReplayDeletionSettlement,
} from '@videofy-live/programme-replay';
import type { ReplayPolicyAnswer, ReplayPolicyResolver } from './programme-replay-composition.js';

export interface ReplayAccountClientOptions {
  readonly accountInternalUrl: string;
  readonly internalToken: string;
  /** How long a live programme opening will wait for an answer. */
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

/** Long enough for an ordinary round trip, short enough not to hold an opening. */
const DEFAULT_TIMEOUT_MS = 3_000;

function base(url: string): string {
  return url.replace(/\/$/u, '');
}

/** Both halves of the seam, so composition takes one dependency rather than two. */
export interface ReplayAccountClient extends ReplayPolicyResolver, ReplayDeletionQueue {}

export function createReplayAccountClient(
  options: ReplayAccountClientOptions,
): ReplayAccountClient {
  const doFetch = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async (path: string, body: unknown): Promise<Response> => {
    /*
     * ABORTED RATHER THAN WAITED ON. Without this an account service that
     * accepts a connection and never answers holds a programme opening for as
     * long as the socket lives, and the live path is behind it.
     */
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await doFetch(`${base(options.accountInternalUrl)}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Videofy-Internal-Token': options.internalToken,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async resolve(identity: ProgrammeRunIdentity, startedAtMs: number): Promise<ReplayPolicyAnswer> {
      let response: Response;
      try {
        response = await call('/internal/replay/policy', {
          channelId: identity.channelId,
          programmeId: identity.programmeId,
          startedAtMs,
        });
      } catch (error) {
        return {
          ok: false,
          refusal: 'policy-service-unreachable',
          detail: `the account service could not be asked: ${describe(error)}`,
        };
      }

      if (response.status === 404) {
        /*
         * The internal seam is not registered, which happens on a deployment
         * with no internal token. Said as itself rather than as a transport
         * failure, because the fix is configuration rather than an outage.
         */
        return {
          ok: false,
          refusal: 'policy-service-unconfigured',
          detail: 'the account service exposes no internal replay policy seam',
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          refusal: 'policy-service-unavailable',
          detail: `the account service answered ${response.status}`,
        };
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          refusal: 'policy-unreadable',
          detail: 'the account service answered with something that was not a policy',
        };
      }

      if (body['ok'] !== true) {
        return {
          ok: false,
          refusal: typeof body['refusal'] === 'string' ? body['refusal'] : 'policy-refused',
          detail: typeof body['detail'] === 'string' ? body['detail'] : 'no policy was resolved',
        };
      }

      /*
       * VALIDATED, NOT TRUSTED. This is the value that decides how long
       * somebody's video is kept and who may watch it. A malformed answer is
       * refused rather than coerced -- coercing one is how a typo becomes a
       * retention.
       */
      const retention = body['retention'] as { policy?: unknown; expiresAtMs?: unknown } | undefined;
      const visibility = body['visibility'];
      if (
        typeof retention !== 'object' ||
        retention === null ||
        (visibility !== 'public' && visibility !== 'unlisted' && visibility !== 'private')
      ) {
        return { ok: false, refusal: 'policy-unreadable', detail: 'the resolved policy is malformed' };
      }
      if (retention.policy === 'keep') return { ok: true, retention: { policy: 'keep' }, visibility };
      if (retention.policy === 'none') {
        return { ok: true, retention: { policy: 'none' }, visibility: 'private' };
      }
      if (retention.policy === 'expire' && Number.isSafeInteger(retention.expiresAtMs)) {
        return {
          ok: true,
          retention: { policy: 'expire', expiresAtMs: retention.expiresAtMs as number },
          visibility,
        };
      }
      return { ok: false, refusal: 'policy-unreadable', detail: 'the resolved retention is not usable' };
    },

    async claim(limit: number, nowMs: number): Promise<readonly ReplayDeletionRequest[]> {
      const response = await call('/internal/replay/deletions/claim', { limit, nowMs });
      if (!response.ok) {
        // Thrown, so the pass reports a refusal rather than an empty batch.
        throw new Error(`the deletion queue could not be claimed (${response.status})`);
      }
      const body = (await response.json()) as { requests?: unknown };
      return Array.isArray(body.requests) ? (body.requests as ReplayDeletionRequest[]) : [];
    },

    async settle(
      requestId: string,
      settlement: ReplayDeletionSettlement,
      detail: string,
      nowMs: number,
    ): Promise<void> {
      const response = await call('/internal/replay/deletions/settle', {
        requestId,
        settlement,
        detail,
        nowMs,
      });
      if (!response.ok) {
        /*
         * Left unsettled on purpose. The claim's lease brings it back, and
         * `archive.delete` is retry-safe, so the next pass finishes the job and
         * settles correctly against a recording that is already gone.
         */
        throw new Error(`the deletion request could not be settled (${response.status})`);
      }
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // A fetch failure quotes the request URL, which names the internal host.
    return error.name === 'AbortError'
      ? 'the request timed out'
      : error.message.replace(/https?:\/\/\S+/giu, '<account service>');
  }
  return String(error);
}
