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
  it('reports the ingest connection as its own fact', async () => {
    const connected = await health(createApp({ mediaIngestConnected: () => true }));
    expect(connected['mediaIngestConnected']).toBe(true);
    const absent = await health(createApp({ mediaIngestConnected: () => false }));
    /*
     * The incident, in one assertion. This is the field that would have been
     * false for the entire time production reported healthy.
     */
    expect(absent['mediaIngestConnected']).toBe(false);
  });

  it('does NOT call a connected ingest a capable programme path', async () => {
    /*
     * THE CORRECTION. An ingest can be connected while its providers are
     * unready, its encoder absent, its spool unavailable, its writer lease
     * held elsewhere or its route unqualified. Treating the connection as
     * capability would replace one overly broad health signal with another,
     * which is the same defect wearing a better name.
     */
    const body = await health(createApp({ mediaIngestConnected: () => true }));
    expect(body['mediaIngestConnected']).toBe(true);
    expect(body['programmeMediaCapable']).toBeNull();
  });

  it('reports capability only when something authoritative answers', async () => {
    const body = await health(
      createApp({ mediaIngestConnected: () => true, programmeMediaCapable: () => true }),
    );
    expect(body['programmeMediaCapable']).toBe(true);
  });

  it('still reports the gateway itself as ok, because calls do work', async () => {
    // Overcorrecting would take signalling and calls down for a programme
    // dependency they do not have.
    const body = await health(createApp({ mediaIngestConnected: () => false }));
    expect(body['status']).toBe('ok');
  });

  it('distinguishes "cannot tell" from "no", for both facts', async () => {
    const body = await health(createApp({}));
    expect(body['mediaIngestConnected']).toBeNull();
    expect(body['programmeMediaCapable']).toBeNull();
  });
});

/*
 * VERIFIED AGAINST REAL SYSTEMD, not only against this file.
 *
 * On the target host (systemd 255.4, Ubuntu 24.04) every candidate unit passes
 * `systemd-analyze verify`, and a throwaway unit carrying these exact settings
 * reports them back as:
 *
 *   StartLimitIntervalUSec=10min   StartLimitBurst=10
 *   RestartUSec=3s   RestartSteps=5   RestartMaxDelayUSec=1min
 *
 * which is what proves the section placement: the same keys under [Service]
 * are accepted by the file and ignored by the manager.
 *
 * A second throwaway unit of the same SHAPE with a scaled time base -- 1s to
 * 3s over three steps, six starts in sixty seconds -- was run to completion
 * and settled in `failed` after 16 seconds with NRestarts=6. So a geometric
 * backoff does reach a correctly-sized limit. That is the behaviour this file
 * can only approximate.
 *
 * ONE TRAP WORTH KEEPING: `systemctl show -p StartLimitIntervalSec` returns
 * EMPTY. The property is `StartLimitIntervalUSec`, and the same is true of
 * RestartSec and RestartMaxDelaySec. An operator checking with the names from
 * the unit file will conclude nothing is set, which is how a correct policy
 * gets "fixed" back into a broken one.
 */
describe('the restart storm cannot be silent again', () => {
  const UNITS = [
    ['production', 'videofy-prod-media-ingest'],
    ['production', 'videofy-prod-gateway'],
    ['production', 'videofy-prod-account'],
    ['staging', 'videofy-media-ingest'],
    ['staging', 'videofy-gateway'],
    ['staging', 'videofy-account'],
  ] as const;

  function unitText(dir: string, unit: string): string {
    return readFileSync(
      fileURLToPath(new URL(`../../../../deploy/${dir}/systemd/${unit}.service`, import.meta.url)),
      'utf8',
    );
  }

  /** The section a setting appears in, or null when it does not appear. */
  function sectionOf(text: string, key: string): string | null {
    let section = '';
    for (const raw of text.split(String.fromCharCode(10))) {
      const line = raw.trim();
      const header = /^\[([A-Za-z]+)\]$/u.exec(line);
      if (header) section = header[1] ?? '';
      else if (line.startsWith(`${key}=`)) return section;
    }
    return null;
  }

  function numberOf(text: string, key: string): number {
    const found = new RegExp('^' + key + '=([0-9]+)', 'mu').exec(text);
    return found === null ? Number.NaN : Number(found[1]);
  }

  /**
   * The moment of the Nth start, in seconds after the first.
   *
   * systemd widens the restart delay geometrically from RestartSec towards
   * RestartMaxDelaySec across RestartSteps, then holds it there. Any check
   * that ignores that is checking a configuration the unit does not have --
   * which is exactly how the first fix reintroduced the defect it was
   * correcting.
   */
  function nthStartAtSeconds(
    n: number,
    restartSec: number,
    steps: number,
    maxDelaySec: number,
  ): number {
    if (!Number.isFinite(steps) || steps <= 0) return (n - 1) * restartSec;
    const ratio = Math.pow(maxDelaySec / restartSec, 1 / steps);
    let at = 0;
    for (let i = 0; i < n - 1; i += 1) {
      at += Math.min(maxDelaySec, restartSec * Math.pow(ratio, i));
    }
    return at;
  }

  it('puts the start limit in the section systemd actually reads it from', () => {
    /*
     * systemd defines StartLimitIntervalSec and StartLimitBurst as Unit
     * settings. There is a [Service] compatibility alias for the older
     * StartLimitInterval spelling only -- so the modern spelling under
     * [Service] is accepted by the file and ignored by the manager, which
     * looks exactly like a limit that is set.
     */
    for (const [dir, unit] of UNITS) {
      const text = unitText(dir, unit);
      expect(sectionOf(text, 'StartLimitIntervalSec'), `${unit}`).toBe('Unit');
      expect(sectionOf(text, 'StartLimitBurst'), `${unit}`).toBe('Unit');
      expect(sectionOf(text, 'Restart'), `${unit}`).toBe('Service');
    }
  });

  it('CAN reach its own limit, against the real backoff schedule', () => {
    for (const [dir, unit] of UNITS) {
      const text = unitText(dir, unit);
      const interval = numberOf(text, 'StartLimitIntervalSec');
      const burst = numberOf(text, 'StartLimitBurst');
      const restartSec = numberOf(text, 'RestartSec');
      const steps = numberOf(text, 'RestartSteps');
      const maxDelay = numberOf(text, 'RestartMaxDelaySec');

      const forbiddenStartAt = nthStartAtSeconds(burst + 1, restartSec, steps, maxDelay);
      /*
       * The start that must be refused has to happen while the earlier ones
       * are still inside the window. With 3s -> 60s over five steps the tenth
       * start lands near 309 s, so a 300 s window can never see ten -- the
       * first fix for this incident had precisely that bug.
       */
      expect(
        forbiddenStartAt,
        `${unit}: start ${burst + 1} at ${forbiddenStartAt.toFixed(0)}s, window ${interval}s`,
      ).toBeLessThan(interval);
    }
  });

  it('still recovers from a transient fault rather than giving up at once', () => {
    const text = unitText('production', 'videofy-prod-media-ingest');
    // A slow dependency must not cost a broadcast, so the unit retries and
    // widens the gap rather than stopping on the first failure.
    expect(text).toContain('Restart=on-failure');
    expect(numberOf(text, 'RestartMaxDelaySec')).toBeGreaterThan(numberOf(text, 'RestartSec'));
  });

  it('would fail if the backoff were widened without redoing the arithmetic', () => {
    /*
     * The property under test is the calculation, not the numbers. Doubling
     * the ceiling pushes the forbidden start past the window, and this proves
     * the check above notices rather than passing on the presence of settings.
     */
    const text = unitText('production', 'videofy-prod-media-ingest');
    const interval = numberOf(text, 'StartLimitIntervalSec');
    const burst = numberOf(text, 'StartLimitBurst');
    const widened = nthStartAtSeconds(burst + 1, numberOf(text, 'RestartSec'), 5, 600);
    expect(widened).toBeGreaterThan(interval);
  });
});
