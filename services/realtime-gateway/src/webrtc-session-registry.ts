import { randomUUID } from 'node:crypto';
import type {
  WebRtcIncomingSignallingEnvelope,
  WebRtcOutgoingSignallingEnvelope,
  WebRtcPeerState,
  WebRtcPeerSummary,
  WebRtcSessionCloseEnvelope,
  WebRtcSessionCreatedEnvelope,
  WebRtcSessionJoinedEnvelope,
  WebRtcSessionState,
  WebRtcSessionSummary,
  WebRtcSignallingErrorCode,
  WebRtcSignallingErrorEnvelope,
  WebRtcSignallingRole,
} from '@videofy-live/shared-types';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_LIMITS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
} from '@videofy-live/shared-types';

export class WebRtcSignallingError extends Error {
  constructor(
    readonly code: WebRtcSignallingErrorCode,
    message: string,
    readonly retryable = false,
    readonly currentState?: WebRtcSessionState | WebRtcPeerState,
  ) {
    super(message);
    this.name = 'WebRtcSignallingError';
  }
}

export interface WebRtcPeerRecord {
  peerId: string;
  role: WebRtcSignallingRole;
  socketId: string;
  state: WebRtcPeerState;
  revision: number;
  joinedAt: string;
  updatedAt: string;
}

interface CurrentOffer {
  revision: number;
  senderPeerId: string;
  targetPeerId: string;
  answered: boolean;
}

export interface WebRtcSessionRecord {
  sessionId: string;
  broadcastId: string;
  state: WebRtcSessionState;
  revision: number;
  broadcasterPeerId: string;
  peers: Map<string, WebRtcPeerRecord>;
  socketToPeerId: Map<string, string>;
  seenMessageIds: string[];
  currentOffer: CurrentOffer | null;
  currentOffers: CurrentOffer[];
  createdAt: string;
  updatedAt: string;
}

export interface WebRtcRouteResult {
  outgoing: WebRtcOutgoingSignallingEnvelope;
  targetSocketId?: string;
  broadcastSessionId?: string;
}

export class WebRtcSessionRegistry {
  private readonly sessions = new Map<string, WebRtcSessionRecord>();
  private readonly broadcastToSession = new Map<string, string>();
  private readonly socketToSessionIds = new Map<string, Set<string>>();

  createSession(
    socketId: string,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' }>,
  ): WebRtcRouteResult {
    assertRole(envelope.senderRole, 'broadcaster');
    if (this.sessions.size >= WEBRTC_SIGNALLING_LIMITS.maxActiveSessions) {
      throw new WebRtcSignallingError(
        'invalid-state-transition',
        'WebRTC signalling session capacity reached.',
        true,
      );
    }
    const existingSessionId = this.broadcastToSession.get(envelope.broadcastId);
    if (existingSessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing && !isTerminalSessionState(existing.state)) {
        throw new WebRtcSignallingError(
          'duplicate-broadcaster',
          'A broadcaster is already active for this broadcast.',
          false,
          existing.state,
        );
      }
    }

    const requestedSessionId = envelope.payload.requestedSessionId;
    const sessionId = requestedSessionId ?? `wrs_${randomUUID()}`;
    if (this.sessions.has(sessionId)) {
      throw new WebRtcSignallingError(
        'session-already-exists',
        'WebRTC signalling session already exists.',
        false,
      );
    }

    const now = new Date().toISOString();
    const broadcaster: WebRtcPeerRecord = {
      peerId: envelope.peerId,
      role: 'broadcaster',
      socketId,
      state: 'joined',
      revision: 0,
      joinedAt: now,
      updatedAt: now,
    };
    const session: WebRtcSessionRecord = {
      sessionId,
      broadcastId: envelope.broadcastId,
      state: 'waiting',
      revision: 0,
      broadcasterPeerId: envelope.peerId,
      peers: new Map([[envelope.peerId, broadcaster]]),
      socketToPeerId: new Map([[socketId, envelope.peerId]]),
      seenMessageIds: [envelope.messageId],
      currentOffer: null,
      currentOffers: [],
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(sessionId, session);
    this.broadcastToSession.set(envelope.broadcastId, sessionId);
    this.addSocketSession(socketId, sessionId);

    return {
      outgoing: {
        ...this.replyBase(envelope, 'session-created', session, envelope.peerId),
        payload: {
          sessionState: session.state,
          peerState: broadcaster.state,
        },
      } satisfies WebRtcSessionCreatedEnvelope,
    };
  }

  joinSession(
    socketId: string,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-join' }>,
  ): WebRtcRouteResult {
    const session = this.requireOpenSession(envelope.sessionId);
    this.assertMessageFresh(session, envelope);
    if (envelope.senderRole !== envelope.payload.requestedRole) {
      throw new WebRtcSignallingError(
        'forbidden-role',
        'Sender role does not match requested WebRTC role.',
        false,
        session.state,
      );
    }
    if (envelope.senderRole === 'broadcaster') {
      throw new WebRtcSignallingError(
        'duplicate-broadcaster',
        'A second broadcaster cannot join an active WebRTC signalling session.',
        false,
        session.state,
      );
    }
    if (session.peers.size >= WEBRTC_SIGNALLING_LIMITS.maxPeersPerSession) {
      throw new WebRtcSignallingError(
        'invalid-state-transition',
        'WebRTC signalling session peer capacity reached.',
        true,
        session.state,
      );
    }
    this.assertPeerAvailable(session, envelope.peerId, socketId);

    const now = new Date().toISOString();
    session.peers.set(envelope.peerId, {
      peerId: envelope.peerId,
      role: envelope.senderRole,
      socketId,
      state: 'joined',
      revision: session.revision,
      joinedAt: now,
      updatedAt: now,
    });
    session.socketToPeerId.set(socketId, envelope.peerId);
    this.addSocketSession(socketId, session.sessionId);
    this.rememberMessage(session, envelope.messageId);
    this.touch(session);

    return {
      outgoing: {
        ...this.replyBase(envelope, 'session-joined', session, envelope.peerId),
        payload: {
          sessionState: session.state,
          peerState: 'joined',
          peers: this.peerSummaries(session),
        },
      } satisfies WebRtcSessionJoinedEnvelope,
      broadcastSessionId: session.sessionId,
    };
  }

  signal(
    socketId: string,
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      | Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' }>
      | Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-join' }>
    >,
  ): WebRtcRouteResult {
    const session = this.requireOpenSession(envelope.sessionId);
    this.assertMessageFresh(session, envelope);
    const peer = this.requireOwnedPeer(session, envelope.peerId, socketId);
    this.rememberMessage(session, envelope.messageId);

    if (envelope.type === 'peer-disconnect') {
      return this.disconnectPeer(session, peer, envelope);
    }
    if (envelope.type === 'session-close') {
      return this.closeSession(session, peer, envelope);
    }
    if (envelope.type === 'heartbeat-ack') {
      return { outgoing: envelope };
    }

    if (peer.state !== 'joined' && peer.state !== 'negotiating' && peer.state !== 'ready') {
      throw new WebRtcSignallingError(
        'invalid-state-transition',
        'Peer is not joined to this WebRTC signalling session.',
        false,
        peer.state,
      );
    }

    switch (envelope.type) {
      case 'sdp-offer':
        return this.acceptOffer(session, peer, envelope);
      case 'sdp-answer':
        return this.acceptAnswer(session, peer, envelope);
      case 'ice-candidate':
      case 'ice-complete':
        return this.acceptIce(session, peer, envelope);
      case 'peer-ready': {
        const offer = this.findOfferForPeerSignal(
          session,
          peer.peerId,
          undefined,
          envelope.revision,
        );
        if (!offer || peer.peerId !== offer.targetPeerId) {
          throw new WebRtcSignallingError(
            'stale-negotiation',
            'Peer-ready event does not match the current negotiation.',
            false,
            session.state,
          );
        }
        const targetPeer = this.requireTargetPeer(session, offer.senderPeerId);
        peer.state = 'ready';
        peer.revision = envelope.revision;
        peer.updatedAt = new Date().toISOString();
        this.touch(session);
        return { outgoing: envelope, targetSocketId: targetPeer.socketId };
      }
      default:
        throw new WebRtcSignallingError(
          'invalid-payload',
          'Unsupported WebRTC signalling message.',
          false,
          session.state,
        );
    }
  }

  cleanupSocket(socketId: string): WebRtcRouteResult[] {
    const sessionIds = this.socketToSessionIds.get(socketId);
    if (!sessionIds) return [];
    const results: WebRtcRouteResult[] = [];
    for (const sessionId of [...sessionIds]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const peerId = session.socketToPeerId.get(socketId);
      if (!peerId) continue;
      const peer = session.peers.get(peerId);
      if (!peer) continue;
      if (peer.role === 'broadcaster') {
        const envelope = this.lifecycleEnvelope(
          session,
          peer,
          'session-close',
          'socket disconnected',
        );
        results.push(this.closeSession(session, peer, envelope));
      } else {
        const envelope = this.lifecycleEnvelope(
          session,
          peer,
          'peer-disconnect',
          'socket disconnected',
        );
        results.push(this.disconnectPeer(session, peer, envelope));
      }
    }
    this.socketToSessionIds.delete(socketId);
    return results;
  }

  getSessionSummary(sessionId: string): WebRtcSessionSummary | null {
    const session = this.sessions.get(sessionId);
    return session ? this.summary(session) : null;
  }

  getDiagnostics(): {
    activeSessionCount: number;
    totalSessionCount: number;
    peerCount: number;
    listenerPeerCount: number;
    broadcasterPeerCount: number;
    serverPeerCount: number;
    negotiatingSessionCount: number;
    readySessionCount: number;
    closedSessionCount: number;
  } {
    const sessions = [...this.sessions.values()];
    const peers = sessions.flatMap((session) => [...session.peers.values()]);
    return {
      activeSessionCount: sessions.filter((session) => !isTerminalSessionState(session.state)).length,
      totalSessionCount: sessions.length,
      peerCount: peers.length,
      listenerPeerCount: peers.filter((peer) => peer.role === 'listener' && peer.state !== 'closed').length,
      broadcasterPeerCount: peers.filter((peer) => peer.role === 'broadcaster' && peer.state !== 'closed').length,
      serverPeerCount: peers.filter((peer) => peer.role === 'server' && peer.state !== 'closed').length,
      negotiatingSessionCount: sessions.filter((session) => session.state === 'negotiating').length,
      readySessionCount: sessions.filter((session) => session.state === 'ready').length,
      closedSessionCount: sessions.filter((session) => session.state === 'closed').length,
    };
  }

  cleanupClosedSessions(): number {
    let cleaned = 0;
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.state !== 'closed') continue;
      this.sessions.delete(sessionId);
      this.broadcastToSession.delete(session.broadcastId);
      for (const peer of session.peers.values()) {
        this.removeSocketSession(peer.socketId, sessionId);
      }
      cleaned++;
    }
    return cleaned;
  }

  getListenerPeers(sessionId: string): WebRtcPeerRecord[] {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return [];
    return [...session.peers.values()]
      .filter((peer) => peer.role === 'listener' && peer.state !== 'closed' && peer.state !== 'disconnected')
      .map((peer) => ({ ...peer }));
  }

  getSessionIdForBroadcast(broadcastId: string): string | null {
    return this.broadcastToSession.get(broadcastId) ?? null;
  }

  ensureBackendMediaPeer(
    sessionId: string | undefined,
    socketId: string,
    peerId = WEBRTC_BACKEND_MEDIA_PEER_ID,
  ): WebRtcPeerRecord {
    const session = this.requireOpenSession(sessionId);
    const existing = session.peers.get(peerId);
    if (existing) {
      if (existing.state === 'disconnected' || existing.state === 'closed') {
        existing.state = 'joined';
        existing.socketId = socketId;
        existing.revision = session.revision;
        existing.updatedAt = new Date().toISOString();
        session.socketToPeerId.set(socketId, peerId);
        this.addSocketSession(socketId, session.sessionId);
        this.touch(session);
      }
      return existing;
    }
    if (session.peers.size >= WEBRTC_SIGNALLING_LIMITS.maxPeersPerSession) {
      throw new WebRtcSignallingError(
        'invalid-state-transition',
        'WebRTC signalling session peer capacity reached.',
        true,
        session.state,
      );
    }
    const now = new Date().toISOString();
    const peer: WebRtcPeerRecord = {
      peerId,
      role: 'server',
      socketId,
      state: 'joined',
      revision: session.revision,
      joinedAt: now,
      updatedAt: now,
    };
    session.peers.set(peerId, peer);
    session.socketToPeerId.set(socketId, peerId);
    this.addSocketSession(socketId, session.sessionId);
    this.touch(session);
    return peer;
  }

  disconnectBackendMediaPeer(
    socketId: string,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'peer-disconnect' }>,
    peerId = WEBRTC_BACKEND_MEDIA_PEER_ID,
  ): void {
    const session = this.requireOpenSession(envelope.sessionId);
    this.assertMessageFresh(session, envelope);
    this.requireOwnedPeer(session, envelope.peerId, socketId);
    if (envelope.payload.targetPeerId !== peerId) {
      throw new WebRtcSignallingError(
        'peer-not-found',
        'Backend media peer disconnect target was not found.',
        false,
        session.state,
      );
    }
    const peer = this.requireTargetPeer(session, peerId);
    peer.state = 'disconnected';
    peer.updatedAt = new Date().toISOString();
    session.socketToPeerId.delete(peer.socketId);
    this.removeSocketSession(peer.socketId, session.sessionId);
    session.currentOffer = null;
    session.currentOffers = session.currentOffers.filter(
      (offer) => offer.senderPeerId !== peerId && offer.targetPeerId !== peerId,
    );
    this.rememberMessage(session, envelope.messageId);
    this.touch(session);
  }

  private acceptOffer(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-offer' }>,
  ): WebRtcRouteResult {
    const targetPeer = this.requireTargetPeer(session, envelope.payload.targetPeerId);
    const serverListenerOffer = peer.role === 'server' && targetPeer.role === 'listener';
    if (peer.role !== 'broadcaster' && !serverListenerOffer) {
      throw new WebRtcSignallingError(
        'forbidden-role',
        'Only the broadcaster or backend media peer can send an SDP offer.',
        false,
        peer.state,
      );
    }
    if (envelope.revision !== session.revision + 1) {
      throw new WebRtcSignallingError(
        'stale-negotiation',
        'SDP offer revision must be exactly one greater than the current revision.',
        false,
        peer.state,
      );
    }
    if (!serverListenerOffer) {
      session.revision = envelope.revision;
    }
    const offer: CurrentOffer = {
      revision: envelope.revision,
      senderPeerId: peer.peerId,
      targetPeerId: targetPeer.peerId,
      answered: false,
    };
    session.currentOffer = offer;
    this.rememberOffer(session, offer);
    session.state = 'negotiating';
    peer.state = 'negotiating';
    targetPeer.state = 'negotiating';
    peer.revision = envelope.revision;
    targetPeer.revision = envelope.revision;
    this.touch(session);
    return { outgoing: envelope, targetSocketId: targetPeer.socketId };
  }

  private acceptAnswer(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-answer' }>,
  ): WebRtcRouteResult {
    const offer = this.findOfferForAnswer(
      session,
      peer.peerId,
      envelope.payload.targetPeerId,
      envelope.revision,
    );
    if (!offer || offer.answered) {
      throw new WebRtcSignallingError(
        'offer-required',
        'An SDP answer requires a current unanswered offer.',
        false,
        session.state,
      );
    }
    if (peer.peerId !== offer.targetPeerId || envelope.payload.targetPeerId !== offer.senderPeerId) {
      throw new WebRtcSignallingError(
        'stale-negotiation',
        'SDP answer does not match the current offer revision or target.',
        false,
        session.state,
      );
    }
    const targetPeer = this.requireTargetPeer(session, envelope.payload.targetPeerId);
    offer.answered = true;
    session.currentOffer = offer;
    session.state = 'ready';
    peer.state = 'ready';
    targetPeer.state = 'ready';
    peer.revision = envelope.revision;
    targetPeer.revision = envelope.revision;
    this.touch(session);
    return { outgoing: envelope, targetSocketId: targetPeer.socketId };
  }

  private acceptIce(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    envelope: Extract<
      WebRtcIncomingSignallingEnvelope,
      { type: 'ice-candidate' | 'ice-complete' }
    >,
  ): WebRtcRouteResult {
    const offer = this.findOfferForPeerSignal(
      session,
      peer.peerId,
      envelope.payload.targetPeerId,
      envelope.revision,
    );
    const targetPeer = this.requireTargetPeer(session, envelope.payload.targetPeerId);
    if (!offer) {
      if (envelope.revision < session.revision) {
        throw new WebRtcSignallingError(
          'stale-negotiation',
          'ICE candidate revision is stale for this WebRTC session.',
          false,
          session.state,
        );
      }
      throw new WebRtcSignallingError(
        'offer-required',
        'ICE signalling requires an active negotiation offer.',
        false,
        session.state,
      );
    }
    if (targetPeer.peerId === peer.peerId) {
      throw new WebRtcSignallingError(
        'invalid-state-transition',
        'ICE candidate cannot target the sending peer.',
        false,
        peer.state,
      );
    }
    this.touch(session);
    return { outgoing: envelope, targetSocketId: targetPeer.socketId };
  }

  private disconnectPeer(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    envelope: Extract<WebRtcIncomingSignallingEnvelope, { type: 'peer-disconnect' }>,
  ): WebRtcRouteResult {
    this.rememberMessageIfNew(session, envelope.messageId);
    if (peer.state === 'disconnected' || peer.state === 'closed') {
      return { outgoing: envelope, broadcastSessionId: session.sessionId };
    }
    peer.state = 'disconnected';
    peer.updatedAt = new Date().toISOString();
    session.socketToPeerId.delete(peer.socketId);
    this.removeSocketSession(peer.socketId, session.sessionId);
    this.touch(session);
    return { outgoing: envelope, broadcastSessionId: session.sessionId };
  }

  private closeSession(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    envelope: WebRtcSessionCloseEnvelope,
  ): WebRtcRouteResult {
    this.rememberMessageIfNew(session, envelope.messageId);
    if (session.state === 'closed') {
      return { outgoing: envelope, broadcastSessionId: session.sessionId };
    }
    if (peer.role !== 'broadcaster' && peer.role !== 'server') {
      throw new WebRtcSignallingError(
        'forbidden-role',
        'Only the broadcaster or server can close a WebRTC signalling session.',
        false,
        peer.state,
      );
    }
    session.state = 'closed';
    session.currentOffer = null;
    session.currentOffers = [];
    for (const sessionPeer of session.peers.values()) {
      sessionPeer.state = 'closed';
      sessionPeer.updatedAt = new Date().toISOString();
      session.socketToPeerId.delete(sessionPeer.socketId);
      this.removeSocketSession(sessionPeer.socketId, session.sessionId);
    }
    this.broadcastToSession.delete(session.broadcastId);
    this.touch(session);
    return { outgoing: envelope, broadcastSessionId: session.sessionId };
  }

  private requireOpenSession(sessionId: string | undefined): WebRtcSessionRecord {
    if (!sessionId) {
      throw new WebRtcSignallingError('session-not-found', 'WebRTC session ID is required.', false);
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new WebRtcSignallingError('session-not-found', 'WebRTC session not found.', false);
    }
    if (session.state === 'closed' || session.state === 'closing') {
      throw new WebRtcSignallingError(
        'session-closed',
        'WebRTC signalling session is closed.',
        false,
        session.state,
      );
    }
    return session;
  }

  private rememberOffer(session: WebRtcSessionRecord, offer: CurrentOffer): void {
    session.currentOffers = session.currentOffers.filter(
      (current) =>
        !(
          current.revision === offer.revision &&
          current.senderPeerId === offer.senderPeerId &&
          current.targetPeerId === offer.targetPeerId
        ),
    );
    session.currentOffers.push(offer);
    if (session.currentOffers.length > WEBRTC_SIGNALLING_LIMITS.maxPeersPerSession) {
      session.currentOffers.splice(
        0,
        session.currentOffers.length - WEBRTC_SIGNALLING_LIMITS.maxPeersPerSession,
      );
    }
  }

  private findOfferForAnswer(
    session: WebRtcSessionRecord,
    answerPeerId: string,
    targetPeerId: string,
    revision: number,
  ): CurrentOffer | null {
    return (
      session.currentOffers.find(
        (offer) =>
          offer.revision === revision &&
          offer.targetPeerId === answerPeerId &&
          offer.senderPeerId === targetPeerId &&
          !offer.answered,
      ) ?? null
    );
  }

  private findOfferForPeerSignal(
    session: WebRtcSessionRecord,
    peerId: string,
    targetPeerId: string | undefined,
    revision: number,
  ): CurrentOffer | null {
    return (
      session.currentOffers.find(
        (offer) =>
          offer.revision === revision &&
          (targetPeerId
            ? (offer.senderPeerId === peerId && offer.targetPeerId === targetPeerId) ||
              (offer.targetPeerId === peerId && offer.senderPeerId === targetPeerId)
            : offer.senderPeerId === peerId || offer.targetPeerId === peerId),
      ) ?? null
    );
  }

  private requireOwnedPeer(
    session: WebRtcSessionRecord,
    peerId: string,
    socketId: string,
  ): WebRtcPeerRecord {
    const peer = session.peers.get(peerId);
    if (!peer) {
      throw new WebRtcSignallingError('peer-not-found', 'WebRTC peer not found.', false);
    }
    if (peer.socketId !== socketId) {
      throw new WebRtcSignallingError(
        'unauthorized',
        'Socket cannot signal on behalf of another WebRTC peer.',
        false,
        peer.state,
      );
    }
    return peer;
  }

  private requireTargetPeer(session: WebRtcSessionRecord, peerId: string): WebRtcPeerRecord {
    const peer = session.peers.get(peerId);
    if (!peer || peer.state === 'closed' || peer.state === 'disconnected') {
      throw new WebRtcSignallingError('peer-not-found', 'Target WebRTC peer not found.', true);
    }
    return peer;
  }

  private assertPeerAvailable(
    session: WebRtcSessionRecord,
    peerId: string,
    socketId: string,
  ): void {
    const existingPeer = session.peers.get(peerId);
    if (existingPeer && existingPeer.socketId === socketId) {
      throw new WebRtcSignallingError(
        'duplicate-peer',
        'WebRTC peer is already joined on this socket.',
        false,
        existingPeer.state,
      );
    }
    if (existingPeer && existingPeer.socketId !== socketId) {
      throw new WebRtcSignallingError(
        'duplicate-peer',
        'Another socket already owns this WebRTC peer.',
        false,
        existingPeer.state,
      );
    }
    if (session.socketToPeerId.has(socketId)) {
      throw new WebRtcSignallingError(
        'duplicate-peer',
        'Socket is already joined to this WebRTC signalling session.',
        false,
        session.state,
      );
    }
  }

  private assertMessageFresh(
    session: WebRtcSessionRecord,
    envelope: WebRtcIncomingSignallingEnvelope,
  ): void {
    if (session.seenMessageIds.includes(envelope.messageId)) {
      throw new WebRtcSignallingError(
        'duplicate-message',
        'Duplicate WebRTC signalling message rejected.',
        false,
        session.state,
      );
    }
    if (envelope.broadcastId !== session.broadcastId) {
      throw new WebRtcSignallingError(
        'stale-session',
        'WebRTC signalling message broadcast ID does not match the session.',
        false,
        session.state,
      );
    }
  }

  private rememberMessage(session: WebRtcSessionRecord, messageId: string): void {
    if (session.seenMessageIds.includes(messageId)) {
      throw new WebRtcSignallingError(
        'duplicate-message',
        'Duplicate WebRTC signalling message rejected.',
        false,
        session.state,
      );
    }
    this.rememberMessageIfNew(session, messageId);
  }

  private rememberMessageIfNew(session: WebRtcSessionRecord, messageId: string): void {
    if (session.seenMessageIds.includes(messageId)) return;
    session.seenMessageIds.push(messageId);
    if (session.seenMessageIds.length > WEBRTC_SIGNALLING_LIMITS.messageCacheSize) {
      session.seenMessageIds.splice(
        0,
        session.seenMessageIds.length - WEBRTC_SIGNALLING_LIMITS.messageCacheSize,
      );
    }
  }

  private replyBase<TType extends WebRtcOutgoingSignallingEnvelope['type']>(
    envelope: WebRtcIncomingSignallingEnvelope,
    type: TType,
    session: WebRtcSessionRecord,
    peerId: string,
  ): Omit<Extract<WebRtcOutgoingSignallingEnvelope, { type: TType }>, 'payload'> {
    return {
      type,
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      correlationId: envelope.correlationId ?? envelope.messageId,
      broadcastId: session.broadcastId,
      sessionId: session.sessionId,
      peerId,
      senderRole: 'server',
      revision: session.revision,
      createdAt: new Date().toISOString(),
    } as Omit<Extract<WebRtcOutgoingSignallingEnvelope, { type: TType }>, 'payload'>;
  }

  private lifecycleEnvelope<TType extends 'peer-disconnect' | 'session-close'>(
    session: WebRtcSessionRecord,
    peer: WebRtcPeerRecord,
    type: TType,
    reason: string,
  ): Extract<WebRtcIncomingSignallingEnvelope, { type: TType }> {
    return {
      type,
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      broadcastId: session.broadcastId,
      sessionId: session.sessionId,
      peerId: peer.peerId,
      senderRole: peer.role,
      revision: session.revision,
      createdAt: new Date().toISOString(),
      payload: { reason },
    } as Extract<WebRtcIncomingSignallingEnvelope, { type: TType }>;
  }

  private addSocketSession(socketId: string, sessionId: string): void {
    const sessions = this.socketToSessionIds.get(socketId) ?? new Set<string>();
    sessions.add(sessionId);
    this.socketToSessionIds.set(socketId, sessions);
  }

  private removeSocketSession(socketId: string, sessionId: string): void {
    const sessions = this.socketToSessionIds.get(socketId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.socketToSessionIds.delete(socketId);
    }
  }

  private peerSummaries(session: WebRtcSessionRecord): WebRtcPeerSummary[] {
    return [...session.peers.values()].map((peer) => ({
      peerId: peer.peerId,
      role: peer.role,
      state: peer.state,
      revision: peer.revision,
    }));
  }

  private summary(session: WebRtcSessionRecord): WebRtcSessionSummary {
    return {
      sessionId: session.sessionId,
      broadcastId: session.broadcastId,
      state: session.state,
      revision: session.revision,
      broadcasterPeerId: session.broadcasterPeerId,
      peerCount: session.peers.size,
      peers: this.peerSummaries(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private touch(session: WebRtcSessionRecord): void {
    session.updatedAt = new Date().toISOString();
  }
}

export function signallingErrorEnvelope(
  raw: Partial<WebRtcIncomingSignallingEnvelope>,
  error: unknown,
): WebRtcSignallingErrorEnvelope {
  const typed =
    error instanceof WebRtcSignallingError
      ? error
      : new WebRtcSignallingError(
          'internal-signalling-error',
          'Internal WebRTC signalling error.',
          true,
        );
  const correlationId = raw.correlationId ?? raw.messageId;
  return {
    type: 'signalling-error',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: `msg_${randomUUID()}`,
    ...(correlationId ? { correlationId } : {}),
    broadcastId: raw.broadcastId ?? 'broadcast_unknown',
    ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
    peerId: raw.peerId ?? 'peer_unknown',
    senderRole: 'server',
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    createdAt: new Date().toISOString(),
    payload: {
      code: typed.code,
      message: typed.message,
      retryable: typed.retryable,
      ...(typed.currentState ? { currentState: typed.currentState } : {}),
    },
  };
}

function assertRole(actual: WebRtcSignallingRole, expected: WebRtcSignallingRole): void {
  if (actual !== expected) {
    throw new WebRtcSignallingError(
      'forbidden-role',
      `WebRTC signalling role ${actual} cannot perform this action.`,
      false,
    );
  }
}

function isTerminalSessionState(state: WebRtcSessionState): boolean {
  return state === 'closed' || state === 'failed';
}
