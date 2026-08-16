/** @author masterzee001 */
/**
 * Personal voice enrollment (P6.3).
 *
 * A VoiceProfile is a speaker's own voice, reconstructed for translated
 * speech. That makes the enrollment recording biometric data about a specific
 * person, and this module exists to make the rules about it structural rather
 * than a matter of anyone remembering them.
 *
 * Three rules are load-bearing:
 *
 *   1. Consent to personal voice is SEPARATE from accepting terms of service.
 *      A product-wide "I agree" can never produce a usable voice profile, so
 *      there is no field here that a general acceptance could set.
 *
 *   2. Consent to USE a voice in calls is separate again from consent to TRAIN
 *      on it. Training defaults to withheld and must be granted on its own.
 *      This is the contract behind "enrollment audio does not become general
 *      training data automatically" (§21.9.2 rights gate).
 *
 *   3. Nothing here may ever prevent a call. Every resolution path ends in a
 *      voice the call can actually use, or in captions — never in an error a
 *      caller has to deal with mid-conversation.
 */
import { z } from 'zod';

/**
 * Where a profile is in its life.
 *
 * `revoked` is terminal and deliberately not re-enterable: a speaker who
 * changes their mind enrolls again and gets a new profile, rather than having
 * a previously revoked one quietly reactivated.
 */
export const VoiceProfileStateSchema = z.enum([
  /** Consent has not been given. No audio may be captured in this state. */
  'consent-pending',
  /** Consent given; enrollment audio not yet captured or still processing. */
  'enrolling',
  /** Enrollment captured but not accepted by the speaker, or quality-failed. */
  'review',
  /** Usable for translated speech. */
  'ready',
  /** Withdrawn by the speaker. Audio and derived data must be destroyed. */
  'revoked',
]);
export type VoiceProfileState = z.infer<typeof VoiceProfileStateSchema>;

/**
 * The two grants, kept apart on purpose.
 *
 * There is no single `consented` boolean anywhere in this shape. A boolean is
 * exactly what a terms-of-service checkbox would set, and it would make the
 * two decisions indistinguishable at the point they matter most.
 */
export const VoiceConsentSchema = z
  .object({
    /**
     * Use this voice to speak this person's translated words back to others.
     * This is what enrollment asks for.
     */
    callUseGrantedAt: z.string().datetime().nullable(),
    /**
     * Use the enrollment audio to train or improve Videofy models. Withheld
     * unless separately and explicitly granted; §21.9.2 forbids inferring it.
     */
    trainingUseGrantedAt: z.string().datetime().nullable(),
    /** Set when the speaker withdraws. Withdrawal covers both grants. */
    revokedAt: z.string().datetime().nullable(),
    /**
     * The exact wording the speaker agreed to, so a later dispute is settled
     * by evidence rather than by reconstructing what the screen used to say.
     */
    consentTextVersion: z.string().min(1),
  })
  .strict();
export type VoiceConsent = z.infer<typeof VoiceConsentSchema>;

export const VoiceProfileSchema = z
  .object({
    voiceProfileId: z.string().min(1),
    participantId: z.string().min(1),
    state: VoiceProfileStateSchema,
    consent: VoiceConsentSchema,
    /** Language the enrollment was spoken in; used to report cross-lingual use. */
    enrolledLanguage: z.string().min(1).nullable(),
    /** Provider-agnostic handle (ADR-007). Never a model or vendor name. */
    voiceAssetRef: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/** Whether a profile may be used to speak for this participant right now. */
export function isVoiceProfileUsable(profile: VoiceProfile): boolean {
  return (
    profile.state === 'ready' &&
    profile.consent.revokedAt === null &&
    profile.consent.callUseGrantedAt !== null &&
    profile.voiceAssetRef !== null
  );
}

/**
 * Whether enrollment audio may be used as training data.
 *
 * Separate from usability on purpose: the overwhelmingly common case is a
 * profile that is perfectly usable in calls and completely off-limits for
 * training.
 */
export function mayUseForTraining(profile: VoiceProfile): boolean {
  return profile.consent.revokedAt === null && profile.consent.trainingUseGrantedAt !== null;
}

/** Whether enrollment audio may be captured or retained at all. */
export function mayHoldEnrollmentAudio(profile: VoiceProfile): boolean {
  return profile.consent.revokedAt === null && profile.consent.callUseGrantedAt !== null;
}

export type VoiceResolution =
  | { readonly voice: 'personal'; readonly voiceProfileId: string; readonly synthetic: true }
  | { readonly voice: 'standard'; readonly standardVoiceId: string; readonly synthetic: true }
  | { readonly voice: 'none'; readonly reason: 'no-standard-voice' };

export interface VoiceResolutionInput {
  /** Absent when this speaker never enrolled — the ordinary case, not a fault. */
  readonly profile: VoiceProfile | null;
  readonly standardVoiceId: string | null;
  /**
   * Set when the voice provider has already failed for this profile in this
   * session. A profile that cannot be synthesised is not a profile that should
   * keep being retried mid-call.
   */
  readonly personalVoiceUnavailable?: boolean;
}

/**
 * Which voice speaks for this participant.
 *
 * Personal voice is PREFERRED whenever a usable profile exists — the owner's
 * decision, inverting ADR-006's original opt-in framing. It is not a mode
 * buried in settings that a speaker has to find.
 *
 * Every branch returns something the call can proceed with. `none` means only
 * that no voice can be synthesised, and the caller's contract is to fall back
 * to captions plus original audio — never to fail the call.
 */
export function resolveVoiceForParticipant(input: VoiceResolutionInput): VoiceResolution {
  const usable =
    input.profile !== null &&
    isVoiceProfileUsable(input.profile) &&
    input.personalVoiceUnavailable !== true;

  if (usable && input.profile !== null) {
    return { voice: 'personal', voiceProfileId: input.profile.voiceProfileId, synthetic: true };
  }
  if (input.standardVoiceId !== null) {
    return { voice: 'standard', standardVoiceId: input.standardVoiceId, synthetic: true };
  }
  return { voice: 'none', reason: 'no-standard-voice' };
}

/**
 * Withdraw consent.
 *
 * Returns the profile in its terminal state with both grants cleared and the
 * asset reference dropped. Callers are responsible for destroying the stored
 * audio; this makes the intent unambiguous in the record either way.
 */
export function revokeVoiceProfile(profile: VoiceProfile, revokedAt: string): VoiceProfile {
  return {
    ...profile,
    state: 'revoked',
    voiceAssetRef: null,
    consent: {
      ...profile.consent,
      callUseGrantedAt: null,
      trainingUseGrantedAt: null,
      revokedAt,
    },
    updatedAt: revokedAt,
  };
}
