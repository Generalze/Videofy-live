/** @owner masterzee001 */
/**
 * Taking a voice back has to actually take it back (P6.3).
 *
 * The store has supported revocation and deletion since wave 2 and nothing
 * exposed either, while the interface offered a "Delete my voice" button that
 * cleared a local preview and told the server nothing. So these tests are less
 * about the lifecycle — which is covered where it lives — and more about the
 * two properties a door has to have: it reaches the material, and it only opens
 * for the person it belongs to.
 */
import express from 'express';
import { parseVoiceOwnerId } from '@videofy-live/participant-contracts';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerVoiceWithdrawalRoutes } from '../voice-withdrawal-route.js';
import { personalVoiceId } from '../openvoice-personal-voice.js';
import {
  VoiceProfileStore,
  type ArtifactDeleteResult,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';

const OWNER = 'acct_aaaaaaaaaaaaaaaa';
const INTRUDER = 'acct_bbbbbbbbbbbbbbbb';

interface Harness {
  url: string;
  store: VoiceProfileStore;
  recordings: Map<string, Uint8Array>;
  assets: Set<string>;
  /** Personal voices whose generated audio was destroyed, in order. */
  purged: string[];
  /** Make storage refuse, the way an unreachable voice engine does. */
  failDeletes: boolean;
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const recordings = new Map<string, Uint8Array>();
  const assets = new Set<string>();
  const purged: string[] = [];
  const state = { failDeletes: false };
  let serial = 0;

  const storage: VoiceEnrollmentStoragePort = {
    writeEnrollmentRecording: async (profileId, audio) => {
      const ref = `rec_${profileId}_${++serial}`;
      recordings.set(ref, audio);
      return ref;
    },
    readEnrollmentRecording: async (ref) => recordings.get(ref) ?? null,
    deleteEnrollmentRecording: async (ref): Promise<ArtifactDeleteResult> => {
      if (state.failDeletes) return 'failed';
      return recordings.delete(ref) ? 'removed' : 'not-found';
    },
    deleteVoiceAsset: async (ref): Promise<ArtifactDeleteResult> => {
      if (state.failDeletes) return 'failed';
      return assets.delete(ref) ? 'removed' : 'not-found';
    },
  };

  const store = new VoiceProfileStore(storage);
  const app = express();
  registerVoiceWithdrawalRoutes(app, {
    store,
    personalVoiceIdFor: personalVoiceId,
    // The route's real authentication is a verified bearer token; these tests
    // are about ownership rules, so they inject a stand-in that names the
    // caller directly. Token verification has its own tests.
    authenticate: (req) => parseVoiceOwnerId(req.header('x-videofy-voice-owner')),
    purgeGeneratedAudio: async (voiceId) => {
      purged.push(voiceId);
      return 2;
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    store,
    recordings,
    assets,
    purged,
    get failDeletes() {
      return state.failDeletes;
    },
    set failDeletes(value: boolean) {
      state.failDeletes = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function enrolled(h: Harness, profileId: string, ownerId: string): Promise<void> {
  h.store.begin({ voiceProfileId: profileId, ownerId, consentTextVersion: 'v1' });
  h.store.grantCallUse(profileId);
  await h.store.attachEnrollmentRecording(profileId, new Uint8Array([1, 2, 3]), 'en');
  h.assets.add(`ov2_${profileId}`);
  h.store.accept(profileId, `ov2_${profileId}`);
}

async function send(
  h: Harness,
  method: 'POST' | 'DELETE',
  path: string,
  ownerId?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.url}${path}`, {
    method,
    headers: ownerId ? { 'x-videofy-voice-owner': ownerId } : {},
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('a voice can be taken back', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('revocation stops the voice and removes the material behind it', async () => {
    await enrolled(h, 'vp1', OWNER);

    const result = await send(h, 'POST', '/voice-profiles/vp1/revocation', OWNER);

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ personalVoiceReady: false, nothingLeft: true });
    expect(h.store.usableForOwner(OWNER)).toBeNull();
    expect(h.recordings.size).toBe(0);
    expect(h.assets.size).toBe(0);
  });

  it('destroys audio that was ALREADY generated, not just future audio', async () => {
    // Translated speech is queued ahead of playback in every listener's
    // browser. Withdrawal that only changed routing would let several more
    // cloned utterances play out while the system reported compliance.
    await enrolled(h, 'vp1', OWNER);

    const result = await send(h, 'POST', '/voice-profiles/vp1/revocation', OWNER);

    expect(h.purged).toEqual([personalVoiceId('vp1')]);
    expect(result.json['generatedAudioRemoved']).toBe(2);
  });

  it('deletion leaves the system as though the person never enrolled', async () => {
    await enrolled(h, 'vp1', OWNER);

    const result = await send(h, 'DELETE', '/voice-profiles/vp1', OWNER);

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ deleted: true, nothingLeft: true });
    expect(h.store.get('vp1')).toBeNull();
    expect(h.recordings.size).toBe(0);
  });

  it('says so when material survived, instead of claiming it is gone', async () => {
    // "Your recording has been deleted" must not be printed over a failure.
    await enrolled(h, 'vp1', OWNER);
    h.failDeletes = true;

    const result = await send(h, 'DELETE', '/voice-profiles/vp1', OWNER);

    expect(result.json['nothingLeft']).toBe(false);
    expect(String(result.json['message'])).toMatch(/retried/i);
    // And the pointer needed to finish the job is kept.
    expect(h.store.pendingCleanups()).toHaveLength(1);
  });
});

describe('a voice can only be taken back by its owner', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('refuses another owner, and does not confirm the profile exists', async () => {
    // Distinguishing "not yours" from "no such profile" would turn this route
    // into a way of discovering whose voice ids are real.
    await enrolled(h, 'vp1', OWNER);

    const intruder = await send(h, 'DELETE', '/voice-profiles/vp1', INTRUDER);
    const absent = await send(h, 'DELETE', '/voice-profiles/vp_nonexistent', INTRUDER);

    expect(intruder.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(intruder.json).toEqual(absent.json);
    // Untouched.
    expect(h.store.usableForOwner(OWNER)).not.toBeNull();
    expect(h.purged).toEqual([]);
  });

  it('refuses a request with no voice identity at all', async () => {
    await enrolled(h, 'vp1', OWNER);

    expect((await send(h, 'DELETE', '/voice-profiles/vp1')).status).toBe(401);
    expect((await send(h, 'POST', '/voice-profiles/vp1/revocation')).status).toBe(401);
    expect(h.store.usableForOwner(OWNER)).not.toBeNull();
  });
});

describe('“delete my voice” erases everything this browser holds', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => h.close());

  it('deletes every profile for the owner, and nobody else’s', async () => {
    // Owner-scoped because a browser returning tomorrow knows its identity and
    // not which profile it once created.
    await enrolled(h, 'vp1', OWNER);
    await enrolled(h, 'vp2', OWNER);
    await enrolled(h, 'vp_other', INTRUDER);

    const result = await send(h, 'DELETE', '/voice-profiles', OWNER);

    expect(result.json).toMatchObject({ deleted: 2, nothingLeft: true });
    expect(h.store.usableForOwner(OWNER)).toBeNull();
    expect(h.store.usableForOwner(INTRUDER)).not.toBeNull();
    expect(h.purged).toEqual([personalVoiceId('vp2'), personalVoiceId('vp1')]);
  });

  it('treats erasing nothing as success', async () => {
    // Somebody who never enrolled and asks to be erased has got what they
    // asked for. Reporting an error invites a caller to treat it as a failure.
    const result = await send(h, 'DELETE', '/voice-profiles', OWNER);

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ deleted: 0, nothingLeft: true });
  });
});
