/** @author masterzee001 */
/**
 * "The platform is up" is not "a programme can be broadcast".
 *
 * Production's gateway and account service both reported healthy for days
 * while media ingest crash-looped 106,722 times and no programme could be
 * transcribed, translated or spoken at all. Every signal an operator checks
 * first was green, and the one that mattered was not being asked.
 *
 * These assertions are about the gateway no longer claiming a capability it
 * cannot see -- and about not overcorrecting either, because a gateway with no
 * ingest still carries calls perfectly well.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

async function health(app: express.Application): Promise<Record<string, unknown>> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('what the gateway says about programme media', () => {
  it('reports capable when an ingest is connected', async () => {
    const body = await health(createApp({ mediaIngestConnected: () => true }));
    expect(body['programmeMediaCapable']).toBe(true);
  });

  it('reports NOT capable when no ingest is connected', async () => {
    /*
     * The incident, in one assertion. This is the field that would have been
     * false for the entire time production was reporting healthy.
     */
    const body = await health(createApp({ mediaIngestConnected: () => false }));
    expect(body['programmeMediaCapable']).toBe(false);
  });

  it('still reports the gateway itself as ok, because calls do work', async () => {
    // Overcorrecting would take signalling and calls down for a programme
    // dependency they do not have.
    const body = await health(createApp({ mediaIngestConnected: () => false }));
    expect(body['status']).toBe('ok');
  });

  it('distinguishes "cannot tell" from "no"', async () => {
    /*
     * Null, not false. "Nobody asked" and "asked, and the answer was no" must
     * not render the same -- rendering them the same is the mistake that
     * produced this incident in the first place.
     */
    const body = await health(createApp({}));
    expect(body['programmeMediaCapable']).toBeNull();
  });
});

describe('the restart storm cannot be silent again', () => {
  const units = ['videofy-prod-media-ingest', 'videofy-media-ingest'];

  it('bounds the restart rate in every unit that can crash-loop', () => {
    for (const unit of units) {
      const dir = unit.startsWith('videofy-prod') ? 'production' : 'staging';
      const text = readFileSync(
        fileURLToPath(new URL(`../../../../deploy/${dir}/systemd/${unit}.service`, import.meta.url)),
        'utf8',
      );
      /*
       * With RestartSec=3 and systemd's default limit of five starts in ten
       * seconds, only about three attempts fit in the window -- so the limit
       * can never be reached and the service restarts for ever. The window
       * below is wide enough that it can.
       */
      expect(text, `${unit} has no start limit`).toMatch(/StartLimitIntervalSec=\d+/u);
      expect(text).toMatch(/StartLimitBurst=\d+/u);

      const interval = Number(/StartLimitIntervalSec=(\d+)/u.exec(text)?.[1] ?? 0);
      const burst = Number(/StartLimitBurst=(\d+)/u.exec(text)?.[1] ?? 0);
      const restartSec = Number(/RestartSec=(\d+)/u.exec(text)?.[1] ?? 0);
      // The arithmetic that decides whether a limit is reachable at all.
      expect(burst * restartSec, `${unit} limit is unreachable`).toBeLessThan(interval);
    }
  });

  it('still recovers from a transient fault rather than giving up at once', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../../deploy/production/systemd/videofy-prod-media-ingest.service', import.meta.url)),
      'utf8',
    );
    // A slow dependency must not cost a broadcast, so the unit retries and
    // widens the gap rather than stopping on the first failure.
    expect(text).toContain('Restart=on-failure');
    expect(text).toMatch(/RestartMaxDelaySec=\d+/u);
  });
});
