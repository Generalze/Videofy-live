import { z } from 'zod';
import {
  WEBRTC_SIGNALLING_LIMITS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIncomingSignallingEnvelope,
  type WebRtcSignallingErrorCode,
} from '@videofy-live/shared-types';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/;

export const WebRtcIdentifierSchema = z
  .string()
  .min(3)
  .max(WEBRTC_SIGNALLING_LIMITS.identifierMaxLength)
  .regex(identifierPattern);

export const WebRtcSignallingRoleSchema = z.enum(['broadcaster', 'listener', 'server']);

export const WebRtcSessionStateSchema = z.enum([
  'created',
  'waiting',
  'negotiating',
  'ready',
  'closing',
  'closed',
  'failed',
]);

export const WebRtcPeerStateSchema = z.enum([
  'registered',
  'joined',
  'negotiating',
  'ready',
  'disconnected',
  'closed',
]);

export const WebRtcSignallingErrorCodeSchema = z.enum([
  'invalid-payload',
  'unsupported-protocol-version',
  'unauthorized',
  'forbidden-role',
  'session-not-found',
  'session-already-exists',
  'peer-not-found',
  'duplicate-peer',
  'duplicate-broadcaster',
  'duplicate-message',
  'stale-session',
  'stale-negotiation',
  'invalid-state-transition',
  'offer-required',
  'session-closed',
  'payload-too-large',
  'backend-webrtc-unavailable',
  'dependency-initialization-failure',
  'peer-already-exists',
  'missing-audio-track',
  'duplicate-audio-track',
  'missing-video-track',
  'duplicate-video-track',
  'unexpected-video-track',
  'invalid-offer',
  'answer-creation-failure',
  'invalid-answer',
  'remote-description-failure',
  'local-description-failure',
  'ice-candidate-failure',
  'ice-connection-failure',
  'negotiation-timeout',
  'connection-closed',
  'audio-track-ended',
  'video-track-ended',
  'ingest-bridge-failure',
  'cleanup-failure',
  'unsupported-runtime',
  'internal-signalling-error',
] satisfies [WebRtcSignallingErrorCode, ...WebRtcSignallingErrorCode[]]);

const EnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(WEBRTC_SIGNALLING_PROTOCOL_VERSION),
  messageId: WebRtcIdentifierSchema,
  correlationId: WebRtcIdentifierSchema.optional(),
  broadcastId: WebRtcIdentifierSchema,
  sessionId: WebRtcIdentifierSchema.optional(),
  peerId: WebRtcIdentifierSchema,
  senderRole: WebRtcSignallingRoleSchema,
  revision: z.number().int().nonnegative().max(1_000_000),
  createdAt: z.string().datetime(),
});

const RequiredSessionEnvelopeBaseSchema = EnvelopeBaseSchema.extend({
  sessionId: WebRtcIdentifierSchema,
});

const TargetPeerPayloadSchema = z.object({
  targetPeerId: WebRtcIdentifierSchema,
});

const SessionCreateSchema = EnvelopeBaseSchema.extend({
  type: z.literal('session-create'),
  sessionId: z.undefined().optional(),
  senderRole: z.literal('broadcaster'),
  revision: z.literal(0),
  payload: z.object({
    requestedSessionId: WebRtcIdentifierSchema.optional(),
  }),
});

const SessionJoinSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('session-join'),
  payload: z.object({
    requestedRole: WebRtcSignallingRoleSchema,
  }),
});

const SdpOfferSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('sdp-offer'),
  senderRole: z.literal('broadcaster'),
  payload: TargetPeerPayloadSchema.extend({
    sdp: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength),
  }),
});

const SdpAnswerSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('sdp-answer'),
  payload: TargetPeerPayloadSchema.extend({
    sdp: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength),
  }),
});

const IceCandidateSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('ice-candidate'),
  payload: TargetPeerPayloadSchema.extend({
    candidate: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.iceCandidateMaxLength),
    sdpMid: z.string().min(1).max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().max(128).nullable().optional(),
    usernameFragment: z.string().min(1).max(256).nullable().optional(),
  }),
});

const IceCompleteSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('ice-complete'),
  payload: TargetPeerPayloadSchema,
});

const PeerReadySchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('peer-ready'),
  payload: z.object({
    state: WebRtcPeerStateSchema,
    // Truthful backend media receipt so clients cannot fabricate video state.
    audioTrackReceived: z.boolean().optional(),
    videoTrackReceived: z.boolean().optional(),
  }),
});

const PeerDisconnectSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('peer-disconnect'),
  payload: z.object({
    targetPeerId: WebRtcIdentifierSchema.optional(),
    reason: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.reasonMaxLength).optional(),
  }),
});

const SessionCloseSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('session-close'),
  payload: z.object({
    reason: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.reasonMaxLength).optional(),
  }),
});

const HeartbeatAckSchema = RequiredSessionEnvelopeBaseSchema.extend({
  type: z.literal('heartbeat-ack'),
  payload: z.object({
    observedAt: z.string().datetime(),
  }),
});

export const WebRtcIncomingSignallingEnvelopeSchema = z.discriminatedUnion('type', [
  SessionCreateSchema,
  SessionJoinSchema,
  SdpOfferSchema,
  SdpAnswerSchema,
  IceCandidateSchema,
  IceCompleteSchema,
  PeerReadySchema,
  PeerDisconnectSchema,
  SessionCloseSchema,
  HeartbeatAckSchema,
]);

export type ValidatedWebRtcIncomingSignallingEnvelope = z.infer<
  typeof WebRtcIncomingSignallingEnvelopeSchema
> &
  WebRtcIncomingSignallingEnvelope;

export function parseWebRtcSignallingEnvelope(
  raw: unknown,
): ValidatedWebRtcIncomingSignallingEnvelope {
  return WebRtcIncomingSignallingEnvelopeSchema.parse(
    raw,
  ) as ValidatedWebRtcIncomingSignallingEnvelope;
}

export function safeParseWebRtcSignallingEnvelope(raw: unknown) {
  return WebRtcIncomingSignallingEnvelopeSchema.safeParse(raw);
}

export function isUnsupportedWebRtcProtocolVersion(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const version = (raw as { protocolVersion?: unknown }).protocolVersion;
  return version !== undefined && version !== WEBRTC_SIGNALLING_PROTOCOL_VERSION;
}
