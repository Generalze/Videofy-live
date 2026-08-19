/** @author masterzee001 */
/**
 * One RTMS stream, from webhook to teardown.
 *
 * The state machine exists because Zoom's handshake has a cross-socket
 * dependency that is easy to get subtly wrong: the CLIENT_READY_ACK goes back
 * on the SIGNALING connection, and only after every intended MEDIA connection
 * has finished its own handshake. Acking early means Zoom believes we are
 * ready before we can receive; acking on the wrong socket means it never
 * arrives at all.
 *
 *   webhook meeting.rtms_started
 *        -> signaling socket, SIGNALING_HAND_SHAKE_REQ
 *        -> SIGNALING_HAND_SHAKE_RESP carries the media server urls
 *        -> media socket, DATA_HAND_SHAKE_REQ (audio, multi-stream)
 *        -> DATA_HAND_SHAKE_RESP
 *        -> CLIENT_READY_ACK  ON THE SIGNALING SOCKET
 *        -> EVENT_SUBSCRIPTION, then audio flows
 *
 * Keepalives run the other way round from most protocols: the SERVER sends
 * KEEP_ALIVE_REQ every 10s on BOTH sockets and we answer. So we keep no send
 * timer, only a responder and a watchdog — Zoom's own guidance is to
 * re-establish by resending the signaling handshake after 65s of silence.
 */
import {
  EVENT,
  MSG,
  STATUS,
  audioHandshakeRequest,
  clientReadyAck,
  eventSubscription,
  keepAliveResponse,
  parseInbound,
  signalingHandshakeRequest,
  audioParamsAsRequested,
  RtmsProtocolError,
  type HandshakeIdentity,
} from './protocol.js';
import { rtmsStreamSignature } from './credentials.js';
import { ZoomIdentityMap } from './identity.js';
import { measureGap, toAdapterFrame, frameDurationMs } from './audio.js';
import type { MediaAdapterPort } from './media-port.js';

/** Zoom's documented watchdog threshold before re-establishing. */
export const KEEPALIVE_SILENCE_LIMIT_MS = 65_000;

export type SessionPhase =
  | 'idle'
  | 'signaling-handshake'
  | 'media-handshake'
  | 'ready'
  | 'reconnecting'
  | 'closed';

/** The minimum a socket must do; real sockets and fakes both satisfy it. */
export interface SocketLike {
  send(payload: string): void;
  close(): void;
  onMessage(listener: (raw: string) => void): void;
  onClose(listener: () => void): void;
}

export interface ZoomSessionDeps {
  identity: HandshakeIdentity;
  clientSecret: string;
  /** Signaling URL from the webhook payload. */
  signalingUrl: string;
  port: MediaAdapterPort;
  connect(url: string): Promise<SocketLike>;
  now?(): number;
  mintParticipantId?(): string;
  log?(line: string, detail?: Record<string, unknown>): void;
}

export class ZoomRtmsSession {
  private readonly deps: ZoomSessionDeps;
  private readonly now: () => number;
  private readonly identityMap: ZoomIdentityMap;
  private readonly lastFrameBySpeaker = new Map<string, { platformTimestampMs: number; durationMs: number }>();

  private signaling: SocketLike | null = null;
  private media: SocketLike | null = null;
  /**
   * A deadline PER SOCKET. Zoom keepalives run independently on both legs, so
   * one shared timestamp lets a healthy signaling socket mask a media socket
   * that a NAT dropped half-open: the session sits at 'ready' with no audio
   * and nothing ever re-establishes it.
   */
  private signalingSeenAtMs = 0;
  private mediaSeenAtMs = 0;
  /** Guards the watchdog against re-entering its own in-flight reconnect. */
  private reestablishing = false;

  phase: SessionPhase = 'idle';
  /** Gaps observed per speaker; the engine's chunker needs these, not silence. */
  readonly gaps: Array<{ participantId: string; gapMs: number }> = [];

  constructor(deps: ZoomSessionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.identityMap = new ZoomIdentityMap(
      deps.mintParticipantId ? { mintId: deps.mintParticipantId } : {},
    );
  }

  /**
   * Read through a method, not the field: after `this.phase = 'x'` the
   * compiler narrows the property and would treat a post-await check for
   * 'closed' as dead code — but close() can and does run during that await.
   */
  private isClosed(): boolean {
    return this.phase === 'closed';
  }

  /**
   * Every phase move goes through here so that 'closed' is genuinely terminal.
   * Without it, work already in flight when close() lands — a dial resolving,
   * a handshake reply arriving — would quietly move the session back to a live
   * phase and resurrect a torn-down meeting.
   */
  private setPhase(next: SessionPhase): void {
    if (this.isClosed()) return;
    this.phase = next;
  }

  get sessionId(): string {
    return this.deps.identity.rtmsStreamId;
  }

  private signature(): string {
    return rtmsStreamSignature({
      clientId: this.deps.identity.clientId,
      clientSecret: this.deps.clientSecret,
      meetingUuid: this.deps.identity.meetingUuid,
      rtmsStreamId: this.deps.identity.rtmsStreamId,
    });
  }

  /** Open the signaling connection and begin the handshake. */
  async start(): Promise<void> {
    await this.deps.port.openSession({
      sessionId: this.sessionId,
      platformSessionRef: this.deps.identity.meetingUuid,
    });
    try {
      await this.openSignaling();
    } catch (error) {
      // A dial that never connected must not leave a half-open seam session
      // and a phase that reads as 'still handshaking' forever.
      this.absorb('signaling-connect', error);
      await this.close('signaling connection failed');
      throw error;
    }
  }

  private async openSignaling(): Promise<void> {
    if (this.isClosed()) return;
    this.setPhase('signaling-handshake');
    const socket = await this.deps.connect(this.deps.signalingUrl);
    if (this.isClosed()) {
      // leave/stop won the race with this dial. Adopting the socket now would
      // revive a torn-down session and leak a live connection.
      socket.close();
      return;
    }
    this.signaling = socket;
    this.signalingSeenAtMs = this.now();
    this.mediaSeenAtMs = this.now();
    socket.onMessage((raw) => {
      void this.handleSignaling(raw, socket).catch((error) => this.absorb('signaling', error));
    });
    socket.onClose(() => {
      if (this.phase === 'closed' || socket !== this.signaling) return;
      this.setPhase('reconnecting');
      void this.reestablish('signaling socket closed');
    });
    socket.send(JSON.stringify(signalingHandshakeRequest(this.deps.identity, this.signature())));
  }

  private async handleSignaling(raw: string, from: SocketLike): Promise<void> {
    const message = this.decode(raw);
    if (message === null) return;

    if (message.kind === 'keepalive-req') {
      // Answered on the socket that ASKED, not on whatever socket is current:
      // after a re-establish, a straggler from the old connection would
      // otherwise be replied to on the new one. A stale socket's keepalive
      // also must not refresh the watchdog for the live connection.
      from.send(JSON.stringify(keepAliveResponse(message.timestamp)));
      if (from === this.signaling) this.signalingSeenAtMs = this.now();
      return;
    }

    if (message.kind === 'signaling-handshake-resp') {
      if (from !== this.signaling) return; // superseded connection
      if (message.statusCode !== STATUS.OK) {
        this.fail(`signaling handshake refused (status ${message.statusCode})`);
        return;
      }
      // Prefer the audio-specific media server; 'all' is the documented
      // fallback when a per-type url is not offered.
      const mediaUrl = message.mediaServerUrls['audio'] ?? message.mediaServerUrls['all'];
      if (mediaUrl === undefined) {
        this.fail('signaling handshake carried no audio media server url');
        return;
      }
      await this.openMedia(mediaUrl);
      return;
    }

    if (message.kind === 'event-update') {
      await this.applyEvent(message.event);
    }
  }

  private async openMedia(url: string): Promise<void> {
    if (this.isClosed()) return;
    this.setPhase('media-handshake');
    let socket: SocketLike;
    try {
      socket = await this.deps.connect(url);
    } catch (error) {
      // Zoom holds the stream open for a further window after a media-leg
      // failure, so this is recoverable: the watchdog re-establishes.
      this.absorb('media-connect', error);
      this.setPhase('reconnecting');
      return;
    }
    if (this.isClosed()) {
      socket.close();
      return;
    }
    this.media = socket;
    this.mediaSeenAtMs = this.now();
    socket.onMessage((raw) => {
      void this.handleMedia(raw, socket).catch((error) => this.absorb('media', error));
    });
    socket.onClose(() => {
      // Only the media leg died — recoverable, but something must actually do
      // the recovering: a phase label alone leaves the session silent forever.
      if (this.phase === 'closed' || socket !== this.media) return;
      this.setPhase('reconnecting');
      void this.reestablish('media socket closed');
    });
    socket.send(JSON.stringify(audioHandshakeRequest(this.deps.identity, this.signature())));
  }

  private async handleMedia(raw: string, from: SocketLike): Promise<void> {
    const message = this.decode(raw);
    if (message === null) return;

    if (message.kind === 'keepalive-req') {
      from.send(JSON.stringify(keepAliveResponse(message.timestamp)));
      if (from === this.media) this.mediaSeenAtMs = this.now();
      return;
    }

    if (message.kind === 'data-handshake-resp') {
      if (from !== this.media) return; // a superseded connection speaks for nobody
      if (message.statusCode !== STATUS.OK) {
        this.fail(`audio handshake refused (status ${message.statusCode})`);
        return;
      }
      // Zoom echoes what it NEGOTIATED, which can differ from what we asked
      // for. A silent downgrade to the mixed default would read as a healthy
      // session that discards every packet — an hour of silence instead of a
      // refusal we can act on.
      const negotiated = audioParamsAsRequested(message.negotiatedMediaParams);
      if (!negotiated.ok) {
        this.fail(`audio handshake downgraded: ${negotiated.reason}`);
        return;
      }
      // THE ordering rule: ack on signaling, only now that media is up.
      this.signaling?.send(JSON.stringify(clientReadyAck(this.deps.identity.rtmsStreamId)));
      this.signaling?.send(
        JSON.stringify(
          eventSubscription([EVENT.PARTICIPANT_JOIN, EVENT.PARTICIPANT_LEAVE, EVENT.ACTIVE_SPEAKER_CHANGE]),
        ),
      );
      this.setPhase('ready');
      return;
    }

    if (message.kind === 'audio') {
      await this.deliverAudio(message.packet);
      return;
    }

    if (message.kind === 'event-update') {
      await this.applyEvent(message.event);
    }
  }

  private async deliverAudio(packet: { userId: number; userName: string; pcm: Buffer; timestamp: number }): Promise<void> {
    const firstSighting = this.identityMap.isNew(packet.userId);
    const participantId = this.identityMap.participantFor(packet.userId, packet.userName);

    let frame;
    try {
      frame = toAdapterFrame(packet, participantId);
    } catch (error) {
      // One bad packet must never end a live meeting.
      this.deps.log?.('zoom audio packet dropped', {
        reason: error instanceof RtmsProtocolError ? error.code : 'unknown',
      });
      return;
    }

    // Continuity is settled SYNCHRONOUSLY, before any await. Packets arrive
    // every 20 ms and the listener fires per message, so a suspended first
    // packet would otherwise be overtaken by its own successors: the port
    // would see them out of order and the gap baseline would run backwards.
    const previous = this.lastFrameBySpeaker.get(participantId) ?? null;
    const gap = measureGap(previous, frame);
    if (!gap.contiguous) this.gaps.push({ participantId, gapMs: gap.gapMs });
    this.lastFrameBySpeaker.set(participantId, {
      platformTimestampMs: frame.platformTimestampMs,
      durationMs: frameDurationMs(frame),
    });

    if (firstSighting) {
      // Zoom names the speaker on every audio packet, so a speaker can be
      // introduced by their own voice before any roster event arrives.
      await this.deps.port.participantJoined(this.sessionId, participantId, packet.userName);
    }
    await this.deps.port.pushAudio(this.sessionId, frame);
  }

  private async applyEvent(event: { kind: string; participants: Array<{ userId: number; userName?: string }> }): Promise<void> {
    for (const person of event.participants) {
      if (event.kind === 'join') {
        const isNew = this.identityMap.isNew(person.userId);
        const participantId = this.identityMap.participantFor(person.userId, person.userName);
        if (isNew) {
          await this.deps.port.participantJoined(this.sessionId, participantId, person.userName ?? '');
        }
      } else if (event.kind === 'leave') {
        // Leave events carry user_id only. The mapping is kept: Zoom reuses
        // the id if they come back, and they should return as themselves.
        const participantId = this.identityMap.participantFor(person.userId);
        this.lastFrameBySpeaker.delete(participantId);
        await this.deps.port.participantLeft(this.sessionId, participantId);
      }
    }
  }

  /**
   * Watchdog tick. Zoom's guidance: after 65 seconds without a keepalive,
   * re-establish by resending the signaling handshake. Call this from a timer
   * in production; tests drive it directly with an injected clock.
   */
  async checkKeepalive(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'idle') return;
    const at = this.now();
    // EITHER leg going quiet is a failure. Measuring them together would only
    // detect the case where both die at once, which is the rarest one.
    const signalingQuiet = at - this.signalingSeenAtMs >= KEEPALIVE_SILENCE_LIMIT_MS;
    const mediaQuiet = this.media !== null && at - this.mediaSeenAtMs >= KEEPALIVE_SILENCE_LIMIT_MS;
    if (!signalingQuiet && !mediaQuiet) return;
    await this.reestablish(signalingQuiet ? 'signaling keepalive silence' : 'media keepalive silence');
  }

  /**
   * Tear both legs down and start again from the signaling handshake, which is
   * Zoom's own guidance. Single-flight: the watchdog ticks every few seconds
   * and a dial takes longer than that, so without the guard each tick would
   * start another connection.
   */
  private async reestablish(reason: string): Promise<void> {
    if (this.reestablishing || this.phase === 'closed') return;
    this.reestablishing = true;
    this.deps.log?.('zoom rtms re-establishing', { reason });
    this.setPhase('reconnecting');
    try {
      this.media?.close();
      this.media = null;
      this.signaling?.close();
      this.signaling = null;
      // The new stream may restart its timestamp series; a baseline from the
      // old one would make the first frame look like a backward jump.
      this.lastFrameBySpeaker.clear();
      this.signalingSeenAtMs = this.now();
      this.mediaSeenAtMs = this.now();
      await this.openSignaling();
    } catch (error) {
      this.absorb('reestablish', error);
    } finally {
      this.reestablishing = false;
    }
  }

  /** The interruption webhook is a reason to act NOW, not in 65 seconds. */
  async handleInterruption(): Promise<void> {
    await this.reestablish('rtms interrupted');
  }

  private decode(raw: string): ReturnType<typeof parseInbound> | null {
    try {
      return parseInbound(JSON.parse(raw));
    } catch (error) {
      // Malformed input is refused, never fatal: an unparseable frame says
      // nothing about whether the next one is fine.
      this.deps.log?.('zoom rtms message refused', {
        reason: error instanceof RtmsProtocolError ? error.code : 'unparseable',
      });
      return null;
    }
  }

  /**
   * Swallow a handler failure into the log. These run from socket callbacks,
   * where an escaping rejection would be unhandled and could take the whole
   * process down — one bad frame must never end every meeting on this host.
   */
  private absorb(where: string, error: unknown): void {
    this.deps.log?.('zoom rtms handler error', {
      where,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  private fail(reason: string): void {
    this.deps.log?.('zoom rtms session failed', { reason });
    void this.close(reason);
  }

  async close(reason: string): Promise<void> {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.media?.close();
    this.signaling?.close();
    this.media = null;
    this.signaling = null;
    await this.deps.port.closeSession(this.sessionId, reason);
  }
}

export { MSG };
