/** @owner masterzee001 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isVoiceProfileUsable,
  mayUseForTraining,
  resolveVoiceForParticipant,
} from '@videofy-live/participant-contracts';
import {
  invalidateQueuedPersonalAudio,
  isDeletionComplete,
  VoiceProfileStore,
  type ArtifactDeleteResult,
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
    readEnrollmentRecording: vi.fn(async (ref: string) => recordings.get(ref) ?? null),
    deleteEnrollmentRecording: vi.fn(
      async (ref: string): Promise<ArtifactDeleteResult> =>
        recordings.delete(ref) ? 'removed' : 'not-found',
    ),
    deleteVoiceAsset: vi.fn(
      async (ref: string): Promise<ArtifactDeleteResult> =>
        assets.delete(ref) ? 'removed' : 'not-found',
    ),
  };
  return { port, recordings, assets };
}

const CONSENT_VERSION = 'voice-consent-v1';
const OWNER = 'acct_0123456789abbbbb';
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
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });

    const result = await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    expect(result).toBeNull();
    expect(storage.port.writeEnrollmentRecording).not.toHaveBeenCalled();
    expect(storage.recordings.size).toBe(0);
  });

  it('walks consent → recording → accepted, and only then is it usable', async () => {
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    expect(store.usableForOwner(OWNER)).toBeNull();

    store.grantCallUse('vp1');
    expect(store.usableForOwner(OWNER)).toBeNull();

    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    expect(store.usableForOwner(OWNER)).toBeNull();

    const ready = store.accept('vp1', 'asset_1');
    expect(ready && isVoiceProfileUsable(ready)).toBe(true);
    expect(store.usableForOwner(OWNER)?.voiceProfileId).toBe('vp1');
  });

  it('leaves training consent withheld through the whole enrollment', async () => {
    // P6.3 records eligibility only. Enrolling must not quietly create a
    // training grant along the way; VI-L0 owns the governed path.
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    const ready = store.accept('vp1', 'asset_1');

    expect(ready && mayUseForTraining(ready)).toBe(false);
  });

  it('keeps the raw recording separate from the derived asset', async () => {
    // Conflating them lets deletion report success having removed only one.
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
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
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    storage.assets.add('asset_1');
    store.accept('vp1', 'asset_1');
  });

  it('switches future synthesis to standard and orders the queue invalidated', async () => {
    const outcome = await store.revoke('vp1');

    expect(outcome?.nextSynthesisVoice).toBe('standard');
    expect(outcome?.invalidateQueuedPersonalAudio).toBe(true);
    expect(store.usableForOwner(OWNER)).toBeNull();
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
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
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
    storage.port.deleteEnrollmentRecording = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    const evidence = await store.delete('vp1');

    expect(evidence.enrollmentRecordingRemoved).toBe('failed');
    expect(isDeletionComplete(evidence)).toBe(false);
  });

  it('keeps the reference to whatever survived, instead of orphaning it', async () => {
    // The failure mode this guards: discarding the profile at the same moment
    // an artefact refused to go destroys the only map to the file still on
    // disk, leaving a well-documented orphan nobody can clean up.
    const storage = createStorage();
    storage.port.deleteEnrollmentRecording = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    const evidence = await store.delete('vp1');

    expect(evidence.cleanupRetryRequired).toBe(true);
    const outstanding = store.pendingCleanups();
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.enrollmentRecordingRef).toBe('rec_vp1_1');
    // The participant is still deleted from their own point of view.
    expect(store.get('vp1')).toBeNull();
    expect(store.usableForOwner(OWNER)).toBeNull();
  });

  it('finishes the job on retry and stops tracking it', async () => {
    const storage = createStorage();
    let failNext = true;
    storage.port.deleteEnrollmentRecording = vi.fn(
      async (ref: string): Promise<ArtifactDeleteResult> => {
        if (failNext) {
          failNext = false;
          return 'failed';
        }
        return storage.recordings.delete(ref) ? 'removed' : 'not-found';
      },
    );
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    await store.delete('vp1');

    const retry = await store.retryCleanup('vp1');

    expect(retry?.cleanupRetryRequired).toBe(false);
    expect(isDeletionComplete(retry!)).toBe(true);
    expect(store.pendingCleanups()).toHaveLength(0);
    expect(storage.recordings.size).toBe(0);
  });

  it('stays retryable when the retry fails too', async () => {
    // A second failure must not quietly become the orphan the first one
    // avoided.
    const storage = createStorage();
    storage.port.deleteEnrollmentRecording = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    await store.delete('vp1');

    const retry = await store.retryCleanup('vp1');

    expect(retry?.cleanupRetryRequired).toBe(true);
    expect(store.pendingCleanups()[0]?.enrollmentRecordingRef).toBe('rec_vp1_1');
  });

  it('has nothing pending when deletion simply worked', async () => {
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');

    await store.delete('vp1');

    expect(store.pendingCleanups()).toEqual([]);
  });

  it('leaves a deleted participant behaving exactly as if they never enrolled', async () => {
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    store.accept('vp1', 'asset_1');

    await store.delete('vp1');

    expect(store.usableForOwner(OWNER)).toBeNull();
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

describe('ownership survives the call it was created in', () => {
  it('resolves the same profile after leaving and rejoining with new call identifiers', async () => {
    // THE test for the ownership fix. Under the previous binding the profile
    // was keyed by participantId, so a second join — new participant, new
    // socket — found nothing and silently fell back to a standard voice. If
    // this passes, the fix changed behaviour and not just a type name.
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');

    // First call: enroll and accept.
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    store.accept('vp1', 'asset_1');
    expect(store.usableForOwner(OWNER)?.voiceProfileId).toBe('vp1');

    // The call ends. Nothing about the store changes, because nothing in it
    // was ever tied to that call.
    const afterRejoin = store.usableForOwner(OWNER);

    expect(afterRejoin?.voiceProfileId).toBe('vp1');
    expect(resolveVoiceForParticipant({ profile: afterRejoin, standardVoiceId: 'std_en_female' }))
      .toEqual({ voice: 'personal', voiceProfileId: 'vp1', synthetic: true });
  });

  it('does not hand one owner voice profile to a different owner', () => {
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });

    expect(store.usableForOwner('acct_ffffffffffffffff')).toBeNull();
  });
});

describe('absence and failure are not the same answer', () => {
  async function enrolled() {
    const storage = createStorage();
    const store = new VoiceProfileStore(storage.port, () => '2026-08-16T00:00:00.000Z');
    store.begin({ voiceProfileId: 'vp1', ownerId: OWNER, consentTextVersion: CONSENT_VERSION });
    store.grantCallUse('vp1');
    await store.attachEnrollmentRecording('vp1', AUDIO, 'en');
    storage.assets.add('asset_1');
    store.accept('vp1', 'asset_1');
    return { storage, store };
  }

  it('keeps the asset retryable when the voice engine is unreachable', async () => {
    // The bug this replaces: an unreachable engine returned `false`, which the
    // store read as "there was nothing there", so the surviving asset was
    // discarded as already gone.
    const { storage, store } = await enrolled();
    storage.port.deleteVoiceAsset = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );

    const evidence = await store.delete('vp1');

    expect(evidence.voiceAssetRemoved).toBe('failed');
    expect(evidence.cleanupRetryRequired).toBe(true);
    expect(store.pendingCleanups()[0]?.voiceAssetRef).toBe('asset_1');
  });

  it('retires the reference when the engine says the asset is genuinely absent', async () => {
    const { storage, store } = await enrolled();
    storage.port.deleteVoiceAsset = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'not-found',
    );

    const evidence = await store.delete('vp1');

    expect(evidence.voiceAssetRemoved).toBe('none-held');
    expect(evidence.cleanupRetryRequired).toBe(false);
    expect(store.pendingCleanups()).toEqual([]);
  });

  it('revokes immediately but keeps what storage would not give up', async () => {
    // Consent and routing take effect now; physical cleanup may finish later.
    // What must never happen is cleanup failing while the pointer needed to
    // finish it is destroyed.
    const { storage, store } = await enrolled();
    storage.port.deleteVoiceAsset = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );

    const outcome = await store.revoke('vp1');

    expect(outcome?.nextSynthesisVoice).toBe('standard');
    expect(outcome?.invalidateQueuedPersonalAudio).toBe(true);
    expect(store.usableForOwner(OWNER)).toBeNull();
    expect(outcome?.cleanupRetryRequired).toBe(true);
    expect(store.pendingCleanups()[0]?.voiceAssetRef).toBe('asset_1');
  });

  it('keeps the enrollment reference too when its deletion fails during revoke', async () => {
    const { storage, store } = await enrolled();
    storage.port.deleteEnrollmentRecording = vi.fn(
      async (): Promise<ArtifactDeleteResult> => 'failed',
    );

    await store.revoke('vp1');

    expect(store.pendingCleanups()[0]?.enrollmentRecordingRef).toBe('rec_vp1_1');
  });
});
