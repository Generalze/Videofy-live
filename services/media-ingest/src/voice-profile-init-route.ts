/** @owner masterzee001 */
/**
 * Starting an enrollment: creating the profile and recording consent (P6.3).
 *
 * Deliberately separate from the enrollment upload route, and deliberately
 * required before it. The upload endpoint must never auto-create a profile
 * just because audio arrived — that would let the arrival of biometric data
 * manufacture the permission needed to store biometric data, which is circular
 * and exactly backwards.
 *
 * Like the upload route, this validates transport and then hands off. Consent
 * rules live in VoiceProfileStore; nothing here re-implements them.
 *
 * Nothing is logged. The owner id alone identifies whose voice this is.
 */
import type express from 'express';
import { parseVoiceOwnerId } from '@videofy-live/participant-contracts';
import type { VoiceProfileStore } from './voice-profile-store.js';

export interface VoiceProfileInitDependencies {
  readonly store: VoiceProfileStore;
  readonly newVoiceProfileId: () => string;
}

export function registerVoiceProfileInitRoute(
  app: express.Express,
  deps: VoiceProfileInitDependencies,
): void {
  app.post('/voice-profiles', (req, res) => {
    const body = (req.body ?? {}) as {
      consentTextVersion?: unknown;
      callUseGranted?: unknown;
      trainingUseGranted?: unknown;
    };

    const ownerId = parseVoiceOwnerId(req.header('x-videofy-voice-owner'));
    if (!ownerId) {
      res.status(400).json({ error: 'This browser has no voice identity yet.' });
      return;
    }

    const consentTextVersion =
      typeof body.consentTextVersion === 'string' && body.consentTextVersion.length > 0
        ? body.consentTextVersion
        : null;
    if (!consentTextVersion) {
      res.status(400).json({ error: 'Enrollment could not be started.' });
      return;
    }

    // Call use is what enrollment asks for. Without it there is nothing to
    // create: a profile that may never hold a recording is just a record of
    // somebody having looked at a screen.
    if (body.callUseGranted !== true) {
      res.status(400).json({
        error: 'Permission to use your voice for translated speech is required.',
      });
      return;
    }

    const voiceProfileId = deps.newVoiceProfileId();
    deps.store.begin({ voiceProfileId, ownerId, consentTextVersion });
    const granted = deps.store.grantCallUse(voiceProfileId);
    if (!granted) {
      res.status(500).json({ error: 'Enrollment could not be started.' });
      return;
    }

    // Strictly separate, and only on an explicit true. Anything else — absent,
    // null, a truthy string — leaves training withheld.
    if (body.trainingUseGranted === true) {
      deps.store.grantTrainingUse(voiceProfileId);
    }

    res.status(201).json({ voiceProfileId, state: granted.state });
  });
}
