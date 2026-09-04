/** @author masterzee001 */
/**
 * The seam another service rings a phone through.
 *
 * WHY IT IS INTERNAL-ONLY. The device registry lives here because devices
 * belong to accounts, but the thing that knows a call is ringing is the
 * gateway, and the thing that will know a message arrived is the messaging
 * service. Those are first-party callers on a private network, so this
 * endpoint is authenticated by the shared internal token rather than by a
 * session -- there is no user in the story at the moment somebody else's phone
 * needs to ring.
 *
 * IT REUSES `INTERNAL_WEBRTC_TOKEN` RATHER THAN ADDING A THIRD SECRET, which is
 * the same call `realtime-ingress-server` records: this is the identical trust
 * relationship the internal media API already has, first-party to first-party,
 * and a separate credential for the same relationship means two secrets to
 * rotate, two ways to misconfigure, and no more security.
 *
 * IT REFUSES TO BE PUBLIC. With no internal token configured the route is not
 * registered at all. An open push endpoint lets anybody make anybody's phone
 * ring, at any hour, as often as they like -- so the failure mode of a missing
 * secret must be a service that cannot push, never a service that pushes for
 * strangers.
 */
import type express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import type { PushDispatcher } from './push/push-dispatcher.js';
import type { PushKind, PushPrivacy, PushUrgency } from './push/push-provider.js';

export interface PushRouteDependencies {
  readonly push: PushDispatcher;
  readonly auth: InternalIngressAuthResolution;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

const KINDS: readonly PushKind[] = ['call', 'message', 'system'];
const PRIVACIES: readonly PushPrivacy[] = ['visible', 'discreet'];
const URGENCIES: readonly PushUrgency[] = ['high', 'normal'];

/** Bearer, or the raw header. Both are what a first-party client sends. */
function presentedToken(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return header.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length) : header;
}

/** Strings only: both providers flatten payloads, so this refuses early. */
function readData(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

export function registerPushRoutes(app: express.Express, deps: PushRouteDependencies): void {
  if (deps.auth.mode === 'unconfigured') {
    /*
     * Not registered, and said out loud. A 404 from an unregistered route is
     * the correct outcome, but a silent one would leave somebody debugging why
     * calls do not ring with nothing to go on.
     */
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message:
          'Internal push endpoint NOT registered: no INTERNAL_WEBRTC_TOKEN. No service can ring a phone.',
      }),
    );
    return;
  }

  app.post('/internal/push', async (req, res) => {
    if (!internalIngressRequestAllowed(deps.auth, presentedToken(req))) {
      deps.onEvent?.('push.refused', { reason: 'bad-internal-token' });
      res.status(404).json({ error: 'Not found.' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : '';
    const kind = body['kind'] as PushKind;
    const privacy = (body['privacy'] ?? 'visible') as PushPrivacy;
    const urgency = (body['urgency'] ?? 'normal') as PushUrgency;
    const data = readData(body['data']);

    if (accountId.length === 0 || !KINDS.includes(kind) || data === null) {
      res.status(400).json({
        error: `Needs accountId, kind (${KINDS.join('|')}) and a string-valued data object.`,
      });
      return;
    }
    if (!PRIVACIES.includes(privacy) || !URGENCIES.includes(urgency)) {
      res.status(400).json({ error: 'Unknown privacy or urgency.' });
      return;
    }

    const summary = await deps.push.notify(accountId, {
      kind,
      privacy,
      urgency,
      title: typeof body['title'] === 'string' ? body['title'] : undefined,
      body: typeof body['body'] === 'string' ? body['body'] : undefined,
      data,
      collapseId: typeof body['collapseId'] === 'string' ? body['collapseId'] : undefined,
    });

    /*
     * 200 with a summary, not 202. The caller is usually setting up a call and
     * "no devices registered" is something it may want to act on -- by not
     * waiting for an answer that cannot arrive.
     */
    res.json({ summary });
  });
}
