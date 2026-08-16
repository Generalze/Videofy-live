/** @owner masterzee001 */
import express from 'express';
import { parseVoiceOwnerId } from '@videofy-live/participant-contracts';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mayUseForTraining } from '@videofy-live/participant-contracts';
import { registerVoiceProfileInitRoute } from '../voice-profile-init-route.js';
import {
  VoiceProfileStore,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';

const OWNER = 'acct_aaaaaaaaaaaaaaaa';

const storagePort: VoiceEnrollmentStoragePort = {
  writeEnrollmentRecording: async () => 'rec_1',
  readEnrollmentRecording: async () => null,
  deleteEnrollmentRecording: async () => 'removed',
  deleteVoiceAsset: async () => 'removed',
};

interface Harness {
  url: string;
  store: VoiceProfileStore;
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const store = new VoiceProfileStore(storagePort, () => '2026-08-16T00:00:00.000Z');
  const app = express();
  app.use(express.json());
  let serial = 0;
  registerVoiceProfileInitRoute(app, {
    store,
    newVoiceProfileId: () => `vp_${++serial}`,
    // The route's real authentication is a verified bearer token; these tests
    // are about consent rules, so they inject a stand-in that names the caller
    // directly. Token verification has its own tests.
    authenticate: (req) => parseVoiceOwnerId(req.header('x-videofy-voice-owner')),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function post(
  harness: Harness,
  body: unknown,
  headers: Record<string, string> = { 'x-videofy-voice-owner': OWNER },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}/voice-profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('starting an enrollment', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => harness.close());

  it('creates a profile with call-use consent recorded', async () => {
    const response = await post(harness, {
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: true,
    });

    expect(response.status).toBe(201);
    const profileId = response.json['voiceProfileId'] as string;
    const stored = harness.store.get(profileId);
    expect(stored?.profile.consent.callUseGrantedAt).not.toBeNull();
    expect(stored?.profile.state).toBe('enrolling');
  });

  it('leaves training withheld unless it was separately and explicitly granted', async () => {
    // The whole reason the two grants are separate fields.
    const response = await post(harness, {
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: true,
    });
    const stored = harness.store.get(response.json['voiceProfileId'] as string);

    expect(stored && mayUseForTraining(stored.profile)).toBe(false);
  });

  it('grants training only on an explicit true, never on something truthy', async () => {
    for (const value of ['yes', 1, {}, null]) {
      const response = await post(harness, {
        consentTextVersion: 'voice-consent-v1',
        callUseGranted: true,
        trainingUseGranted: value,
      });
      const stored = harness.store.get(response.json['voiceProfileId'] as string);
      expect(stored && mayUseForTraining(stored.profile)).toBe(false);
    }

    const granted = await post(harness, {
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: true,
      trainingUseGranted: true,
    });
    const stored = harness.store.get(granted.json['voiceProfileId'] as string);
    expect(stored && mayUseForTraining(stored.profile)).toBe(true);
  });

  it('refuses to create anything without call-use consent', async () => {
    // A profile that may never hold a recording is just a record of somebody
    // having looked at a screen.
    const response = await post(harness, {
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: false,
    });

    expect(response.status).toBe(400);
    expect(harness.store.usableForOwner(OWNER)).toBeNull();
    expect(harness.store.get('vp_1')).toBeNull();
  });

  it('refuses an owner identity that did not come from the trusted path', async () => {
    for (const candidate of ['participant_1', 'Zoe Meak', 'socket-abc']) {
      const response = await post(
        harness,
        { consentTextVersion: 'voice-consent-v1', callUseGranted: true },
        { 'x-videofy-voice-owner': candidate },
      );
      // Unauthenticated, not malformed: nothing about the request was wrong
      // except that it did not establish who was making it.
      expect(response.status).toBe(401);
    }
    expect(harness.store.get('vp_1')).toBeNull();
  });

  it('refuses without a recorded consent wording version', async () => {
    // A later dispute is settled by evidence of what was agreed to.
    const response = await post(harness, { callUseGranted: true });

    expect(response.status).toBe(400);
    expect(harness.store.get('vp_1')).toBeNull();
  });

  it('does not echo the owner id back to the browser', async () => {
    const response = await post(harness, {
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: true,
    });

    expect(JSON.stringify(response.json)).not.toContain(OWNER);
  });
});
