/** @author masterzee001 */
/**
 * Getting translated speech to the adapter that can play it.
 *
 * A gateway serves several kinds of listener at once, and they need the same
 * audio delivered in completely different ways:
 *
 *   a browser   gets `TRANSLATED_AUDIO_FRAME` over socket.io and plays PCM16
 *               through Web Audio
 *   a SIP call  gets `TRANSLATED_MEDIA` over the adapter wire, and the adapter
 *               converts to the negotiated G.711 at its own boundary
 *
 * Both are fed from the SAME platform frames. This router is the fan-out point,
 * and it exists so neither delivery mechanism has to know the other exists.
 *
 * WHY A REGISTRY RATHER THAN A LOOKUP. The mapping from a platform session to
 * an adapter connection is established when a stream OPENS and is only true
 * while that connection lives. Deriving it later -- from a session id shape, a
 * route reference, a naming convention -- is precisely the inference this
 * codebase has removed everywhere else. It is recorded when it becomes true and
 * forgotten when it stops being.
 */
import type { TranslatedMediaPayload } from '@videofy-live/adapter-wire';

/** What the router needs from an adapter connection. Narrow on purpose. */
export interface TranslatedEgressTarget {
  sendTranslatedMedia(
    streamId: number,
    payload: TranslatedMediaPayload,
    platformTimestampMs: number,
  ): boolean;
}

interface Registration {
  readonly target: TranslatedEgressTarget;
  readonly streamId: number;
}

export interface TranslatedEgressRouterDeps {
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export type TranslatedEgressOutcome =
  | 'sent'
  | 'no-adapter-listener'
  | 'send-failed';

export class TranslatedEgressRouter {
  /** Keyed by platform session AND participant: one call leg per entry. */
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly deps: TranslatedEgressRouterDeps = {}) {}

  /**
   * A NUL separator, written as an ESCAPE and meant literally.
   *
   * A space or a colon would be ambiguous: a session id containing one would
   * collide with a different session/participant pair. NUL cannot appear in
   * either identifier, so the split is unambiguous by construction.
   *
   * Written as a unicode ESCAPE rather than as a literal byte. A literal NUL
   * in a source file
   * file makes git treat it as binary, breaks every diff and grep over it, and
   * slipped past the hygiene guard once because that guard only looked at
   * files git already tracked.
   */
  private static key(sessionId: string, participantId: string): string {
    return `${sessionId}\u0000${participantId}`;
  }

  get size(): number {
    return this.registrations.size;
  }

  /** A stream opened. Recorded because it is true now, not derived later. */
  register(
    sessionId: string,
    participantId: string,
    target: TranslatedEgressTarget,
    streamId: number,
  ): void {
    this.registrations.set(TranslatedEgressRouter.key(sessionId, participantId), {
      target,
      streamId,
    });
  }

  /**
   * The stream closed, the participant left, or the connection dropped.
   *
   * Forgetting is as important as recording: a stale entry would send a later
   * call's translated audio down a socket belonging to a call that ended, and
   * `streamId`s are reassigned after a reconnect.
   */
  forget(sessionId: string, participantId: string): void {
    this.registrations.delete(TranslatedEgressRouter.key(sessionId, participantId));
  }

  /** Everything on one connection is gone at once. */
  forgetTarget(target: TranslatedEgressTarget): void {
    for (const [key, registration] of this.registrations) {
      if (registration.target === target) this.registrations.delete(key);
    }
  }

  /**
   * Send one frame to the adapter serving this call leg.
   *
   * `no-adapter-listener` is an ORDINARY answer, not a failure: most sessions
   * have no SIP leg at all, and treating a browser-only call as an error would
   * fill the log with the normal case.
   */
  send(
    sessionId: string,
    participantId: string,
    payload: TranslatedMediaPayload,
    platformTimestampMs: number,
  ): TranslatedEgressOutcome {
    const registration = this.registrations.get(
      TranslatedEgressRouter.key(sessionId, participantId),
    );
    if (registration === undefined) return 'no-adapter-listener';
    const sent = registration.target.sendTranslatedMedia(
      registration.streamId,
      payload,
      platformTimestampMs,
    );
    if (!sent) {
      this.deps.log?.('translated media could not be sent to its adapter', {
        sessionId,
        participantId,
        segmentId: payload.segmentId,
      });
      return 'send-failed';
    }
    return 'sent';
  }

  /**
   * Every adapter leg of one session.
   *
   * A conference can have several SIP participants, and translated audio for a
   * session goes to all of them. Returning the participant ids rather than
   * sending internally keeps the decision about WHO should hear a given
   * translation where it belongs -- in the platform, not in this router.
   */
  participantsFor(sessionId: string): string[] {
    const prefix = `${sessionId}\u0000`;
    return [...this.registrations.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}
