/** @author masterzee001 */
/**
 * The Zoom webhook endpoint: the only door into this service.
 *
 * Two things happen here and nothing else. Zoom validates a newly-registered
 * endpoint by challenge, and Zoom announces that a stream has started,
 * stopped or been interrupted. Every delivery is authenticated before it is
 * read: an unsigned request never reaches the session layer, because a forged
 * meeting.rtms_started would otherwise make this service dial an attacker's
 * websocket carrying our own signature.
 *
 * `meeting.rtms_interrupted` is handled distinctly from `stopped`. Treating an
 * interruption as terminal is the documented way to turn a recoverable blip
 * into a dropped meeting.
 */
import express, { type Request, type Response } from 'express';
import { signaturesMatch, urlValidationResponse, webhookSignature } from './credentials.js';

export interface RtmsStreamStart {
  meetingUuid: string;
  rtmsStreamId: string;
  /** Webhook shape: a BARE STRING, unlike the handshake response's object. */
  signalingServerUrl: string;
}

export interface WebhookHandlers {
  onStreamStarted(start: RtmsStreamStart): Promise<void>;
  onStreamStopped(input: { meetingUuid: string; rtmsStreamId: string; reason: string }): Promise<void>;
  onStreamInterrupted(input: { meetingUuid: string; rtmsStreamId: string }): Promise<void>;
  /** Account-level warnings worth acting on before streams start failing. */
  onConcurrencyWarning?(event: string): void;
}

export interface WebhookOptions {
  secretToken: string;
  handlers: WebhookHandlers;
  log?: (line: string, detail?: Record<string, unknown>) => void;
  /** Injectable clock for the freshness window. */
  now?: () => number;
  /** How old a signed delivery may be. Zoom's own guidance is five minutes. */
  maxDeliveryAgeMs?: number;
  /** Hosts we are willing to dial. Defaults to Zoom's own domains. */
  allowedHostSuffixes?: readonly string[];
}

const DEFAULT_ALLOWED_HOSTS = ['.zoom.us', '.zoom.com'] as const;

/**
 * Only `wss:`, and only a Zoom host. Without this, a forged - or merely
 * mistaken - payload sends SIGNALING_HAND_SHAKE_REQ, which carries a live HMAC
 * under our CLIENT SECRET, to whatever host it names.
 */
export function isAllowedSignalingUrl(
  candidate: string,
  allowedHostSuffixes: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:') return false;
  const host = url.hostname.toLowerCase();
  return allowedHostSuffixes.some(
    (suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix),
  );
}

/**
 * Fire-and-forget, but never unhandled: Zoom wants a prompt 2xx, so handler
 * work is not awaited — and an escaping rejection from that work would be an
 * unhandled rejection rather than a log line.
 */
function detach(
  work: Promise<void>,
  log: (line: string, detail?: Record<string, unknown>) => void,
  event: string,
): void {
  void work.catch((error) => {
    log('zoom webhook handler failed', {
      event,
      message: error instanceof Error ? error.message : 'unknown',
    });
  });
}

function readPayload(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  const payload = (body as Record<string, unknown>)['payload'];
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  return typeof value === 'string' ? value : '';
}

export function buildZoomWebhookApp(options: WebhookOptions): express.Express {
  const app = express();
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;

  // The raw body is the signed material, so it must be captured verbatim:
  // re-serializing a parsed object changes key order and whitespace and
  // silently breaks every signature check.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
      },
    }),
  );

  app.post('/zoom/webhook', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const event = stringField(body, 'event');
    const payload = readPayload(body);

    // AUTHENTICATE FIRST - including the validation challenge.
    //
    // The challenge answers HMAC(secret, plainToken) under the SAME secret and
    // algorithm that signs webhooks. Answering it before verifying turns this
    // endpoint into a signing oracle: an attacker submits
    // `v0:{timestamp}:{forged body}` as the plainToken, receives a valid
    // signature, and replays it as a genuine meeting.rtms_started - which
    // would make this service dial their websocket carrying a live HMAC of our
    // client secret. Zoom signs every delivery, so demanding it costs nothing.
    const presented = req.header('x-zm-signature') ?? '';
    const timestamp = req.header('x-zm-request-timestamp') ?? '';
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const expected = webhookSignature({ secretToken: options.secretToken, timestamp, rawBody });
    if (presented === '' || !signaturesMatch(expected, presented)) {
      // Deliberately terse: an attacker learns nothing about why.
      log('zoom webhook refused', { event });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // A signature alone makes a captured delivery valid forever. Recovered
    // from a proxy log months later, a genuine rtms_started would still open a
    // session; the timestamp is already signed, so binding it to the clock
    // costs nothing and closes the replay.
    const deliveredAtMs = Number.parseInt(timestamp, 10) * 1000;
    const maxAgeMs = options.maxDeliveryAgeMs ?? 5 * 60_000;
    if (!Number.isFinite(deliveredAtMs) || Math.abs(now() - deliveredAtMs) > maxAgeMs) {
      log('zoom webhook refused: stale delivery', { event });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (event === 'endpoint.url_validation') {
      const plainToken = stringField(payload, 'plainToken');
      res.status(200).json(urlValidationResponse(options.secretToken, plainToken));
      return;
    }

    const meetingUuid = stringField(payload, 'meeting_uuid');
    const rtmsStreamId = stringField(payload, 'rtms_stream_id');

    switch (event) {
      case 'meeting.rtms_started': {
        const signalingServerUrl = stringField(payload, 'server_urls');
        if (meetingUuid === '' || rtmsStreamId === '' || signalingServerUrl === '') {
          res.status(400).json({ error: 'incomplete rtms_started payload' });
          return;
        }
        // The url decides who receives our stream signature. A signed-but-
        // hostile payload must not point us at an arbitrary host.
        if (!isAllowedSignalingUrl(signalingServerUrl, options.allowedHostSuffixes)) {
          log('zoom webhook refused: disallowed signaling host', { event });
          res.status(400).json({ error: 'disallowed signaling url' });
          return;
        }
        detach(options.handlers.onStreamStarted({ meetingUuid, rtmsStreamId, signalingServerUrl }), log, event);
        break;
      }
      case 'meeting.rtms_stopped':
        detach(
          options.handlers.onStreamStopped({
            meetingUuid,
            rtmsStreamId,
            reason: stringField(payload, 'reason'),
          }),
          log,
          event,
        );
        break;
      case 'meeting.rtms_interrupted':
        // Recoverable by contract — the session layer reconnects rather than
        // tearing the meeting down.
        detach(options.handlers.onStreamInterrupted({ meetingUuid, rtmsStreamId }), log, event);
        break;
      case 'rtms.concurrency_limited':
      case 'rtms.concurrency_near_limit':
        options.handlers.onConcurrencyWarning?.(event);
        break;
      default:
        // Unknown events are accepted and ignored: Zoom adds events, and a
        // 4xx would make them retry something we will never understand.
        break;
    }

    // Zoom expects a prompt 2xx; the work is deliberately not awaited here.
    res.status(204).end();
  });

  return app;
}
