/** @owner masterzee001 */
/**
 * The seam between a personal voice and everything that uses one (P6.3).
 *
 * ADR-007 says voice is provider-agnostic, and this file is where that is
 * actually enforced. A cloning engine may want reference audio, speaker
 * embeddings, conditioning vectors or a proprietary profile format. None of
 * that appears below, and none of it may travel further up: Call receives a
 * `voiceId` string and nothing else.
 *
 * The rule to apply when extending this file: if a field would only make sense
 * to one vendor, it belongs behind an implementation of this interface, not in
 * it.
 */

/** Why a personal voice could not be used this time. */
export type VoiceProfileUnavailableReason =
  | 'no-profile'
  | 'not-usable'
  | 'asset-missing'
  | 'unsupported-target-language'
  | 'provider-unavailable';

export type VoiceProfileResolution =
  | { readonly ok: true; readonly voiceId: string }
  | { readonly ok: false; readonly reason: VoiceProfileUnavailableReason };

export interface VoiceProfileProvider {
  /**
   * Resolve a stored profile into a voice identity the synthesis provider can
   * use for this target language.
   *
   * Returns a reason rather than throwing. Every listed reason lands on the
   * same policy — personal, then standard, then captions plus original audio —
   * so a failure here is a routing input, not an incident.
   */
  resolve(input: {
    readonly voiceProfileId: string;
    readonly voiceAssetRef: string;
    readonly targetLanguage: string;
  }): Promise<VoiceProfileResolution>;

  /**
   * Build a reusable voice asset from an enrollment recording.
   *
   * The returned reference is opaque. Whether it names a file, a row or a
   * remote resource is the implementation's business.
   */
  createAsset(input: {
    readonly voiceProfileId: string;
    readonly enrollmentRecordingRef: string;
    readonly enrolledLanguage: string;
  }): Promise<{ readonly ok: true; readonly voiceAssetRef: string } | { readonly ok: false; readonly reason: string }>;
}

/**
 * What a listener is told when synthesised speech is playing.
 *
 * Human wording only. A personal voice is still a machine speaking, so it is
 * always disclosed — and the disclosure never carries a model id, a provider
 * name or an asset reference onto the call stage.
 */
export function describeSyntheticVoice(input: {
  readonly voice: 'personal' | 'standard';
  readonly speakerDisplayName?: string | undefined;
}): string {
  if (input.voice === 'standard') return 'Translated voice';
  return input.speakerDisplayName
    ? `${input.speakerDisplayName}'s translated voice`
    : 'Personal translated voice';
}
