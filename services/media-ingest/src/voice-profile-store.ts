/** @owner masterzee001 */
/**
 * Personal voice enrollment lifecycle and storage (P6.3 wave 2).
 *
 * This is the DEVELOPMENT prototype store. It protects enrollment material
 * locally, keeps it out of Git, logs and fixtures, and deletes deterministically
 * — but it is not, and does not pretend to be, the commercial encrypted vault.
 * Saying so here is cheaper than someone later assuming otherwise.
 *
 * Three separations are deliberate:
 *
 *   1. The raw recording and the derived voice asset are different things with
 *      different lifetimes. They are never interchangeable blobs: deleting a
 *      profile has to account for BOTH, and a store that conflated them could
 *      report success having removed only one.
 *
 *   2. Storage is an injected port. The rules live here; the filesystem does
 *      not get to decide any of them, and the rules stay testable without I/O.
 *
 *   3. No vendor concept appears in this file. Whatever a cloning engine wants
 *      to keep — embeddings, reference audio, speaker conditioning — lives
 *      behind VoiceProfileProvider. Call has enough responsibilities without a
 *      side career in voice-model archaeology.
 */
import {
  isVoiceProfileUsable,
  revokeVoiceProfile,
  type VoiceOwnerId,
  type VoiceProfile,
} from '@videofy-live/participant-contracts';

/**
 * Storage port. Deliberately dumb: it moves bytes and reports what it removed,
 * and every rule about when that is allowed is enforced above it.
 *
 * Each delete returns whether something was actually removed, which is what
 * lets deletion produce evidence rather than an assertion.
 */
export interface VoiceEnrollmentStoragePort {
  /** Persist a raw enrollment recording; returns an opaque reference. */
  writeEnrollmentRecording(profileId: string, audio: Uint8Array): Promise<string>;
  /**
   * The bytes behind a reference, for a provider that must actually derive
   * something from them. Returns the audio, never a path: a provider that
   * learned filesystem layout would be a provider that outlives it.
   */
  readEnrollmentRecording(recordingRef: string): Promise<Uint8Array | null>;
  /** Remove a raw enrollment recording. False when nothing was there. */
  deleteEnrollmentRecording(recordingRef: string): Promise<boolean>;
  /**
   * Remove a derived voice asset. False when nothing was there.
   *
   * NOT the same storage as the enrollment recording. The derived
   * representation is owned by the voice engine's own store, and wiring both
   * deletions to one enrollment-directory helper made asset removal silently
   * impossible — it reported none-held while the representation survived.
   */
  deleteVoiceAsset(voiceAssetRef: string): Promise<boolean>;
}

/**
 * What a profile record additionally tracks in storage.
 *
 * `enrollmentRecordingRef` is separate from VoiceProfile.voiceAssetRef on
 * purpose (separation 1). The contract shape a call sees carries only the
 * derived asset; the source recording is a storage concern.
 */
export interface StoredVoiceProfile {
  readonly profile: VoiceProfile;
  readonly enrollmentRecordingRef: string | null;
}

/**
 * Proof of what deletion actually removed.
 *
 * A record flagged `deleted = true` while the source audio sits on disk is not
 * deletion, so this reports each artefact separately and `none-held` is
 * distinguished from `removed`. Only then can a caller state honestly whether
 * anything is left.
 */
export interface VoiceProfileDeletionEvidence {
  readonly voiceProfileId: string;
  readonly recordRemoved: boolean;
  readonly voiceAssetRemoved: 'removed' | 'none-held' | 'failed';
  readonly enrollmentRecordingRemoved: 'removed' | 'none-held' | 'failed';
  readonly completedAt: string;
  /**
   * True when something survived and a retry is owed.
   *
   * When this is set the store keeps a cleanup record — see
   * `pendingCleanups()` — because discarding the profile at the same moment an
   * artefact refused to go would destroy the only reference to the file still
   * on disk. Evidence that something went wrong is worth very little if it
   * comes with no way to finish the job.
   */
  readonly cleanupRetryRequired: boolean;
}

/** What is left to remove for a profile whose deletion partly failed. */
export interface PendingVoiceCleanup {
  readonly voiceProfileId: string;
  readonly voiceAssetRef: string | null;
  readonly enrollmentRecordingRef: string | null;
  readonly firstFailedAt: string;
}

/** Whether nothing identifiable remains. Anything failed means it does. */
export function isDeletionComplete(evidence: VoiceProfileDeletionEvidence): boolean {
  return evidence.recordRemoved && !evidence.cleanupRetryRequired;
}

/**
 * What must happen elsewhere when consent is withdrawn.
 *
 * `invalidateQueuedPersonalAudio` is the owner's decision, and it matters:
 * translated audio is queued ahead of playback, so without it a speaker who
 * revokes consent would hear several more cloned utterances play out while the
 * system considered itself compliant.
 */
export interface VoiceRevocationOutcome {
  readonly profile: VoiceProfile;
  readonly invalidateQueuedPersonalAudio: true;
  readonly nextSynthesisVoice: 'standard';
}

/** A queued synthesis item, as far as revocation is concerned. */
export interface QueuedVoiceItem {
  readonly voice: 'personal' | 'standard';
  readonly played: boolean;
}

/**
 * The queue after revocation: unplayed personal audio is dropped.
 *
 * Already-played items are left alone because they are history, not pending
 * output — rewriting them would be a lie about what the listener heard.
 * Standard-voice items are untouched: nobody's identity is in them.
 */
export function invalidateQueuedPersonalAudio<T extends QueuedVoiceItem>(
  queue: readonly T[],
): T[] {
  return queue.filter((item) => item.played || item.voice !== 'personal');
}

export class VoiceProfileStore {
  private readonly profiles = new Map<string, StoredVoiceProfile>();
  /**
   * Survives a partial deletion so cleanup can be retried. Deliberately not
   * part of `profiles`: the participant is deleted the moment they ask, and
   * this holds only the references needed to finish removing their data.
   */
  private readonly pending = new Map<string, PendingVoiceCleanup>();

  constructor(
    private readonly storage: VoiceEnrollmentStoragePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(voiceProfileId: string): StoredVoiceProfile | null {
    return this.profiles.get(voiceProfileId) ?? null;
  }

  /**
   * The usable profile for an OWNER, or null. Never throws.
   *
   * Keyed by owner rather than participant: a participant id is minted per
   * call, so looking up by one would find nothing on the second join.
   */
  usableForOwner(ownerId: VoiceOwnerId): VoiceProfile | null {
    for (const stored of this.profiles.values()) {
      if (stored.profile.ownerId === ownerId && isVoiceProfileUsable(stored.profile)) {
        return stored.profile;
      }
    }
    return null;
  }

  /**
   * Begin enrollment. Consent has NOT been given at this point, so no audio may
   * be captured yet; the state says so rather than relying on call ordering.
   */
  begin(input: {
    voiceProfileId: string;
    ownerId: VoiceOwnerId;
    consentTextVersion: string;
  }): VoiceProfile {
    const timestamp = this.now();
    const profile: VoiceProfile = {
      voiceProfileId: input.voiceProfileId,
      ownerId: input.ownerId,
      state: 'consent-pending',
      consent: {
        callUseGrantedAt: null,
        trainingUseGrantedAt: null,
        revokedAt: null,
        consentTextVersion: input.consentTextVersion,
      },
      enrolledLanguage: null,
      voiceAssetRef: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.profiles.set(profile.voiceProfileId, { profile, enrollmentRecordingRef: null });
    return profile;
  }

  /** Grant consent to use this voice in calls. Does NOT grant training use. */
  grantCallUse(voiceProfileId: string): VoiceProfile | null {
    const stored = this.profiles.get(voiceProfileId);
    if (!stored || stored.profile.consent.revokedAt !== null) return null;
    const timestamp = this.now();
    const profile: VoiceProfile = {
      ...stored.profile,
      state: 'enrolling',
      consent: { ...stored.profile.consent, callUseGrantedAt: timestamp },
      updatedAt: timestamp,
    };
    this.profiles.set(voiceProfileId, { ...stored, profile });
    return profile;
  }

  /**
   * Grant the separate, optional permission to train on this recording.
   *
   * Its own method rather than a flag on grantCallUse, so that granting call
   * use cannot pick this up by accident — which is the entire reason the two
   * timestamps are separate fields in the first place.
   */
  grantTrainingUse(voiceProfileId: string): VoiceProfile | null {
    const stored = this.profiles.get(voiceProfileId);
    if (!stored || stored.profile.consent.revokedAt !== null) return null;
    // Training use without call use would be a recording kept only to train
    // on, which nobody consented to by enrolling.
    if (stored.profile.consent.callUseGrantedAt === null) return null;
    const timestamp = this.now();
    const profile: VoiceProfile = {
      ...stored.profile,
      consent: { ...stored.profile.consent, trainingUseGrantedAt: timestamp },
      updatedAt: timestamp,
    };
    this.profiles.set(voiceProfileId, { ...stored, profile });
    return profile;
  }

  /**
   * Store the enrollment recording.
   *
   * Refused unless call-use consent exists. This is the point where biometric
   * material would otherwise land on disk ahead of permission, so the check is
   * here rather than in whatever happens to call it.
   */
  async attachEnrollmentRecording(
    voiceProfileId: string,
    audio: Uint8Array,
    enrolledLanguage: string,
  ): Promise<VoiceProfile | null> {
    const stored = this.profiles.get(voiceProfileId);
    if (!stored) return null;
    if (stored.profile.consent.callUseGrantedAt === null) return null;
    if (stored.profile.consent.revokedAt !== null) return null;

    const recordingRef = await this.storage.writeEnrollmentRecording(voiceProfileId, audio);
    const timestamp = this.now();
    const profile: VoiceProfile = {
      ...stored.profile,
      state: 'review',
      enrolledLanguage,
      updatedAt: timestamp,
    };
    this.profiles.set(voiceProfileId, { profile, enrollmentRecordingRef: recordingRef });
    return profile;
  }

  /** Accept a derived asset, making the profile usable. */
  accept(voiceProfileId: string, voiceAssetRef: string): VoiceProfile | null {
    const stored = this.profiles.get(voiceProfileId);
    if (!stored || stored.profile.state !== 'review') return null;
    if (stored.profile.consent.revokedAt !== null) return null;
    const timestamp = this.now();
    const profile: VoiceProfile = {
      ...stored.profile,
      state: 'ready',
      voiceAssetRef,
      updatedAt: timestamp,
    };
    this.profiles.set(voiceProfileId, { ...stored, profile });
    return profile;
  }

  /**
   * Withdraw consent, including mid-call.
   *
   * The profile is revoked immediately and the caller is told to invalidate
   * queued personal audio. Stored material is removed too: revocation that
   * leaves the recording behind is not revocation.
   */
  async revoke(voiceProfileId: string): Promise<VoiceRevocationOutcome | null> {
    const stored = this.profiles.get(voiceProfileId);
    if (!stored) return null;
    const timestamp = this.now();
    const profile = revokeVoiceProfile(stored.profile, timestamp);

    if (stored.profile.voiceAssetRef) {
      await this.storage.deleteVoiceAsset(stored.profile.voiceAssetRef).catch(() => false);
    }
    if (stored.enrollmentRecordingRef) {
      await this.storage.deleteEnrollmentRecording(stored.enrollmentRecordingRef).catch(() => false);
    }

    this.profiles.set(voiceProfileId, { profile, enrollmentRecordingRef: null });
    return { profile, invalidateQueuedPersonalAudio: true, nextSynthesisVoice: 'standard' };
  }

  /** Delete everything and report what was actually removed. */
  async delete(voiceProfileId: string): Promise<VoiceProfileDeletionEvidence> {
    const stored = this.profiles.get(voiceProfileId);
    const completedAt = this.now();
    if (!stored) {
      return {
        voiceProfileId,
        recordRemoved: false,
        voiceAssetRemoved: 'none-held',
        enrollmentRecordingRemoved: 'none-held',
        completedAt,
        cleanupRetryRequired: false,
      };
    }

    const voiceAssetRemoved = await this.removeArtefact(() =>
      stored.profile.voiceAssetRef
        ? this.storage.deleteVoiceAsset(stored.profile.voiceAssetRef)
        : Promise.resolve(null),
    );
    const enrollmentRecordingRemoved = await this.removeArtefact(() =>
      stored.enrollmentRecordingRef
        ? this.storage.deleteEnrollmentRecording(stored.enrollmentRecordingRef)
        : Promise.resolve(null),
    );

    // The profile goes either way: a participant who asked to be deleted is
    // deleted, and must behave exactly as if they never enrolled.
    this.profiles.delete(voiceProfileId);

    const cleanupRetryRequired =
      voiceAssetRemoved === 'failed' || enrollmentRecordingRemoved === 'failed';
    if (cleanupRetryRequired) {
      this.pending.set(voiceProfileId, {
        voiceProfileId,
        voiceAssetRef: voiceAssetRemoved === 'failed' ? stored.profile.voiceAssetRef : null,
        enrollmentRecordingRef:
          enrollmentRecordingRemoved === 'failed' ? stored.enrollmentRecordingRef : null,
        firstFailedAt: completedAt,
      });
    }

    return {
      voiceProfileId,
      recordRemoved: true,
      voiceAssetRemoved,
      enrollmentRecordingRemoved,
      completedAt,
      cleanupRetryRequired,
    };
  }

  /** Deletions that left something behind. Empty is the healthy state. */
  pendingCleanups(): PendingVoiceCleanup[] {
    return [...this.pending.values()];
  }

  /**
   * Re-attempt a partly failed deletion.
   *
   * Only what actually survived is retried, and the cleanup record is dropped
   * only once nothing is left — so a retry that fails again stays retryable
   * rather than silently becoming an orphan on the second attempt.
   */
  async retryCleanup(voiceProfileId: string): Promise<VoiceProfileDeletionEvidence | null> {
    const outstanding = this.pending.get(voiceProfileId);
    if (!outstanding) return null;
    const completedAt = this.now();

    const voiceAssetRemoved = await this.removeArtefact(() =>
      outstanding.voiceAssetRef
        ? this.storage.deleteVoiceAsset(outstanding.voiceAssetRef)
        : Promise.resolve(null),
    );
    const enrollmentRecordingRemoved = await this.removeArtefact(() =>
      outstanding.enrollmentRecordingRef
        ? this.storage.deleteEnrollmentRecording(outstanding.enrollmentRecordingRef)
        : Promise.resolve(null),
    );

    const cleanupRetryRequired =
      voiceAssetRemoved === 'failed' || enrollmentRecordingRemoved === 'failed';
    if (cleanupRetryRequired) {
      this.pending.set(voiceProfileId, {
        ...outstanding,
        voiceAssetRef: voiceAssetRemoved === 'failed' ? outstanding.voiceAssetRef : null,
        enrollmentRecordingRef:
          enrollmentRecordingRemoved === 'failed' ? outstanding.enrollmentRecordingRef : null,
      });
    } else {
      this.pending.delete(voiceProfileId);
    }

    return {
      voiceProfileId,
      recordRemoved: true,
      voiceAssetRemoved,
      enrollmentRecordingRemoved,
      completedAt,
      cleanupRetryRequired,
    };
  }

  /** `null` from the thunk means nothing was held; a throw means it survived. */
  private async removeArtefact(
    remove: () => Promise<boolean | null>,
  ): Promise<'removed' | 'none-held' | 'failed'> {
    try {
      const result = await remove();
      if (result === null) return 'none-held';
      return result ? 'removed' : 'none-held';
    } catch {
      return 'failed';
    }
  }
}
