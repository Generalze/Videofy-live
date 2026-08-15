import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from './logger.js';

export interface CreateAppOptions {
  /**
   * Developer-surface diagnostics provider (§5.1: engineering state is
   * role-gated). Exposed only when WEBRTC_DIAGNOSTICS_ENABLED=true, and only
   * to requests carrying the internal token when one is configured.
   */
  diagnostics?: () => unknown;
  internalToken?: string | null;
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

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled express error', { message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
