import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CONNECT_API_BASE_PATH, buildErrorEnvelope } from '@videofy-live/connect-contracts';
import { logger } from './logger.js';

export interface CreateAppOptions {
  /**
   * Developer-surface diagnostics provider (§5.1: engineering state is
   * role-gated). Exposed only when WEBRTC_DIAGNOSTICS_ENABLED=true, and only
   * to requests carrying the internal token when one is configured.
   */
  diagnostics?: () => unknown;
  internalToken?: string | null;
  /**
   * P6.5: lazy provider for the Connect /v1 router. A closure, not a router,
   * for the same reason diagnostics is a closure: index.ts builds this app
   * BEFORE the Gateway exists, and the router needs the Gateway's Connect
   * facade. Resolved once, on the first /v1 request.
   */
  connectV1Router?: () => express.Router;
}

export function createApp(options: CreateAppOptions = {}): express.Application {
  const app = express();

  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug('HTTP request', { method: req.method, path: req.path });
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'realtime-gateway',
      timestamp: new Date().toISOString(),
    });
  });

  if (options.diagnostics && process.env['WEBRTC_DIAGNOSTICS_ENABLED'] === 'true') {
    app.get('/internal/diagnostics', (req: Request, res: Response) => {
      if (options.internalToken && req.header('X-Videofy-Internal-Token') !== options.internalToken) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json(options.diagnostics!());
    });
  }

  // P6.5: the Connect control plane, mounted BEFORE the 404 catch-all.
  if (options.connectV1Router) {
    const provide = options.connectV1Router;
    let router: express.Router | null = null;
    app.use(CONNECT_API_BASE_PATH, (req: Request, res: Response, next: NextFunction) => {
      router ??= provide();
      router(req, res, next);
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // /v1 keeps its envelope discipline even for failures that happen before
    // the router runs — most notably express.json() refusing a body. The
    // rest of the gateway keeps its legacy error shape untouched.
    if (req.originalUrl.startsWith(`${CONNECT_API_BASE_PATH}/`) && !res.headersSent) {
      const status = (err as { status?: number }).status;
      const inboundRequestId = req.headers['x-request-id'];
      const requestId =
        typeof inboundRequestId === 'string' && inboundRequestId.trim() !== ''
          ? inboundRequestId.trim().slice(0, 128)
          : `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      res.setHeader('X-Request-Id', requestId);
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res
          .status(400)
          .json(
            buildErrorEnvelope(
              'INVALID_REQUEST',
              'The request body could not be parsed as JSON.',
              requestId,
            ),
          );
        return;
      }
      logger.error('Unhandled express error on /v1', { message: err.message });
      res
        .status(500)
        .json(buildErrorEnvelope('INTERNAL', 'Something went wrong handling this request.', requestId));
      return;
    }
    logger.error('Unhandled express error', { message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
