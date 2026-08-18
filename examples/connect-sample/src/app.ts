/** @author masterzee001 */
/**
 * The partner server of the R18 sample, expressed the way a real integrator
 * would write it: every Videofy interaction goes through @videofy/server-sdk,
 * the vfk_ key exists only inside that client, and the browser pages talk to
 * THIS server — never to /v1 directly.
 *
 * The route surface is deliberately a thin veneer: the SDK already validates
 * input locally (refusing before any network traffic) and types every
 * failure, so each handler is one SDK statement plus an error translation.
 */
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  VideofyApiError,
  VideofyContractError,
  VideofyInputError,
  type CallMode,
  type CallType,
  type VideofyConnectClient,
} from '@videofy/server-sdk';

export interface SampleAppOptions {
  /** The server SDK client; tests inject one whose fetch is a fake /v1. */
  connect: VideofyConnectClient;
  /** Gateway origin the pages hand to the browser SDK, via GET /api/config. */
  videofyUrl: string;
  /** Directory with host.html and join.html. */
  publicDir: string;
  /** Built @videofy/connect ESM bundle, served under /vendor/videofy-connect. */
  connectSdkDistDir: string;
  /** socket.io-client browser ESM bundle, served under /vendor/socket.io-client. */
  socketIoClientDistDir: string;
}

/** Express 4 does not forward async rejections; this hands them to the error middleware. */
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function buildSampleApp(options: SampleAppOptions): express.Express {
  const { connect } = options;
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  // The join page asks where Videofy lives instead of hardcoding it.
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({ videofyUrl: options.videofyUrl });
  });

  app.get(
    '/api/capabilities',
    asyncRoute(async (_req, res) => {
      res.json(await connect.capabilities());
    }),
  );

  app.post(
    '/api/calls',
    asyncRoute(async (req, res) => {
      // Untrusted page input goes to the SDK as-is: ITS validation is the
      // gate, and a bad value comes back as a typed local refusal (no I/O).
      const body = (req.body ?? {}) as { type?: CallType; mode?: CallMode };
      const created = await connect.calls.create({
        type: body.type as CallType,
        mode: body.mode as CallMode,
      });
      res.status(201).json(created);
    }),
  );

  app.get(
    '/api/calls/:callId/state',
    asyncRoute(async (req, res) => {
      res.json(await connect.calls.state(req.params.callId ?? ''));
    }),
  );

  app.post(
    '/api/calls/:callId/join-tokens',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as {
        subject?: unknown;
        displayName?: unknown;
        speakLanguage?: unknown;
        hearLanguage?: unknown;
      };
      // `subject` is OUR stable identity for the person (Videofy never
      // interprets it). A real partner uses its user id; the sample invents a
      // guest id when the page leaves it blank.
      const subject =
        typeof body.subject === 'string' && body.subject.trim() !== ''
          ? body.subject.trim()
          : `guest-${randomUUID().slice(0, 8)}`;
      const minted = await connect.joinTokens.create(req.params.callId ?? '', {
        participant: {
          subject,
          displayName: String(body.displayName ?? ''),
          speakLanguage: String(body.speakLanguage ?? ''),
          hearLanguage: String(body.hearLanguage ?? ''),
          // audioMode / captionsEnabled / voiceGender omitted on purpose: the
          // token response echoes the server-resolved defaults.
        },
      });
      res.status(201).json(minted);
    }),
  );

  app.post(
    '/api/calls/:callId/end',
    asyncRoute(async (req, res) => {
      res.json(await connect.calls.end(req.params.callId ?? ''));
    }),
  );

  app.use('/api', (_req: Request, res: Response) => {
    res
      .status(404)
      .json({ error: { code: 'INVALID_REQUEST', message: 'Unknown sample API path.', retryable: false } });
  });

  // The real public browser SDK, aliased from its build output — the sample
  // never re-bundles or forks it.
  app.use('/vendor/videofy-connect', express.static(options.connectSdkDistDir));
  app.use('/vendor/socket.io-client', express.static(options.socketIoClientDistDir));
  app.use(express.static(options.publicDir, { index: 'host.html' }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof VideofyInputError) {
      // Refused by the SDK before any network traffic happened.
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: error.message,
          retryable: false,
          issues: error.issues,
        },
      });
      return;
    }
    if (error instanceof VideofyApiError) {
      // A /v1 error envelope, passed through with its status. The SDK has
      // already redacted the API key from every field.
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          requestId: error.requestId,
          retryable: error.retryable,
        },
      });
      return;
    }
    if (error instanceof VideofyContractError) {
      res.status(502).json({
        error: {
          code: 'INTERNAL',
          message: 'Videofy answered off-contract; the sample server cannot interpret the response.',
          retryable: true,
        },
      });
      return;
    }
    const status =
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 500;
    res.status(status).json({
      error: {
        code: status < 500 ? 'INVALID_REQUEST' : 'INTERNAL',
        message: status < 500 ? 'Malformed request.' : 'Unexpected sample-server failure.',
        retryable: status >= 500,
      },
    });
  });

  return app;
}
