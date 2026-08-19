/** @author masterzee001 */
/**
 * Zoom identity -> Videofy identity, kept strictly one-directional.
 *
 *   Zoom meeting_uuid   ->  Videofy session id
 *   Zoom user_id        ->  Videofy participantId
 *
 * The rule the master architecture already sets: "External identifiers remain
 * adapter metadata. A Zoom participant ID, SIP URI or KingsConference
 * participant identifier is mapped to a Videofy participantId and never
 * becomes the universal identity used by the language engine."
 *
 * So the Zoom numbers stay in this map and nowhere else. Two properties the
 * engine depends on:
 *
 *  - STABILITY. The same Zoom user_id always yields the same Videofy id for
 *    the life of the meeting, including across a media reconnect, or a
 *    speaker's transcript would split in two halfway through a sentence.
 *  - NO LEAKAGE. The minted id carries no Zoom number, so a leaked id tells
 *    an observer nothing about the meeting it came from.
 */
import { randomBytes } from 'node:crypto';

export interface IdentityMapOptions {
  /** Injectable so tests get deterministic ids. */
  mintId?: () => string;
}

function defaultMintId(): string {
  return `zp_${randomBytes(8).toString('hex')}`;
}

export class ZoomIdentityMap {
  private readonly byZoomUserId = new Map<number, string>();
  private readonly displayNames = new Map<string, string>();
  private readonly mintId: () => string;

  constructor(options: IdentityMapOptions = {}) {
    this.mintId = options.mintId ?? defaultMintId;
  }

  /**
   * The Videofy participant for a Zoom user, minting one on first sight.
   * Audio can legitimately arrive before the join event (Zoom names the
   * speaker on every audio packet), so this must work from either direction.
   */
  participantFor(zoomUserId: number, displayName?: string): string {
    let participantId = this.byZoomUserId.get(zoomUserId);
    if (participantId === undefined) {
      participantId = this.mintId();
      this.byZoomUserId.set(zoomUserId, participantId);
    }
    if (displayName !== undefined && displayName !== '') {
      this.displayNames.set(participantId, displayName);
    }
    return participantId;
  }

  /** True when this Zoom user has never been seen before this call. */
  isNew(zoomUserId: number): boolean {
    return !this.byZoomUserId.has(zoomUserId);
  }

  displayNameOf(participantId: string): string {
    return this.displayNames.get(participantId) ?? '';
  }

  /**
   * A leave does NOT forget the mapping. Zoom reuses a user_id when someone
   * rejoins the same meeting, and the engine should see the returning person
   * as themselves rather than as a stranger with the same name.
   */
  known(): Array<{ zoomUserId: number; participantId: string }> {
    return [...this.byZoomUserId.entries()].map(([zoomUserId, participantId]) => ({
      zoomUserId,
      participantId,
    }));
  }
}
