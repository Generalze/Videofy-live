export const WEBRTC_SIGNALLING_PROTOCOL_VERSION = 1 as const;
export const WEBRTC_BACKEND_MEDIA_PEER_ID = 'peer_backend_media' as const;

export const WEBRTC_SIGNALLING_LIMITS = {
  identifierMaxLength: 128,
  rawPayloadMaxBytes: 131_072,
  sdpMaxLength: 65_536,
  iceCandidateMaxLength: 4_096,
  reasonMaxLength: 512,
  messageCacheSize: 512,
  maxPeersPerSession: 64,
  maxActiveSessions: 100,
  maxMessagesPerSocketWindow: 120,
  rateLimitWindowMs: 10_000,
} as const;

export type WebRtcSignallingProtocolVersion = typeof WEBRTC_SIGNALLING_PROTOCOL_VERSION;

export type WebRtcSignallingRole = 'broadcaster' | 'listener' | 'server';

export type WebRtcSessionState =
  | 'created'
  | 'waiting'
  | 'negotiating'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed';

export type WebRtcPeerState =
  | 'registered'
  | 'joined'
  | 'negotiating'
  | 'ready'
  | 'disconnected'
  | 'closed';

export type WebRtcSignallingMessageType =
  | 'session-create'
  | 'session-created'
  | 'session-join'
  | 'session-joined'
  | 'sdp-offer'
  | 'sdp-answer'
  | 'ice-candidate'
  | 'ice-complete'
  | 'peer-ready'
  | 'peer-disconnect'
  | 'session-close'
  | 'signalling-error'
  | 'heartbeat-ack';

export type WebRtcSignallingErrorCode =
  | 'invalid-payload'
  | 'unsupported-protocol-version'
  | 'unauthorized'
  | 'forbidden-role'
  | 'session-not-found'
  | 'session-already-exists'
  | 'peer-not-found'
  | 'duplicate-peer'
  | 'duplicate-broadcaster'
  | 'duplicate-message'
  | 'stale-session'
  | 'stale-negotiation'
  | 'invalid-state-transition'
  | 'offer-required'
  | 'session-closed'
  | 'payload-too-large'
  | 'backend-webrtc-unavailable'
  | 'dependency-initialization-failure'
  | 'peer-already-exists'
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
  | 'cleanup-failure'
  | 'unsupported-runtime'
  | 'internal-signalling-error';

export interface WebRtcSignallingEnvelopeBase<TType extends WebRtcSignallingMessageType, TPayload> {
  type: TType;
  protocolVersion: WebRtcSignallingProtocolVersion;
  messageId: string;
  correlationId?: string;
  broadcastId: string;
  sessionId?: string;
  peerId: string;
  senderRole: WebRtcSignallingRole;
  revision: number;
  createdAt: string;
  payload: TPayload;
}

export interface WebRtcSessionCreatePayload {
  requestedSessionId?: string;
}

export interface WebRtcSessionCreatedPayload {
  sessionState: WebRtcSessionState;
  peerState: WebRtcPeerState;
  expiresAt?: string;
}

export interface WebRtcSessionJoinPayload {
  requestedRole: WebRtcSignallingRole;
}

export interface WebRtcSessionJoinedPayload {
  sessionState: WebRtcSessionState;
  peerState: WebRtcPeerState;
  peers: WebRtcPeerSummary[];
}

export interface WebRtcSdpPayload {
  targetPeerId: string;
  sdp: string;
}

export interface WebRtcIceCandidatePayload {
  targetPeerId: string;
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface WebRtcTargetPeerPayload {
  targetPeerId: string;
}

export interface WebRtcPeerReadyPayload {
  state: WebRtcPeerState;
}

export interface WebRtcDisconnectPayload {
  reason?: string;
  targetPeerId?: string;
}

export interface WebRtcSessionClosePayload {
  reason?: string;
}

export interface WebRtcHeartbeatAckPayload {
  observedAt: string;
}

export interface WebRtcSignallingErrorPayload {
  code: WebRtcSignallingErrorCode;
  message: string;
  retryable: boolean;
  currentState?: WebRtcSessionState | WebRtcPeerState;
}

export interface WebRtcPeerSummary {
  peerId: string;
  role: WebRtcSignallingRole;
  state: WebRtcPeerState;
  revision: number;
}

export interface WebRtcSessionSummary {
  sessionId: string;
  broadcastId: string;
  state: WebRtcSessionState;
  revision: number;
  broadcasterPeerId: string;
  peerCount: number;
  peers: WebRtcPeerSummary[];
  createdAt: string;
  updatedAt: string;
}

export type WebRtcSessionCreateEnvelope = WebRtcSignallingEnvelopeBase<
  'session-create',
  WebRtcSessionCreatePayload
>;
export type WebRtcSessionCreatedEnvelope = WebRtcSignallingEnvelopeBase<
  'session-created',
  WebRtcSessionCreatedPayload
>;
export type WebRtcSessionJoinEnvelope = WebRtcSignallingEnvelopeBase<
  'session-join',
  WebRtcSessionJoinPayload
>;
export type WebRtcSessionJoinedEnvelope = WebRtcSignallingEnvelopeBase<
  'session-joined',
  WebRtcSessionJoinedPayload
>;
export type WebRtcSdpOfferEnvelope = WebRtcSignallingEnvelopeBase<'sdp-offer', WebRtcSdpPayload>;
export type WebRtcSdpAnswerEnvelope = WebRtcSignallingEnvelopeBase<'sdp-answer', WebRtcSdpPayload>;
export type WebRtcIceCandidateEnvelope = WebRtcSignallingEnvelopeBase<
  'ice-candidate',
  WebRtcIceCandidatePayload
>;
export type WebRtcIceCompleteEnvelope = WebRtcSignallingEnvelopeBase<
  'ice-complete',
  WebRtcTargetPeerPayload
>;
export type WebRtcPeerReadyEnvelope = WebRtcSignallingEnvelopeBase<
  'peer-ready',
  WebRtcPeerReadyPayload
>;
export type WebRtcPeerDisconnectEnvelope = WebRtcSignallingEnvelopeBase<
  'peer-disconnect',
  WebRtcDisconnectPayload
>;
export type WebRtcSessionCloseEnvelope = WebRtcSignallingEnvelopeBase<
  'session-close',
  WebRtcSessionClosePayload
>;
export type WebRtcHeartbeatAckEnvelope = WebRtcSignallingEnvelopeBase<
  'heartbeat-ack',
  WebRtcHeartbeatAckPayload
>;
export type WebRtcSignallingErrorEnvelope = WebRtcSignallingEnvelopeBase<
  'signalling-error',
  WebRtcSignallingErrorPayload
>;

export type WebRtcIncomingSignallingEnvelope =
  | WebRtcSessionCreateEnvelope
  | WebRtcSessionJoinEnvelope
  | WebRtcSdpOfferEnvelope
  | WebRtcSdpAnswerEnvelope
  | WebRtcIceCandidateEnvelope
  | WebRtcIceCompleteEnvelope
  | WebRtcPeerReadyEnvelope
  | WebRtcPeerDisconnectEnvelope
  | WebRtcSessionCloseEnvelope
  | WebRtcHeartbeatAckEnvelope;

export type WebRtcOutgoingSignallingEnvelope =
  | WebRtcSessionCreatedEnvelope
  | WebRtcSessionJoinedEnvelope
  | WebRtcSdpOfferEnvelope
  | WebRtcSdpAnswerEnvelope
  | WebRtcIceCandidateEnvelope
  | WebRtcIceCompleteEnvelope
  | WebRtcPeerReadyEnvelope
  | WebRtcPeerDisconnectEnvelope
  | WebRtcSessionCloseEnvelope
  | WebRtcHeartbeatAckEnvelope
  | WebRtcSignallingErrorEnvelope;
