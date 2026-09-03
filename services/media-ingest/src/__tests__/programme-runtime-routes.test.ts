/** @author masterzee001 */
/**
 * The route a console reads truth from.
 *
 * Every assertion here is about a sentence somebody might otherwise print
 * without evidence: a delay that is not being held, a pipeline that has never
 * run reported as healthy, or a broadcast this process knows nothing about
 * answered for anyway.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import { registerProgrammeRuntimeRoutes } from '../programme-runtime-routes.js';
import { ProgrammePerformanceRegistry } from '../programme-performance-registry.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Drive the handler the way express would, without opening a port. */
async function get(
  app: express.Express,
  path: string,
): Promise<Reply> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function appWith(
  performance: ProgrammePerformanceRegistry,
  timelines: ProgrammeTimelineRegistry,
): express.Express {
  const app = express();
  registerProgrammeRuntimeRoutes(app, { performance, timelines });
  return app;
}

describe('a broadcast this process is not running', () => {
  it('is a 404, not a status full of defaults', async () => {
    const reply = await get(
      appWith(new ProgrammePerformanceRegistry(), new ProgrammeTimelineRegistry()),
      '/programmes/run_absent/runtime',
    );
    /*
     * Another process may be running it. Answering with zeroes would let a
     * console show a healthy-looking broadcast that this service has never
     * heard of -- "not running here" and "running with nothing to report" are
     * different facts and must not render identically.
     */
    expect(reply.status).toBe(404);
  });

  it('refuses a run id that is not a run id', async () => {
    const reply = await get(
      appWith(new ProgrammePerformanceRegistry(), new ProgrammeTimelineRegistry()),
      '/programmes/..%2Fescape/runtime',
    );
    expect(reply.status).toBe(400);
  });
});

describe('a running broadcast reports what is true', () => {
  it('reports no samples rather than zeroes for a route that has done nothing', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    timelines.open(RUN);
    const reply = await get(
      appWith(new ProgrammePerformanceRegistry(), timelines),
      '/programmes/run_1/runtime',
    );

    expect(reply.status).toBe(200);
    // Empty, not a row of confident zeroes.
    expect(reply.body['routes']).toEqual([]);
  });

  it('reports measured latency once work has actually happened', async () => {
    const performance = new ProgrammePerformanceRegistry();
    performance.for('run_1', 'en', 'yo').for('translation').record('success', 420, 1);
    const timelines = new ProgrammeTimelineRegistry();
    timelines.open(RUN);

    const reply = await get(appWith(performance, timelines), '/programmes/run_1/runtime');
    const routes = reply.body['routes'] as { translation: { p50Ms: number | null } }[];
    expect(routes[0]?.translation.p50Ms).toBe(420);
  });

  it('reports the buffer as filling, with the depth it is really holding', async () => {
    const timelines = new ProgrammeTimelineRegistry(32, 45_000);
    const timeline = timelines.open(RUN);
    for (let i = 0; i < 12; i += 1) {
      timeline.append({ programmeTimeMs: i * 1000, kind: 'media', reference: `s${i}`, durationMs: 1000 });
    }
    timelines.buffer('run_1')?.advance();

    const reply = await get(appWith(new ProgrammePerformanceRegistry(), timelines), '/programmes/run_1/runtime');
    const buffer = reply.body['safetyBuffer'] as {
      state: string;
      protected: boolean;
      configuredDelayMs: number;
      cursor: { bufferDepthMs: number };
    };

    // Configured forty-five, holding twelve, protected by none. This is the
    // exact combination a console must never render as "On-air delay: 45 s".
    expect(buffer.state).toBe('filling');
    expect(buffer.configuredDelayMs).toBe(45_000);
    expect(buffer.cursor.bufferDepthMs).toBe(12_000);
    expect(buffer.protected).toBe(false);
  });

  it('says whether the safety promise would survive a restart', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    timelines.open(RUN);
    const reply = await get(appWith(new ProgrammePerformanceRegistry(), timelines), '/programmes/run_1/runtime');

    // No store configured here, so the honest answer is that it would not.
    expect(reply.body['durability']).toEqual({
      durable: false,
      reason: 'no durable timeline store is configured',
    });
  });
});

describe('the runtime view carries no content', () => {
  it('reports timings and a cursor, and nothing anybody said', async () => {
    const performance = new ProgrammePerformanceRegistry();
    performance.for('run_1', 'en', 'yo').for('stt').record('success', 100, 1);
    const timelines = new ProgrammeTimelineRegistry();
    const timeline = timelines.open(RUN);
    timeline.append({
      programmeTimeMs: 0,
      kind: 'caption',
      reference: 'seg_0',
      attributes: { language: 'en' },
    });

    const reply = await get(appWith(performance, timelines), '/programmes/run_1/runtime');
    const serialised = JSON.stringify(reply.body).toLowerCase();

    /*
     * The forbidden thing is CONTENT, not the words for it. A `vocabulary`
     * field is fine and necessary -- it reports a revision, a count and a
     * state. What may never appear is a term, a transcript, a campaign or a
     * credential, so the assertion names those rather than banning a heading.
     */
    for (const forbidden of ['transcript', 'keyterm', 'campaign', 'token', 'password']) {
      expect(serialised).not.toContain(forbidden);
    }

    // And the vocabulary that IS reported carries no terms.
    const vocabulary = reply.body['vocabulary'] as Record<string, unknown>;
    expect(Object.keys(vocabulary).sort()).toEqual(['revision', 'state', 'termCount']);
  });
});
