/** @owner masterzee001 */
/**
 * Taking a voice back (P6.3).
 *
 * VoiceProfileStore has supported revocation, deletion and cleanup retry since
 * wave 2, and until now nothing exposed any of them — so consent could be given
 * through the interface and never withdrawn through it. A promise with no door
 * is not a promise, and "Delete my voice" was a button that cleared a preview.
 *
 * Two verbs, kept separate because they answer different questions:
 *
 *   revocation — "stop using my voice". The profile survives as a record that
 *                consent was withdrawn and when; the material does not.
 *   deletion   — "erase me". The record goes too, and afterwards the system
 *                behaves exactly as though the person never enrolled.
 *
 * Both destroy audio that was ALREADY generated. Withdrawal that only changed
 * future routing would leave cloned utterances sitting in listeners' playback
 * queues, playing out one after another while the system reported compliance.
 *
 * Nothing here is logged — not the owner, not the profile, not a reference.
 * A log line naming any of them would preserve exactly what was just withdrawn.
 */
import type express from 'express';
import type { VoiceOwnerId } from '@videofy-live/participant-contracts';
import type { AuthenticateRequest } from './account-authentication.js';
import { isDeletionComplete, type VoiceProfileStore } from './voice-profile-store.js';

export interface VoiceWithdrawalRouteDependencies {
  readonly store: VoiceProfileStore;
  /**
   * The opaque personal voice id for a profile, so already-generated audio can
   * be found. Injected rather than imported so this file stays ignorant of how
   * a personal voice is named.
   */
  readonly personalVoiceIdFor: (voiceProfileId: string) => string;
  /** Destroy generated audio spoken in that voice; returns how many went. */
  readonly purgeGeneratedAudio: (personalVoiceId: string) => Promise<number>;
  /**
   * Establishes who is calling from a verified session token. Injected so this
   * route never learns how a token is signed, and so tests cannot accidentally
   * exercise a different rule from the one production uses.
   */
  readonly authenticate: AuthenticateRequest;
}

/**
 * The same answer for "no such profile" and "not yours".
 *
 * Distinguishing them would turn this route into a way to discover whether a
 * given profile id exists, which is a question only its owner should be able
 * to ask.
 */
const NOT_FOUND = { error: 'No voice was found for this account.' } as const;

type Resolved =
  | { readonly ok: true; readonly ownerId: VoiceOwnerId; readonly voiceProfileId: string }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

function resolveOwnedProfile(
  deps: VoiceWithdrawalRouteDependencies,
  req: express.Request,
): Resolved {
  const ownerId = deps.authenticate(req);
  if (!ownerId) {
    return { ok: false, status: 401, body: { error: 'Sign in to continue.' } };
  }
  const voiceProfileId = req.params.voiceProfileId ?? '';
  if (!voiceProfileId) {
    return { ok: false, status: 404, body: { ...NOT_FOUND } };
  }
  const stored = deps.store.get(voiceProfileId);
  // Ownership is checked HERE and not left to the store, because the store's
  // job is the lifecycle and this is the only place that knows who is asking.
  if (!stored || stored.profile.ownerId !== ownerId) {
    return { ok: false, status: 404, body: { ...NOT_FOUND } };
  }
  return { ok: true, ownerId, voiceProfileId };
}

export function registerVoiceWithdrawalRoutes(
  app: express.Express,
  deps: VoiceWithdrawalRouteDependencies,
): void {
  app.post('/voice-profiles/:voiceProfileId/revocation', (req, res) => {
    const resolved = resolveOwnedProfile(deps, req);
    if (!resolved.ok) {
      res.status(resolved.status).json(resolved.body);
      return;
    }

    void (async () => {
      // Audio first. Between revoking and purging there is a window in which
      // clips are unplayable-by-policy but still fetchable, and doing it the
      // other way round makes that window longer for no benefit.
      const removed = await deps.purgeGeneratedAudio(
        deps.personalVoiceIdFor(resolved.voiceProfileId),
      );
      const outcome = await deps.store.revoke(resolved.voiceProfileId);
      if (!outcome) {
        res.status(404).json({ ...NOT_FOUND });
        return;
      }
      res.status(200).json({
        state: outcome.profile.state,
        personalVoiceReady: false,
        // What actually happened, in the caller's terms.
        generatedAudioRemoved: removed,
        // False means something survived and is queued for another attempt.
        // Saying so is the difference between evidence and an assertion.
        nothingLeft: !outcome.cleanupRetryRequired,
      });
    })().catch(() => {
      res.status(500).json({ error: 'Your voice could not be withdrawn.' });
    });
  });

  /**
   * "Delete my voice" — everything this account holds.
   *
   * Owner-scoped rather than profile-scoped because that is the question the
   * person is actually asking, and because a client signing in tomorrow knows
   * its account and not which profile it once created. A profile-only endpoint
   * would work exactly once, in the session that made it.
   *
   * Deleting nothing is a success. Someone who asks to be erased and never
   * enrolled has got what they asked for, and saying "not found" would invite a
   * caller to treat their absence as an error.
   */
  app.delete('/voice-profiles', (req, res) => {
    const ownerId = deps.authenticate(req);
    if (!ownerId) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }

    void (async () => {
      const profiles = deps.store.profilesForOwner(ownerId);
      let generatedAudioRemoved = 0;
      let nothingLeft = true;
      for (const profile of profiles) {
        generatedAudioRemoved += await deps.purgeGeneratedAudio(
          deps.personalVoiceIdFor(profile.voiceProfileId),
        );
        const evidence = await deps.store.delete(profile.voiceProfileId);
        if (!isDeletionComplete(evidence)) nothingLeft = false;
      }
      res.status(200).json({
        deleted: profiles.length,
        generatedAudioRemoved,
        nothingLeft,
        ...(nothingLeft
          ? {}
          : {
              message:
                'Your voice is no longer usable and your records are gone. Some stored ' +
                'material could not be removed yet and will be retried.',
            }),
      });
    })().catch(() => {
      res.status(500).json({ error: 'Your voice could not be deleted.' });
    });
  });

  app.delete('/voice-profiles/:voiceProfileId', (req, res) => {
    const resolved = resolveOwnedProfile(deps, req);
    if (!resolved.ok) {
      res.status(resolved.status).json(resolved.body);
      return;
    }

    void (async () => {
      const removed = await deps.purgeGeneratedAudio(
        deps.personalVoiceIdFor(resolved.voiceProfileId),
      );
      const evidence = await deps.store.delete(resolved.voiceProfileId);
      res.status(200).json({
        deleted: evidence.recordRemoved,
        generatedAudioRemoved: removed,
        nothingLeft: isDeletionComplete(evidence),
        ...(evidence.cleanupRetryRequired
          ? {
              message:
                'Your voice is no longer usable and your record is gone. Some stored ' +
                'material could not be removed yet and will be retried.',
            }
          : {}),
      });
    })().catch(() => {
      res.status(500).json({ error: 'Your voice could not be deleted.' });
    });
  });
}
