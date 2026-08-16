/** @owner masterzee001 */
/**
 * Which voice speaks for each participant in a live call (P6.3).
 *
 * This is the seam between a stored voice profile and the recipient output
 * policy. It exists as its own module because four properties have to be
 * provable rather than assumed:
 *
 *   1. Automatic pickup — an accepted profile is used without anybody choosing
 *      "personal voice" anywhere.
 *   2. Rejoin continuity — new socket, new participant id, same owner, same
 *      profile.
 *   3. Isolation — one owner can never resolve another's profile.
 *   4. Live propagation — re-record, revoke or delete changes future synthesis
 *      without restarting the call.
 *
 * The binding is keyed by participant (that is who speaks in a call) but
 * RESOLVED through the owner (that is who owns a voice). Collapsing the two is
 * the mistake this whole design exists to prevent.
 */
import {
  resolveVoiceForParticipant,
  type VoiceOwnerId,
  type VoiceProfile,
  type VoiceResolution,
} from '@videofy-live/participant-contracts';

/** How the gateway asks for a profile without owning the store. */
export interface VoiceProfileLookup {
  /** The usable profile for an owner, or null. Must never throw. */
  usableForOwner(ownerId: VoiceOwnerId): VoiceProfile | null;
}

interface Binding {
  readonly ownerId: VoiceOwnerId | null;
  readonly standardVoiceId: string | null;
  /** Set when synthesis already failed for this profile in this session. */
  personalVoiceUnavailable: boolean;
}

export class CallVoiceBindings {
  private readonly byParticipant = new Map<string, Binding>();

  constructor(private readonly lookup: VoiceProfileLookup) {}

  /**
   * Record who is speaking and on whose behalf.
   *
   * `ownerId` is null for anyone who never enrolled, which is the ordinary
   * case and not a fault. No profile lookup happens here: resolution is done
   * at synthesis time so a change made mid-call is picked up without rebinding.
   */
  bind(participantId: string, ownerId: VoiceOwnerId | null, standardVoiceId: string | null): void {
    this.byParticipant.set(participantId, {
      ownerId,
      standardVoiceId,
      personalVoiceUnavailable: false,
    });
  }

  release(participantId: string): void {
    this.byParticipant.delete(participantId);
  }

  /**
   * The voice to synthesise with, right now.
   *
   * Resolved fresh every time. That is what makes revoke, delete and re-record
   * take effect on the next utterance rather than at the next join: there is no
   * cached decision to go stale.
   */
  resolve(participantId: string): VoiceResolution {
    const binding = this.byParticipant.get(participantId);
    if (!binding) return { voice: 'none', reason: 'no-standard-voice' };

    const profile = binding.ownerId === null ? null : this.lookup.usableForOwner(binding.ownerId);
    return resolveVoiceForParticipant({
      profile,
      standardVoiceId: binding.standardVoiceId,
      personalVoiceUnavailable: binding.personalVoiceUnavailable,
    });
  }

  /**
   * Record that personal synthesis failed for this speaker.
   *
   * A profile that cannot be synthesised should not be retried on every
   * utterance for the rest of the call; the next resolve falls to the standard
   * voice. Cleared by `bind`, so a rejoin gives the personal voice a fresh
   * chance.
   */
  markPersonalVoiceUnavailable(participantId: string): void {
    const binding = this.byParticipant.get(participantId);
    if (binding) binding.personalVoiceUnavailable = true;
  }

  /** Participants currently speaking on behalf of this owner. */
  participantsForOwner(ownerId: VoiceOwnerId): string[] {
    return [...this.byParticipant.entries()]
      .filter(([, binding]) => binding.ownerId === ownerId)
      .map(([participantId]) => participantId);
  }
}
