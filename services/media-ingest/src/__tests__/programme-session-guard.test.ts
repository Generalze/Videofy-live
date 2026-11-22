/** @author masterzee001 */
/**
 * THE OTHER THREE DOORS.
 *
 * `programme-egress-routes.ts` opens by calling itself "the only door the
 * audience has, and every lock on it". An audit on 29 Sep 2026 found it is
 * one of four. Three routes keyed by SESSION rather than by run served a
 * broadcast's media and asked nothing about who was asking: the original
 * file, the viewer encode, and the translated audio. Only the third had any
 * guard, and that one governs the cursor, not the channel.
 *
 * The session id is not a secret. The gateway broadcasts it to every listener
 * on the channel as `programmeMediaUrl`. So on a LOCKED channel anyone who
 * was ever in the room could fetch the complete original file -- and on a
 * delayed broadcast the original file is also the future, which is the one
 * thing the compliance delay exists to withhold.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createProgrammeSessionGuard } from '../programme-session-guard.js';
import type { AudienceVerdict } from '../programme-egress-routes.js';

interface Asked {
  readonly runId: string;
}

function rig(options: {
  readonly runForSession?: (sessionId: string) => string | null;
  readonly verdict?: AudienceVerdict | (() => never);
}) {
  const asked: Asked[] = [];
  const guard = createProgrammeSessionGuard({
    runForSession: options.runForSession ?? (() => 'run_1'),
    mayView: (runId) => {
      asked.push({ runId });
      const verdict = options.verdict ?? 'allow';
      if (typeof verdict === 'function') return verdict();
      return verdict;
    },
  });
  const app = express();
  app.get('/sessions/:sessionId/source-media', guard, (_req, res) => {
    res.status(200).send('THE-ORIGINAL-FILE');
  });
  return { app, asked };
}

async function get(app: express.Express, path: string) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const reply = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await reply.text();
  await new Promise<void>((done) => server.close(() => done()));
  return { status: reply.status, body };
}

describe('a broadcast session is judged by its channel', () => {
  it('serves media when the audience door says allow', async () => {
    const r = rig({ verdict: 'allow' });
    const reply = await get(r.app, '/sessions/cs_1/source-media');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('THE-ORIGINAL-FILE');
  });

  /*
   * THE DEFECT, DIRECTLY. Before this guard existed the body below was
   * served to anybody who had the session id, on a locked channel, with no
   * question asked.
   */
  it('serves NOTHING when the door forbids, and does not say why', async () => {
    const r = rig({ verdict: 'forbidden' });
    const reply = await get(r.app, '/sessions/cs_1/source-media');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('THE-ORIGINAL-FILE');
  });

  it('asks about the RUN the session belongs to, not the session', async () => {
    const r = rig({ runForSession: () => 'run_locked', verdict: 'allow' });
    await get(r.app, '/sessions/cs_1/source-media');
    expect(r.asked).toEqual([{ runId: 'run_locked' }]);
  });

  it('invites a sign-in only where signing in would help', async () => {
    const r = rig({ verdict: 'sign-in' });
    expect((await get(r.app, '/sessions/cs_1/source-media')).status).toBe(401);
  });

  it('answers an unknown run exactly as it answers a locked one', async () => {
    // Different statuses here would let an anonymous caller discover which
    // sessions are real by watching which refusal came back.
    const locked = await get(rig({ verdict: 'forbidden' }).app, '/sessions/cs_1/source-media');
    const unknown = await get(rig({ verdict: 'unknown-run' }).app, '/sessions/cs_1/source-media');
    expect(locked.status).toBe(unknown.status);
    expect(locked.body).toBe(unknown.body);
  });

  it('fails CLOSED when the policy throws, because nothing is not a yes', async () => {
    const r = rig({
      verdict: () => {
        throw new Error('the account service is unreachable');
      },
    });
    const reply = await get(r.app, '/sessions/cs_1/source-media');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('THE-ORIGINAL-FILE');
  });
});

describe('a session that is not a broadcast is left alone', () => {
  /*
   * Uploads and recordings that never went on air are reached by an
   * unguessable session id, and that is the arrangement they have always
   * had. Narrowing it here would be widening a different decision under
   * cover of fixing this one. Pinned so the choice is visible rather than
   * discovered later as a surprise.
   */
  it('does not ask the audience door about a session with no run', async () => {
    const r = rig({ runForSession: () => null, verdict: 'forbidden' });
    const reply = await get(r.app, '/sessions/cs_upload/source-media');
    expect(reply.status).toBe(200);
    expect(r.asked).toEqual([]);
  });
});
