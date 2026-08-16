/** @owner masterzee001 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUnavailablePersonalVoiceProvider } from '../personal-voice-provider.js';
import {
  MAX_ENROLLMENT_BYTES,
  registerVoiceEnrollmentRoute,
} from '../voice-enrollment-route.js';
import {
  VoiceProfileStore,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';
import type { VoiceProfileProvider } from '../voice-profile-provider.js';

const OWNER = 'devid_aaaaaaaaaaaa';
const CONSENT_VERSION = 'voice-consent-v1';

function createStorage() {
  const recordings = new Map<string, Uint8Array>();
  let serial = 0;
  const port: VoiceEnrollmentStoragePort = {
    writeEnrollmentRecording: async (profileId, audio) => {
      const ref = `rec_${profileId}_${++serial}`;
      recordings.set(ref, audio);
      return ref;
    },
    deleteEnrollmentRecording: async (ref) => recordings.delete(ref),
    deleteVoiceAsset: async () => true,
  };
  return { port, recordings };
}

interface Harness {
  url: string;
  store: VoiceProfileStore;
  recordings: Map<string, Uint8Array>;
  close: () => Promise<void>;
}

async function createHarness(provider?: VoiceProfileProvider): Promise<Harness> {
  const storage = createStorage();
  const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
  const app = express();
  registerVoiceEnrollmentRoute(app, {
    store,
    provider: provider ?? createUnavailablePersonalVoiceProvider(),
    newVoiceProfileId: () => 'vp_generated',
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    recordings: storage.recordings,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function post(
  harness: Harness,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}/voice-profiles/vp1/enrollment`, {
    method: 'POST',
    headers: {
      'content-type': 'audio/webm',
      'x-videofy-voice-owner': OWNER,
      ...headers,
    },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/**
 * A real WebM/Matroska EBML header, because the route now identifies the
 * container from the bytes. The previous fixture was arbitrary numbers with an
 * audio/webm header — exactly the mismatch the check exists to refuse.
 */
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);

describe('consent gates the endpoint, not just the store call', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => harness.close());

  it('stores nothing when call-use consent has not been granted', async () => {
    // The whole point: a browser request must not be able to create biometric
    // material by arriving before permission does.
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });

    const response = await post(harness, AUDIO);

    expect(response.status).toBe(409);
    expect(harness.recordings.size).toBe(0);
  });

  it('stores nothing when no profile exists at all', async () => {
    const response = await post(harness, AUDIO);

    expect(response.status).toBe(409);
    expect(harness.recordings.size).toBe(0);
  });

  it('accepts the recording once consent exists', async () => {
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');

    const response = await post(harness, AUDIO);

    expect(response.status).toBe(202);
    expect(harness.recordings.size).toBe(1);
  });
});

describe('ownership is resolved from the trusted identity path', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');
  });
  afterEach(async () => harness.close());

  it('refuses a participant id or display name in the owner header', async () => {
    for (const candidate of ['participant_1', 'Zoe Meak', 'socket-abc']) {
      const response = await post(harness, AUDIO, { 'x-videofy-voice-owner': candidate });
      expect(response.status).toBe(400);
    }
    expect(harness.recordings.size).toBe(0);
  });

  it('refuses a request with no identity at all', async () => {
    const response = await fetch(`${harness.url}/voice-profiles/vp1/enrollment`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: AUDIO,
    });

    expect(response.status).toBe(400);
    expect(harness.recordings.size).toBe(0);
  });
});

describe('transport validation', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');
  });
  afterEach(async () => harness.close());

  it('refuses a format it does not accept', async () => {
    const response = await post(harness, AUDIO, { 'content-type': 'application/zip' });

    expect(response.status).toBe(415);
    expect(harness.recordings.size).toBe(0);
  });

  it('refuses an oversized recording rather than writing it', async () => {
    const oversized = new Uint8Array(MAX_ENROLLMENT_BYTES + 1024);

    const response = await post(harness, oversized).catch(() => ({ status: 413, json: {} }));

    expect(response.status).toBe(413);
    expect(harness.recordings.size).toBe(0);
  });

  it('refuses an empty body', async () => {
    const response = await post(harness, new Uint8Array(0));

    expect(response.status).toBe(400);
    expect(harness.recordings.size).toBe(0);
  });
});

describe('an unavailable clone engine never produces a ready profile', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');
  });
  afterEach(async () => harness.close());

  it('keeps the recording, reports honestly, and leaves the profile unusable', async () => {
    const response = await post(harness, AUDIO);

    expect(response.status).toBe(202);
    expect(response.json['personalVoiceReady']).toBe(false);
    // The recording survives so a validated engine can derive from it later
    // without asking anyone to record again.
    expect(harness.recordings.size).toBe(1);
    expect(harness.store.usableForOwner(OWNER)).toBeNull();
  });

  it('never leaks a recording reference, asset reference or owner id to the browser', async () => {
    const response = await post(harness, AUDIO);

    const body = JSON.stringify(response.json);
    expect(body).not.toContain('rec_');
    expect(body).not.toContain('asset_');
    expect(body).not.toContain(OWNER);
    expect(body).not.toMatch(/\.wav|\.webm|[A-Za-z]:\\/);
  });
});

describe('a working clone engine completes enrollment', () => {
  it('marks the profile ready only when a real asset came back', async () => {
    // Proves the 202/201 split is driven by the provider rather than by the
    // upload succeeding.
    const provider: VoiceProfileProvider = {
      resolve: vi.fn(async () => ({ ok: true as const, voiceId: 'personal_vp1' })),
      createAsset: vi.fn(async () => ({ ok: true as const, voiceAssetRef: 'asset_vp1' })),
    };
    const harness = await createHarness(provider);
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');

    const response = await post(harness, AUDIO);

    expect(response.status).toBe(201);
    expect(response.json['personalVoiceReady']).toBe(true);
    expect(harness.store.usableForOwner(OWNER)?.voiceProfileId).toBe('vp1');
    await harness.close();
  });
});

describe('the bytes are the authority, not the header', () => {
  it('refuses audio announced as one format and sent as another', async () => {
    // A caller claiming audio/wav while sending WebM is either confused or
    // probing, and neither earns the filename it asked for.
    const harness = await createHarness();
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');

    const response = await post(harness, AUDIO, { 'content-type': 'audio/wav' });

    expect(response.status).toBe(415);
    expect(harness.recordings.size).toBe(0);
    await harness.close();
  });

  it('refuses bytes that are not audio at all', async () => {
    const harness = await createHarness();
    harness.store.begin({
      voiceProfileId: 'vp1',
      ownerId: OWNER,
      consentTextVersion: CONSENT_VERSION,
    });
    harness.store.grantCallUse('vp1');

    const response = await post(harness, new TextEncoder().encode('not audio at all'));

    expect(response.status).toBe(415);
    expect(harness.recordings.size).toBe(0);
    await harness.close();
  });
});
