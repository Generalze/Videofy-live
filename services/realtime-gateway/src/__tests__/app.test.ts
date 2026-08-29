import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type ConferenceStatus } from '../app.js';

describe('Express app health endpoint', () => {
  it('createApp returns an express application', () => {
    const app = createApp();
    expect(typeof app).toBe('function');
    expect(app.listen).toBeDefined();
  });
});

/*
 * Founder ruling (29 Aug 2026): "An ended conference is terminal. The Recent
 * row should show Ended and must not silently recreate a room under that old
 * code." The route exists so a client can tell Ended from never-existed, and
 * it must say nothing else: a private room's code is not a lookup key.
 */
describe('GET /calls/:callId/status', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function serve(app: ReturnType<typeof createApp>): Promise<string> {
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  function statusApp(asked: string[] = []) {
    const known: Record<string, ConferenceStatus> = { 'live-1': 'active', 'gone-1': 'ended' };
    return createApp({
      callStatus: (callId) => {
        asked.push(callId);
        return known[callId] ?? 'unknown';
      },
    });
  }

  it('answers the status word and nothing else, uncached', async () => {
    const base = await serve(statusApp());

    for (const [callId, expected] of [
      ['live-1', 'active'],
      ['gone-1', 'ended'],
      ['never-1', 'unknown'],
    ] as const) {
      const response = await fetch(`${base}/calls/${callId}/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ status: expected });
    }
  });

  it('treats a malformed id as unknown without asking the store', async () => {
    const asked: string[] = [];
    const base = await serve(statusApp(asked));

    const response = await fetch(`${base}/calls/${encodeURIComponent('no spaces')}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unknown' });
    expect(asked).toEqual([]);
  });

  it('is not mounted when no provider is given', async () => {
    const base = await serve(createApp());
    const response = await fetch(`${base}/calls/live-1/status`);
    expect(response.status).toBe(404);
  });
});
