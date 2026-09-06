/** @author masterzee001 */
/**
 * Who may watch a replay, decided by the authority that already exists.
 *
 * NO SECOND LOGIN SYSTEM. Everything about who a caller is -- the internal
 * token, the operator's session, the channel's visibility -- is already
 * answered by `createProgrammeAudienceAccess`, which decides the same question
 * for LIVE media. Replay asks it first and then narrows. Building a parallel
 * authority for recordings would mean two answers to "may this person watch
 * this channel", and the day they disagree is the day one of them is wrong
 * about somebody's private broadcast.
 *
 * THE ORDER IS THE WHOLE RULE, and it only goes one way:
 *
 *     CHANNEL AUTHORITY FIRST.  REPLAY VISIBILITY NARROWS WHAT SURVIVES IT.
 *
 * A `public` replay on a channel nobody may reach is not public. Replay
 * visibility is an ADDITIONAL permission on a stored object; it is never a way
 * around the door. Written as a narrowing rather than a second lookup so there
 * is no shape of this function in which the replay tier can widen anything.
 *
 * THE THREE TIERS, AND WHAT THEY ACTUALLY MEAN HERE:
 *
 *   `public`   -- whoever the channel already admits.
 *   `unlisted` -- the same, and it appears in no listing. Possession of the
 *                 exact run id is how you arrive; the channel still decides
 *                 whether you may be admitted at all. "Known link" was never
 *                 "no authority".
 *   `private`  -- the operator, and nobody else. Knowing the run id is not a
 *                 decision somebody made about you.
 *
 * AND IT FAILS CLOSED. If the channel's authority cannot be established -- the
 * account service is away, the run is not tracked here, the visibility never
 * resolved -- the answer is a refusal. Live behaviour is untouched by that:
 * this function is only ever asked about recordings.
 */

import type express from 'express';
import type { ReplayRecord } from '@videofy-live/programme-replay';
import type { AuthenticateRequest } from './account-authentication.js';
import type { OperatorEntitlement } from './programme-control-auth.js';
import type { ProgrammeAudienceAccess } from './programme-egress-routes.js';
import type { ReplayAudienceAccess, ReplayAudienceVerdict } from './programme-replay-routes.js';

export interface ReplayAudienceDeps {
  /** The live authority. Asked first, about the channel, exactly as it is. */
  readonly channel: ProgrammeAudienceAccess;
  readonly authenticate: AuthenticateRequest;
  readonly entitlement: OperatorEntitlement;
}

export function createReplayAudienceAccess(deps: ReplayAudienceDeps): ReplayAudienceAccess {
  return {
    async mayView(record: ReplayRecord, request: express.Request): Promise<ReplayAudienceVerdict> {
      /*
       * THE CHANNEL DECIDES FIRST, and it is asked about the run this record
       * actually belongs to rather than about anything the request supplied.
       * The route has already required those to agree.
       */
      let channelVerdict;
      try {
        channelVerdict = await deps.channel.mayView(record.identity.runId, request);
      } catch {
        // FAILS CLOSED. An authority that could not be consulted is not an
        // authority that said yes.
        return 'unknown-replay';
      }

      if (channelVerdict === 'sign-in') return 'sign-in';
      if (channelVerdict !== 'allow') {
        /*
         * `unknown-run` AND `forbidden` COLLAPSE TO ONE ANSWER. Telling a
         * caller which run ids are real is how an unlisted recording stops
         * being unlisted, and `unknown-replay` is the verdict the route turns
         * into the same 404 a missing recording gets.
         */
        return 'unknown-replay';
      }

      /* Now, and only now, the replay's own tier narrows it. */
      switch (record.visibility) {
        case 'public':
        case 'unlisted':
          /*
           * BOTH ADMIT WHOEVER THE CHANNEL ADMITS. The difference between them
           * is LISTING, which is decided in the catalogue and never here: an
           * unlisted recording is absent from every browsable list and served
           * to somebody who arrived with its address -- having already passed
           * the channel's door above.
           */
          return 'allow';
        case 'private': {
          /*
           * THE OPERATOR, AND NOBODY ELSE. Private means a decision was made
           * about who may watch, and knowing the run id is not one. Checked
           * against the same entitlement the live path uses for the operator's
           * own console, so the one person who must be able to see their own
           * recording still can.
           */
          const accountId = deps.authenticate(request);
          if (accountId !== null && deps.entitlement.hasEntitlement(accountId)) return 'allow';
          // Not `sign-in`: that would confirm the recording exists to anybody
          // who guessed its id, and they could then sign in and look again.
          return 'unknown-replay';
        }
      }
    },
  };
}
