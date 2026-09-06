/** @author masterzee001 */
/**
 * The bounded seam between the media service and what an operator decided.
 *
 * WHY THE MEDIA SERVICE DOES NOT READ THIS DATABASE. Channel settings and
 * programme overrides are ACCOUNT state -- they are edited by an authenticated
 * operator, they are validated against rules that live in the account service,
 * and they are the account service's to be right about. Giving media-ingest a
 * connection string would mean two services with independent opinions about a
 * schema, two places to keep the resolution rule, and a deployment where the
 * media plane cannot start without the account database. A narrow authenticated
 * question is a smaller thing to get wrong.
 *
 * INTERNAL ONLY, GUARDED EXACTLY AS EVERY OTHER INTERNAL SEAM: the internal
 * token, a 404 for a wrong one, and NOTHING REGISTERED AT ALL when no token is
 * configured. There is deliberately no public route that answers this question.
 * "What is this channel's retention, and who may watch it" is operator
 * configuration; publishing it would tell anybody which channels record, for
 * how long, and how privately -- which is a map of what is worth asking for.
 *
 * ONE ANSWER OR ONE REFUSAL, AND NEVER A GUESS. `resolveReplayPolicy` decides,
 * which is the same function the console previews with, so an operator's screen
 * and the recording that actually happens cannot drift apart. A channel that has
 * configured nothing produces `channel-unconfigured` -- a refusal the caller is
 * required to treat as "do not record", not as an invitation to pick something.
 *
 * AND THE DELETION QUEUE'S MACHINE HALF LIVES HERE TOO, for the same reason.
 * The account service owns the durable requests; the media service owns the
 * archive. Neither reaches into the other's storage, and the claim/settle pair
 * below is the whole of what passes between them.
 */

import type express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import {
  resolveReplayPolicy,
  type ChannelReplaySettingsStore,
  type ProgrammeReplayOverrideStore,
} from '@videofy-live/programme-replay-policy';
import type {
  ProgrammeAiringCatalogue,
  ReplayDeletionQueue,
  ReplayDeletionSettlement,
  ReplayDisposition,
} from '@videofy-live/programme-replay';

export interface ReplayInternalRouteDependencies {
  readonly settings: ChannelReplaySettingsStore;
  readonly overrides: ProgrammeReplayOverrideStore;
  readonly deletions: ReplayDeletionQueue;
  /**
   * Where programme history is written from the media plane.
   *
   * THE MUTATING HALF ONLY. Reading history is the product surface's, with the
   * visibility rules and the sealed cursor that were built for it; a second
   * discovery path through an internal seam would be a second set of those
   * rules to keep in step.
   */
  readonly airings: ProgrammeAiringCatalogue;
  readonly internalAuth: InternalIngressAuthResolution;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

function presentedToken(req: express.Request): string | undefined {
  const header = req.header('X-Videofy-Internal-Token');
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

/** A whole number of milliseconds out of a body, or null. */
function instant(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const SETTLEMENTS: readonly ReplayDeletionSettlement[] = ['done', 'defer', 'retry'];

export function registerReplayInternalRoutes(
  app: express.Express,
  deps: ReplayInternalRouteDependencies,
): void {
  if (deps.internalAuth.mode === 'unconfigured') {
    /*
     * NOTHING REGISTERED, and said out loud. A deployment without an internal
     * token has no seam, so the media service cannot resolve a policy and will
     * therefore record nothing -- which is the correct failure and needs to be
     * visible rather than looking like Replay simply not working.
     */
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message:
          'Internal Replay endpoints NOT registered: no INTERNAL_WEBRTC_TOKEN. ' +
          'No retention policy can be resolved, so no broadcast will be recorded.',
      }),
    );
    return;
  }

  const internal = (req: express.Request, res: express.Response): boolean => {
    if (internalIngressRequestAllowed(deps.internalAuth, presentedToken(req))) return true;
    res.status(404).json({ error: 'Not found.' });
    return false;
  };

  /* ------------------------------------------------- the policy question */

  /**
   * What retention and visibility does this programme air under?
   *
   * THE INSTANT IS THE CALLER'S, not this service's clock. A duration in days
   * becomes an expiry against the BROADCAST'S OWN START, so two programmes
   * configured identically and aired an hour apart expire an hour apart. Taking
   * `now()` here would make the answer depend on how long the request took.
   */
  app.post('/internal/replay/policy', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channelId = typeof body['channelId'] === 'string' ? body['channelId'] : '';
    const programmeId = typeof body['programmeId'] === 'string' ? body['programmeId'] : '';
    const startedAtMs = instant(body['startedAtMs']);

    if (channelId === '' || programmeId === '' || startedAtMs === null) {
      res.status(400).json({
        ok: false,
        refusal: 'invalid-request',
        detail: 'channelId, programmeId and startedAtMs are all required',
      });
      return;
    }

    const settings = await deps.settings.read(channelId);
    const stored = await deps.overrides.read(programmeId);
    const resolution = resolveReplayPolicy(settings, stored?.override ?? null, startedAtMs);

    if (!resolution.ok) {
      /*
       * 200 WITH A REFUSAL, not a 4xx. The question was well formed and this IS
       * the answer: this channel has not decided, or has decided something the
       * override may not change. A status code would invite a caller to treat
       * it as a transport problem and retry, and the answer would not change.
       */
      res.status(200).json({ ok: false, refusal: resolution.refusal, detail: resolution.detail });
      return;
    }

    deps.onEvent?.('replay.policy.resolved', {
      policy: resolution.value.retention.policy,
      visibility: resolution.value.visibility,
    });
    res.status(200).json({
      ok: true,
      retention: resolution.value.retention,
      visibility: resolution.value.visibility,
      retentionSource: resolution.value.retentionSource,
      visibilitySource: resolution.value.visibilitySource,
    });
  }));

  /* --------------------------------------------------- the history seam */

  /*
   * A BROADCAST HAPPENED, AND WHAT BECAME OF ITS RECORDING.
   *
   * Three idempotent writes, which is what makes an at-least-once reporter safe
   * over a network that drops things: the same message twice writes the same row
   * and reports the same success. The media plane never reads back through here.
   */
  app.post('/internal/replay/airings/record', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identity = body['identity'] as { channelId?: unknown; programmeId?: unknown; runId?: unknown } | undefined;
    const startedAtMs = instant(body['startedAtMs']);
    if (
      typeof identity?.channelId !== 'string' ||
      typeof identity.programmeId !== 'string' ||
      typeof identity.runId !== 'string' ||
      startedAtMs === null
    ) {
      res.status(400).json({ error: 'An airing needs an identity and a start.' });
      return;
    }
    const replay = body['replay'] as ReplayDisposition | undefined;
    res.status(200).json(
      await deps.airings.recordAiring({
        identity: {
          channelId: identity.channelId,
          programmeId: identity.programmeId,
          runId: identity.runId,
        },
        startedAtMs,
        ...(replay === undefined ? {} : { replay }),
      }),
    );
  }));

  app.post('/internal/replay/airings/project', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const runId = typeof body['runId'] === 'string' ? body['runId'] : '';
    const replay = body['replay'] as ReplayDisposition | undefined;
    if (runId === '' || replay === undefined) {
      res.status(400).json({ error: 'A projection needs a run and a disposition.' });
      return;
    }
    res.status(200).json(await deps.airings.projectReplay(runId, replay));
  }));

  app.post('/internal/replay/airings/finish', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const runId = typeof body['runId'] === 'string' ? body['runId'] : '';
    const endedAtMs = instant(body['endedAtMs']);
    if (runId === '' || endedAtMs === null) {
      res.status(400).json({ error: 'An ending needs a run and an instant.' });
      return;
    }
    res.status(200).json(await deps.airings.finishAiring(runId, endedAtMs));
  }));

  /* ---------------------------------------------- the deletion work seam */

  /**
   * Take some deletion work.
   *
   * THE MEDIA SERVICE OWNS THE ARCHIVE AND THIS SERVICE OWNS THE QUEUE, and
   * neither reaches into the other's storage. The lease, the row lock and the
   * skip-locked behaviour all stay behind this door where the table is.
   */
  app.post('/internal/replay/deletions/claim', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const limit = Number(body['limit'] ?? 10);
    const nowMs = instant(body['nowMs']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || nowMs === null) {
      res.status(400).json({ error: 'limit (1-100) and nowMs are required.' });
      return;
    }
    try {
      const claimed = await deps.deletions.claim(limit, nowMs);
      res.status(200).json({ requests: claimed });
    } catch {
      /*
       * 503, NOT AN EMPTY LIST. "There was no work" and "the queue could not be
       * read" are different facts, and a worker told the first when the second
       * happened would report a healthy pass over a broken queue.
       */
      res.status(503).json({ error: 'The deletion queue could not be read.' });
    }
  }));

  app.post('/internal/replay/deletions/settle', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body['requestId'] === 'string' ? body['requestId'] : '';
    const settlement = body['settlement'] as ReplayDeletionSettlement;
    const detail = typeof body['detail'] === 'string' ? body['detail'] : '';
    const nowMs = instant(body['nowMs']);
    if (requestId === '' || !SETTLEMENTS.includes(settlement) || nowMs === null) {
      res.status(400).json({ error: 'requestId, settlement and nowMs are required.' });
      return;
    }
    await deps.deletions.settle(requestId, settlement, detail, nowMs);
    deps.onEvent?.('replay.deletion.settled', { settlement });
    res.status(200).json({ settled: true });
  }));
}
