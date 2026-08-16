/** @owner masterzee001 */
/**
 * Personal-voice providers behind the ADR-007 boundary (P6.3).
 *
 * The development profile currently has NO voice-cloning engine. Piper and MMS
 * are fixed-voice synthesisers: they render a chosen voice from a catalogue and
 * cannot reconstruct a speaker from a sample. The registry has carried a
 * `voice-clone` capability in its enum since before anything could satisfy it.
 *
 * So the development provider says so, out loud, on every call. It does not
 * pretend, and it does not quietly hand back the enrollment recording as though
 * it were a derived voice asset — which would produce a profile that looks
 * usable, sounds like a stranger, and is discovered by a person hearing
 * somebody else's voice speak their words.
 *
 * OpenVoice V2 (MIT) is the selected engine and drops in as a second
 * implementation of this interface. Nothing above this boundary changes when it
 * does: not the store, not the enrollment screen, not the call resolver.
 */
import type {
  VoiceProfileProvider,
  VoiceProfileResolution,
} from './voice-profile-provider.js';

/**
 * How far a provider has got through Videofy's own gates.
 *
 * MIT licensing gets an engine through the first door and no further. A model
 * is not production-approved because someone put a licence string in a
 * metadata field.
 */
export type PersonalVoiceProviderApproval =
  | 'unavailable'
  | 'development-unvalidated'
  | 'production-approved';

export interface PersonalVoiceProviderInfo {
  /** Stable identifier for diagnostics. Never rendered to a participant. */
  readonly providerId: string;
  readonly approval: PersonalVoiceProviderApproval;
  /** Why a human should not expect a personal voice yet, if they should not. */
  readonly note: string;
}

export interface DescribedVoiceProfileProvider extends VoiceProfileProvider {
  info(): PersonalVoiceProviderInfo;
}

/**
 * The provider used until a cloning engine is validated.
 *
 * Every call fails cleanly with `provider-unavailable`, which the resolver
 * already routes to the standard voice. The enrollment recording is still
 * captured and stored under consent, so a validated engine can derive assets
 * from existing enrollments without asking anyone to record again.
 */
export function createUnavailablePersonalVoiceProvider(): DescribedVoiceProfileProvider {
  return {
    info() {
      return {
        providerId: 'personal-voice-unavailable',
        approval: 'unavailable',
        note:
          'No voice-cloning engine is validated in this profile. Enrollments are stored under ' +
          'consent and translated speech uses the selected standard voice.',
      };
    },

    async resolve(): Promise<VoiceProfileResolution> {
      return { ok: false, reason: 'provider-unavailable' };
    },

    async createAsset() {
      // Deliberately NOT returning the enrollment reference as an asset. That
      // would mark the profile ready and put a standard voice — or worse,
      // someone else's — behind a "personal voice" label.
      return {
        ok: false as const,
        reason: 'no-cloning-engine-available',
      };
    },
  };
}
