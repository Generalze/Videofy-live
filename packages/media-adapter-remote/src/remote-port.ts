/** @author masterzee001 */
/**
 * `MediaAdapterPort` over the wire.
 *
 * The point of the seam existing at all: `SipCall` speaks the same interface it
 * always did, and never learns that the port became remote. It already treats
 * every seam call as bounded, fallible and counted — a remote port that rejects,
 * times out or refuses is a case it handles, because a hanging callback and a
 * slow network are the same event to it.
 *
 * ROUTE SCOPE. `routeRef` is remote composition and security; it has no place in
 * the semantic seam, which faces the engine. So the facade is BOUND to a route
 * at construction, and a process serving several numbers holds several
 * lightweight facades over one shared connection:
 *
 *     SIP signalling picks the route
 *            ↓
 *     that route's RemoteMediaAdapterPort
 *            ↓
 *     SipCall sees an ordinary MediaAdapterPort
 *            ↓
 *     the facade supplies routeRef itself
 *
 * `SipCall` never learns a route exists, for the same reason it never learns a
 * language exists.
 */
import type {
  AdapterAudioFrame,
  AdapterSessionRef,
  MediaAdapterPort,
  MediaAdapterSession,
} from '@videofy-live/media-adapter-port';
import type { AdapterConnection } from './connection.js';
import type { ControlPlaneClient } from './control-client.js';

export class RemoteMediaAdapterError extends Error {
  constructor(
    readonly outcome: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteMediaAdapterError';
  }
}

interface SessionState {
  readonly capability: string;
  /** Announced participants. A stream may only open for one of these. */
  readonly participants: Set<string>;
  closed: boolean;
}

export interface RemoteMediaAdapterPortDeps {
  readonly routeRef: string;
  readonly connection: AdapterConnection;
  readonly control: ControlPlaneClient;
}

export class RemoteMediaAdapterPort implements MediaAdapterPort {
  private readonly sessions = new Map<string, SessionState>();

  private constructor(private readonly deps: RemoteMediaAdapterPortDeps) {}

  /** The only constructor. A port without a route cannot originate anything. */
  static forRoute(deps: RemoteMediaAdapterPortDeps): RemoteMediaAdapterPort {
    return new RemoteMediaAdapterPort(deps);
  }

  async openSession(input: {
    sessionRef: AdapterSessionRef;
    platformSessionRef: string;
  }): Promise<MediaAdapterSession> {
    const existing = this.sessions.get(input.sessionRef);
    if (existing !== undefined && !existing.closed) {
      // Locally idempotent as well as on the wire. A retry that never reached
      // the network should not reach it now.
      return { sessionRef: input.sessionRef };
    }

    const response = await this.deps.control.createSession({
      adapterSessionRef: input.sessionRef,
      routeRef: this.deps.routeRef,
      // Deterministic, so a lost response cannot produce a second session. SIP
      // retransmits, and P6.8 has several pins that exist only because of it.
      idempotencyKey: `${this.deps.routeRef}:${input.sessionRef}`,
      platformSessionRef: input.platformSessionRef,
    });

    this.sessions.set(input.sessionRef, {
      capability: response.sessionCapability,
      participants: new Set(),
      closed: false,
    });
    return { sessionRef: input.sessionRef };
  }

  async participantJoined(
    sessionRef: AdapterSessionRef,
    participantId: string,
    displayName: string,
  ): Promise<void> {
    const session = this.requireSession(sessionRef);
    await this.deps.control.announceParticipant({
      adapterSessionRef: sessionRef,
      sessionCapability: session.capability,
      participantId,
      displayName,
    });
    // Only AFTER the control plane agrees. A stream may not open for a
    // participant the platform has not been told about, and two paths capable
    // of creating participant state is one too many.
    session.participants.add(participantId);
    await this.deps.connection.openStream({
      adapterSessionRef: sessionRef,
      participantId,
      capability: session.capability,
    });
  }

  async pushAudio(sessionRef: AdapterSessionRef, frame: AdapterAudioFrame): Promise<void> {
    const session = this.sessions.get(sessionRef);
    if (session === undefined || session.closed) {
      // Never silently successful. A caller told its audio is on the way when
      // it is not will keep sending, and nothing will ever say otherwise.
      throw new RemoteMediaAdapterError(
        'rejected-stale',
        'Session is closed or was never opened on this route.',
      );
    }
    if (!session.participants.has(frame.participantId)) {
      throw new RemoteMediaAdapterError(
        'rejected-participant',
        'Participant has not been announced on this session.',
      );
    }
    const accepted = this.deps.connection.offerAudio(
      sessionRef,
      frame.participantId,
      frame.samples,
      frame.platformTimestampMs,
    );
    if (!accepted) {
      throw new RemoteMediaAdapterError(
        'dropped-backpressure',
        'The outbound channel refused the frame.',
      );
    }
  }

  async participantLeft(sessionRef: AdapterSessionRef, participantId: string): Promise<void> {
    const session = this.sessions.get(sessionRef);
    if (session === undefined) return;
    // Transport first: stop offering frames for a participant we are about to
    // withdraw, so nothing races the withdrawal.
    this.deps.connection.closeStream(sessionRef, participantId, 'participant left');
    session.participants.delete(participantId);
    if (session.closed) return;
    await this.deps.control.withdrawParticipant({
      adapterSessionRef: sessionRef,
      sessionCapability: session.capability,
      participantId,
    });
  }

  async closeSession(sessionRef: AdapterSessionRef, reason: string): Promise<void> {
    const session = this.sessions.get(sessionRef);
    if (session === undefined || session.closed) return;
    // Marked closed BEFORE any await, so a second close and a late pushAudio
    // both see a closed session rather than racing this one.
    session.closed = true;
    for (const participantId of session.participants) {
      this.deps.connection.closeStream(sessionRef, participantId, reason);
    }
    session.participants.clear();
    this.sessions.delete(sessionRef);
    await this.deps.control.closeSession({
      adapterSessionRef: sessionRef,
      sessionCapability: session.capability,
      reason,
    });
  }

  private requireSession(sessionRef: AdapterSessionRef): SessionState {
    const session = this.sessions.get(sessionRef);
    if (session === undefined || session.closed) {
      throw new RemoteMediaAdapterError(
        'rejected-session',
        'No open session for that reference on this route.',
      );
    }
    return session;
  }
}
