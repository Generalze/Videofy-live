import {
  SOCKET_EVENTS,
} from './socket-events.js';
import {
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIncomingSignallingEnvelope,
  type WebRtcOutgoingSignallingEnvelope,
  type WebRtcIceCandidateEnvelope,
  type WebRtcIceCompleteEnvelope,
  type WebRtcPeerSummary,
  type WebRtcPeerReadyEnvelope,
  type WebRtcPeerDisconnectEnvelope,
  type WebRtcSdpAnswerEnvelope,
  type WebRtcSdpOfferEnvelope,
  type WebRtcSignallingErrorCode,
  type WebRtcSignallingErrorEnvelope,
  type WebRtcSignallingRole,
} from './webrtc-signalling.js';

export type WebRtcClientLifecycleState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'creating-session'
  | 'joining-session'
  | 'joined'
  | 'ready'
  | 'reconnecting'
  | 'recovering-session'
  | 'leaving'
  | 'closing'
  | 'disconnected'
  | 'closed'
  | 'failed';

export type WebRtcClientErrorCode =
  | 'gateway-unavailable'
  | 'connection-timeout'
  | 'acknowledgement-timeout'
  | 'malformed-acknowledgement'
  | 'unsupported-protocol-version'
  | 'unauthorized'
  | 'forbidden-role'
  | 'session-not-found'
  | 'session-already-exists'
  | 'duplicate-broadcaster'
  | 'duplicate-peer'
  | 'stale-session'
  | 'stale-connection-generation'
  | 'invalid-transition'
  | 'session-closed'
  | 'payload-too-large'
  | 'reconnect-failed'
  | 'cleanup-failed'
  | 'internal-client-signalling-failure'
  | 'backend-webrtc-unavailable'
  | 'dependency-initialization-failure'
  | 'peer-already-exists'
  | 'peer-not-found'
  | 'missing-audio-track'
  | 'duplicate-audio-track'
  | 'missing-video-track'
  | 'duplicate-video-track'
  | 'unexpected-video-track'
  | 'invalid-offer'
  | 'answer-creation-failure'
  | 'invalid-answer'
  | 'remote-description-failure'
  | 'local-description-failure'
  | 'ice-candidate-failure'
  | 'ice-connection-failure'
  | 'negotiation-timeout'
  | 'connection-closed'
  | 'audio-track-ended'
  | 'video-track-ended'
  | 'ingest-bridge-failure'
  | 'unsupported-runtime';

export interface WebRtcClientErrorDetails {
  code: WebRtcClientErrorCode;
  message: string;
  retryable: boolean;
}

export class WebRtcClientSignallingError extends Error {
  constructor(
    readonly code: WebRtcClientErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WebRtcClientSignallingError';
  }
}

export interface WebRtcSignallingTransport {
  connected?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown): void;
}

export interface WebRtcSignallingClientSnapshot {
  state: WebRtcClientLifecycleState;
  role: WebRtcSignallingRole;
  broadcastId: string;
  sessionId: string | null;
  shareableSessionId: string | null;
  peerId: string;
  connectionGeneration: number;
  revision: number;
  connected: boolean;
  peers: WebRtcPeerSummary[];
  listenerCount: number;
  pendingRequestCount: number;
  lastEventType: WebRtcOutgoingSignallingEnvelope['type'] | null;
  lastError: WebRtcClientErrorDetails | null;
  mediaTransportStarted: false;
  updatedAt: string;
}

export interface WebRtcSignallingClientOptions {
  role: 'broadcaster' | 'listener';
  broadcastId?: string;
  sessionId?: string;
  peerId?: string;
  ackTimeoutMs?: number;
  createId?: () => string;
  now?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onStateChange?: (snapshot: WebRtcSignallingClientSnapshot) => void;
  onSignalEvent?: (
    event:
      | WebRtcSdpOfferEnvelope
      | WebRtcSdpAnswerEnvelope
      | WebRtcIceCandidateEnvelope
      | WebRtcIceCompleteEnvelope
      | WebRtcPeerReadyEnvelope,
  ) => void;
  onSafeLog?: (event: string, metadata: Record<string, string | number | boolean | null>) => void;
}

type PendingRequestKind = 'create' | 'join' | 'leave' | 'close';

interface PendingRequest {
  kind: PendingRequestKind;
  correlationId: string;
  connectionGeneration: number;
  expectedType: WebRtcOutgoingSignallingEnvelope['type'];
  timer: ReturnType<typeof setTimeout>;
  resolve: (snapshot: WebRtcSignallingClientSnapshot) => void;
  reject: (error: WebRtcClientSignallingError) => void;
}

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_RECOVERY_ATTEMPTS = 3;
const DEFAULT_RECOVERY_BACKOFF_MS = 250;

export function parseShareableWebRtcSessionId(
  input: string,
): { broadcastId: string; sessionId: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes('/') ? '/' : trimmed.includes(':') ? ':' : '';
  if (!separator) return null;
  const [broadcastId, sessionId, ...rest] = trimmed.split(separator);
  if (rest.length > 0 || !broadcastId || !sessionId) return null;
  return { broadcastId, sessionId };
}

export function createShareableWebRtcSessionId(broadcastId: string, sessionId: string): string {
  return `${broadcastId}/${sessionId}`;
}

export class WebRtcSignallingClient {
  private readonly role: 'broadcaster' | 'listener';
  private readonly ackTimeoutMs: number;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onStateChange: ((snapshot: WebRtcSignallingClientSnapshot) => void) | undefined;
  private readonly onSignalEvent:
    | ((
        event:
          | WebRtcSdpOfferEnvelope
          | WebRtcSdpAnswerEnvelope
          | WebRtcIceCandidateEnvelope
          | WebRtcIceCompleteEnvelope
          | WebRtcPeerReadyEnvelope,
      ) => void)
    | undefined;
  private readonly onSafeLog:
    | ((event: string, metadata: Record<string, string | number | boolean | null>) => void)
    | undefined;

  private transport: WebRtcSignallingTransport | null = null;
  private disposed = false;
  private seenMessageIds: string[] = [];
  private pending = new Map<string, PendingRequest>();
  private snapshot: WebRtcSignallingClientSnapshot;

  constructor(options: WebRtcSignallingClientOptions) {
    this.role = options.role;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.createId = options.createId ?? createBrowserSafeId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onStateChange = options.onStateChange;
    this.onSignalEvent = options.onSignalEvent;
    this.onSafeLog = options.onSafeLog;
    const broadcastId = options.broadcastId ?? `broadcast_${this.createId()}`;
    this.snapshot = {
      state: 'idle',
      role: this.role,
      broadcastId,
      sessionId: options.sessionId ?? null,
      shareableSessionId: options.sessionId
        ? createShareableWebRtcSessionId(broadcastId, options.sessionId)
        : null,
      peerId: options.peerId ?? `peer_${this.role}_${this.createId()}`,
      connectionGeneration: 0,
      revision: 0,
      connected: false,
      peers: [],
      listenerCount: 0,
      pendingRequestCount: 0,
      lastEventType: null,
      lastError: null,
      mediaTransportStarted: false,
      updatedAt: this.now(),
    };
  }

  attach(transport: WebRtcSignallingTransport): WebRtcSignallingClientSnapshot {
    if (this.disposed) throw this.clientError('cleanup-failed', 'Signalling client is disposed.');
    if (this.transport === transport) return this.snapshot;
    if (this.transport) this.detach();
    this.transport = transport;
    transport.on(SOCKET_EVENTS.CONNECTED, this.handleConnect);
    transport.on(SOCKET_EVENTS.DISCONNECTED, this.handleDisconnect);
    transport.on(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, this.handleSessionEvent);
    transport.on(SOCKET_EVENTS.WEBRTC_ERROR, this.handleGatewayError);
    if (transport.connected) this.handleConnect();
    else this.transition('connecting');
    return this.snapshot;
  }

  detach(): void {
    if (!this.transport) return;
    this.transport.off(SOCKET_EVENTS.CONNECTED, this.handleConnect);
    this.transport.off(SOCKET_EVENTS.DISCONNECTED, this.handleDisconnect);
    this.transport.off(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, this.handleSessionEvent);
    this.transport.off(SOCKET_EVENTS.WEBRTC_ERROR, this.handleGatewayError);
    this.transport = null;
  }

  getSnapshot(): WebRtcSignallingClientSnapshot {
    return this.snapshot;
  }

  setTargetSession(input: { broadcastId: string; sessionId: string }): WebRtcSignallingClientSnapshot {
    if (this.role !== 'listener') {
      throw this.clientError('forbidden-role', 'Only listeners can select a target session.');
    }
    if (this.snapshot.state === 'joining-session' || this.snapshot.state === 'joined') {
      throw this.clientError('invalid-transition', 'Leave the current session before changing target.');
    }
    this.update({
      broadcastId: input.broadcastId,
      sessionId: input.sessionId,
      shareableSessionId: createShareableWebRtcSessionId(input.broadcastId, input.sessionId),
      lastError: null,
    });
    return this.snapshot;
  }

  async createSession(requestedSessionId?: string): Promise<WebRtcSignallingClientSnapshot> {
    if (this.role !== 'broadcaster') {
      throw this.clientError('forbidden-role', 'Only broadcasters can create signalling sessions.');
    }
    if (this.snapshot.state === 'creating-session' || this.snapshot.state === 'joined') {
      throw this.clientError('duplicate-broadcaster', 'Broadcaster signalling session is already active.');
    }
    this.requireConnected();
    this.transition('creating-session');
    const envelope = this.incomingEnvelope('session-create', {
      payload: requestedSessionId ? { requestedSessionId } : {},
      revision: 0,
    });
    return this.emitWithAck(SOCKET_EVENTS.WEBRTC_SESSION_CREATE, envelope, 'create', 'session-created');
  }

  async joinSession(input?: { broadcastId: string; sessionId: string }): Promise<WebRtcSignallingClientSnapshot> {
    if (this.role !== 'listener') {
      throw this.clientError('forbidden-role', 'Only listeners can join as listeners.');
    }
    if (input) this.setTargetSession(input);
    if (this.snapshot.state === 'joining-session' || this.snapshot.state === 'joined') {
      throw this.clientError('duplicate-peer', 'Listener is already joining or joined.');
    }
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'A signalling session identifier is required.');
    }
    this.requireConnected();
    this.transition('joining-session');
    const envelope = this.incomingEnvelope('session-join', {
      payload: { requestedRole: 'listener' },
      sessionId: this.snapshot.sessionId,
    });
    return this.emitWithAck(SOCKET_EVENTS.WEBRTC_SESSION_JOIN, envelope, 'join', 'session-joined');
  }

  async leaveSession(reason = 'listener left signalling session'): Promise<WebRtcSignallingClientSnapshot> {
    if (!this.snapshot.sessionId || this.snapshot.state === 'idle' || this.snapshot.state === 'closed') {
      this.transition('closed');
      return this.snapshot;
    }
    if (this.snapshot.state === 'leaving') return this.snapshot;
    this.requireConnected();
    this.transition('leaving');
    const envelope = this.incomingEnvelope('peer-disconnect', {
      payload: { reason },
      sessionId: this.snapshot.sessionId,
    });
    return this.emitWithAck(SOCKET_EVENTS.WEBRTC_SESSION_LEAVE, envelope, 'leave', 'peer-disconnect');
  }

  async closeSession(reason = 'broadcaster closed signalling session'): Promise<WebRtcSignallingClientSnapshot> {
    if (this.role !== 'broadcaster') {
      throw this.clientError('forbidden-role', 'Only broadcasters can close broadcaster sessions.');
    }
    if (!this.snapshot.sessionId || this.snapshot.state === 'idle' || this.snapshot.state === 'closed') {
      this.transition('closed');
      return this.snapshot;
    }
    if (this.snapshot.state === 'closing') return this.snapshot;
    this.requireConnected();
    this.transition('closing');
    const envelope = this.incomingEnvelope('session-close', {
      payload: { reason },
      sessionId: this.snapshot.sessionId,
    });
    return this.emitWithAck(SOCKET_EVENTS.WEBRTC_SESSION_CLOSE, envelope, 'close', 'session-close');
  }

  async recoverSession(): Promise<WebRtcSignallingClientSnapshot> {
    if (!this.snapshot.connected) {
      throw this.clientError('gateway-unavailable', 'Gateway signalling is unavailable.', true);
    }
    this.transition('recovering-session');
    if (this.role === 'broadcaster') {
      this.update({ sessionId: null, shareableSessionId: null, peers: [], listenerCount: 0, revision: 0 });
      return this.createSession();
    }
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'No listener signalling session to recover.');
    }
    this.update({ peers: [], listenerCount: 0, revision: 0 });
    return this.joinSession();
  }

  async recoverSessionWithBackoff(options: {
    maxAttempts?: number;
    initialDelayMs?: number;
  } = {}): Promise<WebRtcSignallingClientSnapshot> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RECOVERY_ATTEMPTS);
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_RECOVERY_BACKOFF_MS);
    let lastError: WebRtcClientSignallingError | null = null;
    const startingGeneration = this.snapshot.connectionGeneration;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.snapshot.state === 'closed' || this.snapshot.state === 'failed') {
        throw this.clientError('reconnect-failed', 'Recovery stopped because the signalling session is terminal.', false);
      }
      try {
        this.safeLog('recover-attempt', { attempt, maxAttempts, generation: this.snapshot.connectionGeneration });
        return await this.recoverSession();
      } catch (error) {
        lastError =
          error instanceof WebRtcClientSignallingError
            ? error
            : this.clientError('reconnect-failed', 'Signalling recovery failed.', true);
        if (!lastError.retryable || attempt === maxAttempts) break;
        if (this.snapshot.connectionGeneration !== startingGeneration && !this.snapshot.connected) break;
        await this.delay(initialDelayMs * 2 ** (attempt - 1));
      }
    }
    const finalError = this.clientError(
      'reconnect-failed',
      lastError?.message ?? 'Signalling recovery attempts were exhausted.',
      false,
    );
    this.update({ state: 'failed', lastError: details(finalError) });
    throw finalError;
  }

  sendSdpOffer(input: { targetPeerId: string; sdp: string; revision?: number }): WebRtcSdpOfferEnvelope {
    if (this.role !== 'broadcaster') {
      throw this.clientError('forbidden-role', 'Only broadcasters can send backend media offers.');
    }
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'Create a signalling session before starting media transport.');
    }
    this.requireConnected();
    const revision = input.revision ?? this.snapshot.revision + 1;
    const envelope = this.incomingEnvelope('sdp-offer', {
      sessionId: this.snapshot.sessionId,
      revision,
      payload: { targetPeerId: input.targetPeerId, sdp: input.sdp },
    });
    this.transport?.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, envelope);
    this.update({ revision, lastEventType: 'sdp-offer' });
    this.safeLog('emit', { kind: 'sdp-offer', correlationId: envelope.correlationId ?? null });
    return envelope;
  }

  sendSdpAnswer(input: { targetPeerId: string; sdp: string; revision?: number }): WebRtcSdpAnswerEnvelope {
    if (this.role !== 'listener') {
      throw this.clientError('forbidden-role', 'Only listeners can answer backend media offers.');
    }
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'Join a signalling session before answering media transport.');
    }
    this.requireConnected();
    const envelope = this.incomingEnvelope('sdp-answer', {
      sessionId: this.snapshot.sessionId,
      revision: input.revision ?? this.snapshot.revision,
      payload: { targetPeerId: input.targetPeerId, sdp: input.sdp },
    });
    this.transport?.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, envelope);
    this.update({ lastEventType: 'sdp-answer' });
    this.safeLog('emit', { kind: 'sdp-answer', correlationId: envelope.correlationId ?? null });
    return envelope;
  }

  sendIceCandidate(input: {
    targetPeerId: string;
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
    revision?: number;
  }): WebRtcIceCandidateEnvelope {
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'A signalling session is required before ICE exchange.');
    }
    this.requireConnected();
    const payload: WebRtcIceCandidateEnvelope['payload'] = {
      targetPeerId: input.targetPeerId,
      candidate: input.candidate,
    };
    if (input.sdpMid !== undefined) payload.sdpMid = nonEmptyStringOrNull(input.sdpMid);
    if (input.sdpMLineIndex !== undefined) payload.sdpMLineIndex = validSdpMLineIndexOrNull(input.sdpMLineIndex);
    if (input.usernameFragment !== undefined) payload.usernameFragment = nonEmptyStringOrNull(input.usernameFragment);
    const envelope = this.incomingEnvelope('ice-candidate', {
      sessionId: this.snapshot.sessionId,
      revision: input.revision ?? this.snapshot.revision,
      payload,
    });
    this.transport?.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, envelope);
    this.safeLog('emit', { kind: 'ice-candidate', correlationId: envelope.correlationId ?? null });
    return envelope;
  }

  sendIceComplete(input: { targetPeerId: string; revision?: number }): WebRtcIceCompleteEnvelope {
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'A signalling session is required before ICE completion.');
    }
    this.requireConnected();
    const envelope = this.incomingEnvelope('ice-complete', {
      sessionId: this.snapshot.sessionId,
      revision: input.revision ?? this.snapshot.revision,
      payload: { targetPeerId: input.targetPeerId },
    });
    this.transport?.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, envelope);
    this.safeLog('emit', { kind: 'ice-complete', correlationId: envelope.correlationId ?? null });
    return envelope;
  }

  sendPeerDisconnect(input: {
    targetPeerId: string;
    reason?: string;
    revision?: number;
  }): WebRtcPeerDisconnectEnvelope {
    if (!this.snapshot.sessionId) {
      throw this.clientError('session-not-found', 'A signalling session is required before peer disconnect.');
    }
    this.requireConnected();
    const envelope = this.incomingEnvelope('peer-disconnect', {
      sessionId: this.snapshot.sessionId,
      revision: input.revision ?? this.snapshot.revision,
      payload: {
        targetPeerId: input.targetPeerId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    this.transport?.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, envelope);
    this.safeLog('emit', { kind: 'peer-disconnect', correlationId: envelope.correlationId ?? null });
    return envelope;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.rejectAllPending(this.clientError('cleanup-failed', 'Signalling client disposed.'));
    this.seenMessageIds = [];
    this.update({
      state: 'closed',
      sessionId: null,
      shareableSessionId: null,
      peers: [],
      listenerCount: 0,
      pendingRequestCount: 0,
    });
  }

  private handleConnect = (): void => {
    const nextState =
      this.snapshot.state === 'disconnected' || this.snapshot.state === 'reconnecting'
        ? 'reconnecting'
        : 'connected';
    this.update({
      state: nextState,
      connected: true,
      connectionGeneration: this.snapshot.connectionGeneration + 1,
      lastError: null,
    });
    this.safeLog('connect');
  };

  private handleDisconnect = (): void => {
    const state =
      this.snapshot.state === 'joined' ||
      this.snapshot.state === 'ready' ||
      this.snapshot.state === 'creating-session' ||
      this.snapshot.state === 'joining-session'
        ? 'reconnecting'
        : 'disconnected';
    this.rejectAllPending(this.clientError('gateway-unavailable', 'Gateway signalling disconnected.', true));
    this.update({
      state,
      connected: false,
      connectionGeneration: this.snapshot.connectionGeneration + 1,
    });
    this.safeLog('disconnect');
  };

  private handleSessionEvent = (raw: unknown): void => {
    const event = this.validateOutgoing(raw);
    if (!event) return;
    if (this.isDuplicateEvent(event.messageId)) return;

    const pending = event.correlationId ? this.pending.get(event.correlationId) : undefined;
    if (pending && pending.connectionGeneration !== this.snapshot.connectionGeneration) {
      this.rejectPending(pending, this.clientError('stale-connection-generation', 'Ignored acknowledgement from an obsolete connection.'));
      return;
    }
    if (pending && pending.expectedType !== event.type) {
      this.rejectPending(pending, this.clientError('malformed-acknowledgement', 'Unexpected signalling acknowledgement type.'));
      return;
    }

    if (!this.ownsEvent(event, Boolean(pending))) return;
    if (event.revision < this.snapshot.revision) return;

    this.rememberEvent(event.messageId);
    this.applyLifecycleEvent(event);
    if (
      event.type === 'sdp-offer' ||
      event.type === 'sdp-answer' ||
      event.type === 'ice-candidate' ||
      event.type === 'ice-complete' ||
      event.type === 'peer-ready'
    ) {
      this.onSignalEvent?.(event);
    }

    if (pending) {
      this.resolvePending(pending);
    }
  };

  private handleGatewayError = (raw: unknown): void => {
    const event = this.validateError(raw);
    if (!event) return;
    const error = this.gatewayError(event);
    const pending = event.correlationId ? this.pending.get(event.correlationId) : undefined;
    if (pending) {
      this.rejectPending(pending, error);
      return;
    }
    this.update({ state: error.retryable ? this.snapshot.state : 'failed', lastError: details(error) });
  };

  private incomingEnvelope<TType extends WebRtcIncomingSignallingEnvelope['type']>(
    type: TType,
    overrides: Partial<Extract<WebRtcIncomingSignallingEnvelope, { type: TType }>>,
  ): Extract<WebRtcIncomingSignallingEnvelope, { type: TType }> {
    const messageId = `msg_${this.createId()}`;
    const correlationId = `corr_${this.createId()}`;
    const base = {
      type,
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId,
      correlationId,
      broadcastId: this.snapshot.broadcastId,
      peerId: this.snapshot.peerId,
      senderRole: this.role,
      revision: this.snapshot.revision,
      createdAt: this.now(),
      payload: {},
    };
    return { ...base, ...overrides } as Extract<WebRtcIncomingSignallingEnvelope, { type: TType }>;
  }

  private emitWithAck(
    eventName: string,
    envelope: WebRtcIncomingSignallingEnvelope,
    kind: PendingRequestKind,
    expectedType: WebRtcOutgoingSignallingEnvelope['type'],
  ): Promise<WebRtcSignallingClientSnapshot> {
    if (!envelope.correlationId) {
      return Promise.reject(this.clientError('internal-client-signalling-failure', 'Missing signalling correlation ID.'));
    }
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(this.clientError('gateway-unavailable', 'Gateway signalling socket is unavailable.', true));
    }
    const connectionGeneration = this.snapshot.connectionGeneration;
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        const pending = this.pending.get(envelope.correlationId!);
        if (!pending) return;
        this.rejectPending(
          pending,
          this.clientError('acknowledgement-timeout', 'Timed out waiting for signalling acknowledgement.', true),
        );
      }, this.ackTimeoutMs);
      this.pending.set(envelope.correlationId!, {
        kind,
        correlationId: envelope.correlationId!,
        connectionGeneration,
        expectedType,
        timer,
        resolve,
        reject,
      });
      this.update({ pendingRequestCount: this.pending.size });
      transport.emit(eventName, envelope);
      this.safeLog('emit', { kind, correlationId: envelope.correlationId ?? null });
    });
  }

  private applyLifecycleEvent(event: WebRtcOutgoingSignallingEnvelope): void {
    switch (event.type) {
      case 'session-created':
        this.update({
          state: 'joined',
          sessionId: event.sessionId ?? null,
          shareableSessionId: event.sessionId
            ? createShareableWebRtcSessionId(event.broadcastId, event.sessionId)
            : null,
          revision: event.revision,
          peers: [{ peerId: event.peerId, role: 'broadcaster', state: event.payload.peerState, revision: event.revision }],
          listenerCount: 0,
          lastEventType: event.type,
          lastError: null,
        });
        break;
      case 'session-joined': {
        const peers = event.payload.peers;
        this.update({
          state: 'joined',
          sessionId: event.sessionId ?? this.snapshot.sessionId,
          shareableSessionId: event.sessionId
            ? createShareableWebRtcSessionId(event.broadcastId, event.sessionId)
            : this.snapshot.shareableSessionId,
          revision: event.revision,
          peers,
          listenerCount: peers.filter((peer) => peer.role === 'listener' && peer.state !== 'closed' && peer.state !== 'disconnected').length,
          lastEventType: event.type,
          lastError: null,
        });
        break;
      }
      case 'peer-disconnect':
        this.update({
          state: event.peerId === this.snapshot.peerId ? 'closed' : this.snapshot.state,
          peers: this.snapshot.peers.map((peer) =>
            peer.peerId === event.peerId ? { ...peer, state: 'disconnected', revision: event.revision } : peer,
          ),
          listenerCount:
            event.senderRole === 'listener'
              ? Math.max(0, this.snapshot.listenerCount - 1)
              : this.snapshot.listenerCount,
          revision: Math.max(this.snapshot.revision, event.revision),
          lastEventType: event.type,
        });
        break;
      case 'session-close':
        this.update({
          state: 'closed',
          revision: Math.max(this.snapshot.revision, event.revision),
          peers: this.snapshot.peers.map((peer) => ({ ...peer, state: 'closed' })),
          listenerCount: 0,
          lastEventType: event.type,
        });
        break;
      case 'peer-ready':
        this.update({ state: 'ready', revision: event.revision, lastEventType: event.type });
        break;
      case 'heartbeat-ack':
        this.update({ lastEventType: event.type });
        break;
      default:
        this.update({ lastEventType: event.type });
        break;
    }
  }

  private validateOutgoing(raw: unknown): WebRtcOutgoingSignallingEnvelope | null {
    if (!raw || typeof raw !== 'object') {
      this.update({ lastError: details(this.clientError('malformed-acknowledgement', 'Malformed signalling event.')) });
      return null;
    }
    const event = raw as Partial<WebRtcOutgoingSignallingEnvelope>;
    if (
      typeof event.protocolVersion !== 'number' ||
      typeof event.type !== 'string' ||
      typeof event.messageId !== 'string' ||
      typeof event.broadcastId !== 'string' ||
      typeof event.peerId !== 'string' ||
      typeof event.revision !== 'number' ||
      !event.payload
    ) {
      this.update({ lastError: details(this.clientError('malformed-acknowledgement', 'Malformed signalling event.')) });
      return null;
    }
    if (event.protocolVersion !== WEBRTC_SIGNALLING_PROTOCOL_VERSION) {
      this.update({
        state: 'failed',
        lastError: details(this.clientError('unsupported-protocol-version', 'Unsupported signalling protocol version.')),
      });
      return null;
    }
    return event as WebRtcOutgoingSignallingEnvelope;
  }

  private validateError(raw: unknown): WebRtcSignallingErrorEnvelope | null {
    const event = this.validateOutgoing(raw);
    if (!event || event.type !== 'signalling-error') return null;
    return event;
  }

  private ownsEvent(event: WebRtcOutgoingSignallingEnvelope, isPendingAck: boolean): boolean {
    if (event.broadcastId !== this.snapshot.broadcastId) return false;
    if (event.sessionId && this.snapshot.sessionId && event.sessionId !== this.snapshot.sessionId) {
      return false;
    }
    if (!isPendingAck && !this.snapshot.sessionId) return false;
    if (event.type === 'session-created' && this.role !== 'broadcaster') return false;
    return true;
  }

  private isDuplicateEvent(messageId: string): boolean {
    return this.seenMessageIds.includes(messageId);
  }

  private rememberEvent(messageId: string): void {
    this.seenMessageIds.push(messageId);
    if (this.seenMessageIds.length > 256) {
      this.seenMessageIds.splice(0, this.seenMessageIds.length - 256);
    }
  }

  private requireConnected(): void {
    if (!this.transport || !this.snapshot.connected) {
      throw this.clientError('gateway-unavailable', 'Gateway signalling is unavailable.', true);
    }
  }

  private resolvePending(pending: PendingRequest): void {
    this.clearTimer(pending.timer);
    this.pending.delete(pending.correlationId);
    this.update({ pendingRequestCount: this.pending.size });
    pending.resolve(this.snapshot);
  }

  private rejectPending(pending: PendingRequest, error: WebRtcClientSignallingError): void {
    this.clearTimer(pending.timer);
    this.pending.delete(pending.correlationId);
    this.update({ pendingRequestCount: this.pending.size, lastError: details(error) });
    pending.reject(error);
  }

  private rejectAllPending(error: WebRtcClientSignallingError): void {
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(pending, error);
    }
  }

  private transition(state: WebRtcClientLifecycleState): void {
    this.update({ state });
  }

  private update(next: Partial<WebRtcSignallingClientSnapshot>): void {
    if (this.disposed && next.state !== 'closed') return;
    this.snapshot = {
      ...this.snapshot,
      ...next,
      mediaTransportStarted: false,
      updatedAt: this.now(),
    };
    this.onStateChange?.(this.snapshot);
  }

  private gatewayError(event: WebRtcSignallingErrorEnvelope): WebRtcClientSignallingError {
    return this.clientError(mapGatewayErrorCode(event.payload.code), event.payload.message, event.payload.retryable);
  }

  private clientError(
    code: WebRtcClientErrorCode,
    message: string,
    retryable = false,
  ): WebRtcClientSignallingError {
    return new WebRtcClientSignallingError(code, message, retryable);
  }

  private safeLog(event: string, metadata: Record<string, string | number | boolean | null> = {}): void {
    this.onSafeLog?.(event, {
      role: this.role,
      state: this.snapshot.state,
      generation: this.snapshot.connectionGeneration,
      hasSession: Boolean(this.snapshot.sessionId),
      ...metadata,
    });
  }

  private delay(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.setTimer(resolve, delayMs);
    });
  }
}

function mapGatewayErrorCode(code: WebRtcSignallingErrorCode): WebRtcClientErrorCode {
  if (code === 'invalid-payload') return 'malformed-acknowledgement';
  if (code === 'unsupported-protocol-version') return 'unsupported-protocol-version';
  if (code === 'unauthorized') return 'unauthorized';
  if (code === 'forbidden-role') return 'forbidden-role';
  if (code === 'session-not-found') return 'session-not-found';
  if (code === 'session-already-exists') return 'session-already-exists';
  if (code === 'duplicate-broadcaster') return 'duplicate-broadcaster';
  if (code === 'duplicate-peer') return 'duplicate-peer';
  if (code === 'stale-session' || code === 'stale-negotiation') return 'stale-session';
  if (code === 'session-closed') return 'session-closed';
  if (code === 'payload-too-large') return 'payload-too-large';
  if (code === 'peer-not-found') return 'peer-not-found';
  if (code === 'backend-webrtc-unavailable') return 'backend-webrtc-unavailable';
  if (code === 'dependency-initialization-failure') return 'dependency-initialization-failure';
  if (code === 'peer-already-exists') return 'peer-already-exists';
  if (code === 'missing-audio-track') return 'missing-audio-track';
  if (code === 'duplicate-audio-track') return 'duplicate-audio-track';
  if (code === 'missing-video-track') return 'missing-video-track';
  if (code === 'duplicate-video-track') return 'duplicate-video-track';
  if (code === 'unexpected-video-track') return 'unexpected-video-track';
  if (code === 'invalid-offer') return 'invalid-offer';
  if (code === 'answer-creation-failure') return 'answer-creation-failure';
  if (code === 'invalid-answer') return 'invalid-answer';
  if (code === 'remote-description-failure') return 'remote-description-failure';
  if (code === 'local-description-failure') return 'local-description-failure';
  if (code === 'ice-candidate-failure') return 'ice-candidate-failure';
  if (code === 'ice-connection-failure') return 'ice-connection-failure';
  if (code === 'negotiation-timeout') return 'negotiation-timeout';
  if (code === 'connection-closed') return 'connection-closed';
  if (code === 'audio-track-ended') return 'audio-track-ended';
  if (code === 'video-track-ended') return 'video-track-ended';
  if (code === 'ingest-bridge-failure') return 'ingest-bridge-failure';
  if (code === 'unsupported-runtime') return 'unsupported-runtime';
  return 'internal-client-signalling-failure';
}

function details(error: WebRtcClientSignallingError): WebRtcClientErrorDetails {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function createBrowserSafeId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().replace(/-/g, '_');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nonEmptyStringOrNull(input: string | null): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed ? input : null;
}

function validSdpMLineIndexOrNull(input: number | null): number | null {
  if (input === null) return null;
  return Number.isInteger(input) && input >= 0 && input <= 128 ? input : null;
}
