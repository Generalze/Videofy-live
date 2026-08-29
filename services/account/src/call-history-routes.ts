/** @author masterzee001 */
/**
 * Call history ingest: the gateway reports a finished direct call here over
 * the internal token, and the conversation timeline shows it to both people.
 *
 * Same trust boundary as /internal/push: one token, the gateway's, and a 404
 * for anything else so the route is not probeable.
 */
import express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { parseCallRecord, type CallRecordPort } from './call-records.js';

export interface CallHistoryRouteDependencies {
  readonly calls: CallRecordPort;
  readonly auth: InternalIngressAuthResolution;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

function presentedToken(req: express.Request): string | undefined {
  const header = req.header('X-Videofy-Internal-Token');
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

export function registerCallHistoryRoutes(
  app: express.Express,
  deps: CallHistoryRouteDependencies,
): void {
  if (deps.auth.mode === 'unconfigured') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message: 'Internal call-history endpoint NOT registered: no INTERNAL_WEBRTC_TOKEN.',
      }),
    );
    return;
  }

  app.post('/internal/calls', async (req, res) => {
    if (!internalIngressRequestAllowed(deps.auth, presentedToken(req))) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    const record = parseCallRecord(req.body);
    if (record === null) {
      res.status(400).json({ error: 'Not a call record.' });
      return;
    }
    await deps.calls.upsert(record);
    deps.onEvent?.('call.recorded', {
      outcome: record.outcome,
      mode: record.mode,
      durationSeconds: record.durationSeconds,
    });
    res.status(201).json({ recorded: true });
  });
}
