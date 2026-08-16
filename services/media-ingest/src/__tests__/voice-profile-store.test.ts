/** @owner masterzee001 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isVoiceProfileUsable,
  mayUseForTraining,
} from '@videofy-live/participant-contracts';
import {
  invalidateQueuedPersonalAudio,
  isDeletionComplete,
  VoiceProfileStore,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';
import { describeSyntheticVoice } from '../voice-profile-provider.js';

/** In-memory stand-in that records exactly what was asked to disappear. */
function createStorage() {
  const recordings = new Map<string, Uint8Array>();
  const assets = new Set<string>();
  let serial = 0;

  const port: VoiceEnrollmentStoragePort = {
    writeEnrollmentRecording: vi.fn(async (profileId: string, audio: Uint8Array) => {
      const ref = `rec_${profileId}_${++serial}`;
      recordings.set(ref, audio);
      return ref;
    }),
    deleteEnrollmentRecording: vi.fn(async (ref: string) => recordings.delete(ref)),
    deleteVoiceAsset: vi.fn(async (ref: string) => assets.delete(ref)),
  };
  return { port, recordings, assets };
}

const CONSENT_VERSION = 'voice-consent-v1';
const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('enrollment', () => {
  let storage: ReturnType<typeof createStorage>;
  let store: VoiceProfileStore;

  beforeEach(() => {
    storage = createStorage();
    let tick = 0;
    store = new VoiceProfileStore(storage.port, () =>
      new Date(Date.UTC(2026, 7, 16, 0, 0, ++tick)).toISOString(),
    );
  });

  it('refuses to store enrollment audio before call-use consent exists', async () => {
    // The moment biometric material would otherwise land on disk ahead of
    // permission. Ordering must not be what protects it.
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });

    const result = await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    expect(result).toBeNull();
    expect(storage.port.writeEnrollmentRecording).not.toHaveBeenCalled();
    expect(storage.recordings.size).toBe(0);
  });

  it('walks consent → recording → accepted, and only then is it usable', async () => {
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    expect(store.usableForParticipant('p1')).toBeNull();

    store.grantCallUse('vp1');
    expect(store.usableForParticipant('p1')).toBeNull();

    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    expect(store.usableForParticipant('p1')).toBeNull();

    const ready = store.accept('vp1', 'asset_1');
    expect(ready && isVoiceProfileUsable(ready)).toBe(true);
    expect(store.usableForParticipant('p1')?.voiceProfileId).toBe('vp1');
  });

  it('leaves training consent withheld through the whole enrollment', async () => {
    // P6.3 records eligibility only. Enrolling must not quietly create a
    // training grant along the way; VI-L0 owns the governed path.
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    const ready = store.accept('vp1', 'asset_1');

    expect(ready && mayUseForTraining(ready)).toBe(false);
  });

  it('keeps the raw recording separate from the derived asset', async () => {
    // Conflating them lets deletion report success having removed only one.
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    store.accept('vp1', 'asset_1');

    const stored = store.get('vp1');
    expect(stored?.enrollmentRecordingRef).toBe('rec_vp1_1');
    expect(stored?.profile.voiceAssetRef).toBe('asset_1');
    expect(stored?.enrollmentRecordingRef).not.toBe(stored?.profile.voiceAssetRef);
  });
});

describe('revocation during an active call', () => {
  let storage: ReturnType<typeof createStorage>;
  let store: VoiceProfileStore;

  beforeEach(async () => {
    storage = createStorage();
    store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    storage.assets.add('asset_1');
    store.accept('vp1', 'asset_1');
  });

  it('switches future synthesis to standard and orders the queue invalidated', async () => {
    const outcome = await store.revoke('vp1');

    expect(outcome?.nextSynthesisVoice).toBe('standard');
    expect(outcome?.invalidateQueuedPersonalAudio).toBe(true);
    expect(store.usableForParticipant('p1')).toBeNull();
  });

  it('removes the stored material rather than only marking the record', async () => {
    await store.revoke('vp1');

    expect(storage.recordings.size).toBe(0);
    expect(storage.assets.size).toBe(0);
  });
});

describe('invalidateQueuedPersonalAudio', () => {
  it('drops queued-but-unplayed personal audio', () => {
    // Without this, a speaker who revokes consent hears several more cloned
    // utterances play out while the system considers itself compliant.
    const queue = [
      { id: 'a', voice: 'personal' as const, played: true },
      { id: 'b', voice: 'personal' as const, played: false },
      { id: 'c', voice: 'standard' as const, played: false },
      { id: 'd', voice: 'personal' as const, played: false },
    ];

    expect(invalidateQueuedPersonalAudio(queue).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('leaves already-played items alone, because they are history', () => {
    const queue = [{ id: 'a', voice: 'personal' as const, played: true }];

    expect(invalidateQueuedPersonalAudio(queue)).toHaveLength(1);
  });
});

describe('deletion evidence', () => {
  it('reports each artefact separately rather than asserting success', async () => {
    // A record flagged deleted while the WAV sits on disk is not deletion.
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    storage.assets.add('asset_1');
    store.accept('vp1', 'asset_1');

    const evidence = await store.delete('vp1');

    expect(evidence.recordRemoved).toBe(true);
    expect(evidence.voiceAssetRemoved).toBe('removed');
    expect(evidence.enrollmentRecordingRemoved).toBe('removed');
    expect(isDeletionComplete(evidence)).toBe(true);
    expect(storage.recordings.size).toBe(0);
    expect(storage.assets.size).toBe(0);
    expect(store.get('vp1')).toBeNull();
  });

  it('reports failure honestly when storage will not give the audio up', async () => {
    const storage = createStorage();
    storage.port.deleteEnrollmentRecording = vi.fn(async () => {
      throw new Error('disk is busy');
    });
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    const evidence = await store.delete('vp1');

    expect(evidence.enrollmentRecordingRemoved).toBe('failed');
    expect(isDeletionComplete(evidence)).toBe(false);
  });

  it('leaves a deleted participant behaving exactly as if they never enrolled', async () => {
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', participantId: 'p1', consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    store.accept('vp1', 'asset_1');

    await store.delete('vp1');

    expect(store.usableForParticipant('p1')).toBeNull();
  });
});

describe('describeSyntheticVoice', () => {
  it('discloses a personal voice in human words, never a model id', () => {
    expect(describeSyntheticVoice({ voice: 'personal', speakerDisplayName: 'Zoe' })).toBe(
      "Zoe's translated voice",
    );
    expect(describeSyntheticVoice({ voice: 'standard' })).toBe('Translated voice');
  });

  it('still discloses when the speaker has no display name', () => {
    // A personal voice is a machine speaking either way, and listeners are
    // entitled to know that.
    expect(describeSyntheticVoice({ voice: 'personal' })).toBe('Personal translated voice');
  });
});
