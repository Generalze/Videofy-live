import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from './logger.js';

export function createApp(): express.Application {
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

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled express error', { message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
