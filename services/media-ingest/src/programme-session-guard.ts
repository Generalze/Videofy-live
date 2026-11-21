/** @author masterzee001 */
/**
 * The audience door, applied to the routes that are keyed by SESSION.
 *
 * `programme-egress-routes.ts` opens by calling itself "the only door the
 * audience has, and every lock on it". An audit on 29 Sep 2026 found it is
 * one of four. Three more routes serve a broadcast's media and asked nothing
 * about who was asking:
 *
 *   GET /sessions/:sessionId/source-media                  the original file
 *   GET /sessions/:sessionId/viewer-media                  the viewer encode
 *   GET /sessions/:id/generated-audio/segments/:s/audio    translated speech
 *
 * The third had a cursor guard, so it could not serve the future. None of the
 * three asked whether the channel was LOCKED.
 *
 * WHY THAT MATTERS CONCRETELY. The session id is not a secret: the gateway
 * broadcasts it to every listener on the channel as `programmeMediaUrl`. So
 * on a locked channel, anyone admitted to the room -- or anyone who was ever
 * admitted, or who read it from a client -- could fetch the complete original
 * file. On a delayed broadcast the original file is also the future, which is
 * the one thing the compliance delay exists to withhold.
 *
 * THE BRIDGE THIS FILE IS. The door is keyed by run; these routes are keyed
 * by session. The timeline registry already knows which run a session belongs
 * to, and that mapping is the whole of the work.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. A session that belongs to no programme
 * run passes through untouched. Those are uploads and recordings that are not
 * broadcasts, they are reached by an unguessable session id, and that is the
 * arrangement they have always had. Changing it here would be widening a
 * different decision under cover of fixing this one. It is stated rather than
 * implied so the next reader knows it was considered.
 */
import type express from 'express';
import type { AudienceVerdict } from './programme-egress-routes.js';

export interface ProgrammeSessionGuardDeps {
  /** The run this session belongs to, or null when it is not a broadcast. */
  readonly runForSession: (sessionId: string) => string | null;
  /** The same policy the playlist and segment routes ask. */
  readonly mayView: (runId: string, request: express.Request) => Promise<AudienceVerdict> | AudienceVerdict;
}

/**
 * A refused viewer gets the same answer whatever the reason, except when
 * signing in would actually help.
 *
 * Identical wording to the egress routes on purpose: a locked programme and a
 * programme that does not exist must be indistinguishable, or an anonymous
 * caller can use the difference to discover which sessions are real.
 */
function refuse(res: express.Response, verdict: Exclude<AudienceVerdict, 'allow'>): void {
  if (verdict === 'sign-in') {
    res.status(401).json({ error: 'Sign in to watch this programme.' });
    return;
  }
  res.status(404).json({ error: 'No such programme.' });
}

export function createProgrammeSessionGuard(
  deps: ProgrammeSessionGuardDeps,
): express.RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const sessionId = String(req.params['sessionId'] ?? req.params['id'] ?? '');
      if (sessionId === '') {
        next();
        return;
      }
      const runId = deps.runForSession(sessionId);
      // Not a broadcast. See the note at the top of this file.
      if (runId === null) {
        next();
        return;
      }
      let verdict: AudienceVerdict;
      try {
        verdict = await deps.mayView(runId, req);
      } catch {
        /*
         * FAIL CLOSED. An access policy that threw has told us nothing, and
         * the correct reading of nothing is no. The egress routes take the
         * same position for the same reason.
         */
        refuse(res, 'forbidden');
        return;
      }
      if (verdict !== 'allow') {
        refuse(res, verdict);
        return;
      }
      next();
    })();
  };
}
