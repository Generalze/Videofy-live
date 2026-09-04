/** @author masterzee001 */
/**
 * The bypass on the plane that was already governed.
 *
 * The safety buffer has always held captions and translated audio to the
 * cursor -- as EVENTS. The BYTES were served by a route that asked nothing:
 * `/sessions/:id/generated-audio/segments/:id/audio` handed over any segment
 * it could find on disk. Translated audio is produced from the original as it
 * arrives, so a protected programme's next forty-five seconds of speech exist
 * there long before the audience may hear them, and segment ids are
 * sequential.
 *
 * A manifest of released segments is necessary and nowhere near sufficient
 * when a caller can count. This is the check that makes counting useless.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import {
  registerGeneratedAudioDeliveryRoute,
  type GeneratedAudioReleaseGuard,
} from '../generated-audio-delivery-route.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;

async function get(app: express.Express, path: string): Promise<{ status: number; text: string }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/** A delivery service that always has the bytes, so only the gate can refuse. */
function alwaysHasAudio(): { getGeneratedAudioFile: (s: string, g: string) => Promise<unknown> } {
  const directory = mkdtempSync(join(tmpdir(), 'videofy-genaudio-'));
  return {
    getGeneratedAudioFile: async (sessionId: string, segmentId: string) => {
      const audioPath = join(directory, `${segmentId}.wav`);
      writeFileSync(audioPath, Buffer.from(`AUDIO-${segmentId}`.padEnd(64, '.')));
      return {
        sessionId,
        segmentId,
        sequence: 0,
        targetLanguage: 'fr',
        voiceId: 'v',
        durationMs: 1000,
        providerLatencyMs: null,
        audioPath,
        sizeBytes: 64,
      };
    },
  };
}

/** A run with a real cursor, and generated audio placed across it. */
function governedRig(): {
  readonly app: express.Express;
  readonly registry: ProgrammeTimelineRegistry;
} {
  const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    media: true,
  });
  const timeline = registry.open(RUN);
  registry.noteSession('sess_1', 'run_1');

  // Three minutes of programme; the audience is 45 s behind.
  for (let ms = 0; ms < 180_000; ms += 5_000) {
    timeline.append({
      programmeTimeMs: ms,
      kind: 'generated-audio',
      reference: `seg_${ms}`,
      durationMs: 5_000,
    });
  }
  registry.buffer('run_1')?.advance();

  const guard: GeneratedAudioReleaseGuard = {
    assess: (sessionId, segmentId) => {
      const runId = registry.runForSession(sessionId);
      if (runId === null) return 'not-governed';
      const status = registry.status(runId);
      if (status === null) return 'not-governed';
      const event = registry
        .timeline(runId)
        ?.all()
        .find((entry) => entry.kind === 'generated-audio' && entry.reference === segmentId);
      if (event === undefined) return 'not-governed';
      return event.programmeTimeMs <= status.cursor.publicOutputTimeMs ? 'public' : 'not-yet-public';
    },
  };

  const app = express();
  registerGeneratedAudioDeliveryRoute(app, alwaysHasAudio() as never, guard);
  return { app, registry };
}

describe('translated audio the cursor has released', () => {
  it('is served', async () => {
    const { app } = governedRig();
    const reply = await get(app, '/sessions/sess_1/generated-audio/segments/seg_0/audio');
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('AUDIO-seg_0');
  });
});

describe('translated audio the cursor is still holding', () => {
  it('is refused, even though the bytes are right there', async () => {
    const { app } = governedRig();
    /*
     * 175 s into a broadcast whose audience is at 135 s. The file exists, the
     * delivery service would hand it over, and this is the whole point: the
     * only thing standing between a counter and the future is this check.
     */
    const reply = await get(app, '/sessions/sess_1/generated-audio/segments/seg_175000/audio');
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain('AUDIO-');
  });

  it('refuses every segment beyond the cursor, not merely the newest', async () => {
    const { app } = governedRig();
    for (const at of [140_000, 150_000, 160_000, 175_000]) {
      const reply = await get(app, `/sessions/sess_1/generated-audio/segments/seg_${at}/audio`);
      expect(reply.status).toBe(403);
    }
  });

  it('serves everything up to the cursor and nothing past it', async () => {
    const { app } = governedRig();
    const boundary = await get(app, '/sessions/sess_1/generated-audio/segments/seg_130000/audio');
    const past = await get(app, '/sessions/sess_1/generated-audio/segments/seg_140000/audio');
    expect(boundary.status).toBe(200);
    expect(past.status).toBe(403);
  });
});

describe('what the gate deliberately does not do', () => {
  it('leaves an ungoverned session alone', async () => {
    const { app } = governedRig();
    // A programme that holds nothing back has nothing to withhold, and a
    // session with no protected run is the ordinary case.
    const reply = await get(app, '/sessions/sess_other/generated-audio/segments/seg_0/audio');
    expect(reply.status).toBe(200);
  });

  it('does not turn an unknown segment id into a confirmation', async () => {
    const { app } = governedRig();
    /*
     * Reporting "withheld" for an id the timeline has never seen would tell a
     * caller that every id they guess exists. Unknown stays unknown, answered
     * by the delivery service rather than by the gate.
     */
    const reply = await get(app, '/sessions/sess_1/generated-audio/segments/invented/audio');
    expect(reply.status).not.toBe(403);
  });

  it('forgets a session when its run is released', async () => {
    const { registry } = governedRig();
    registry.release('run_1');
    // Otherwise a later session could inherit a run that no longer exists,
    // and be governed by a cursor nobody is moving.
    expect(registry.runForSession('sess_1')).toBeNull();
  });
});

describe('the composition root applies it', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('passes a real guard rather than registering the route bare', () => {
    expect(source).toContain('registerGeneratedAudioDeliveryRoute(app, ingest, {');
    expect(source).toContain('programmeTimelines.runForSession(sessionId)');
    expect(source).toContain('status.cursor.publicOutputTimeMs');
  });
});
