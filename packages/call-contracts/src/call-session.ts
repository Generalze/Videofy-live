/** @owner masterzee001 */
import { z } from 'zod';
import {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  MediaClockDescriptorSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
} from './primitives.js';
import { AdapterCapabilitiesSchema, ParticipantSchema } from '@videofy-live/participant-contracts';

export const CallSessionModeSchema = z.enum(['call', 'conference', 'programme']);
export const CallSessionLifecycleStateSchema = z.enum([
  'created',
  'waiting',
  'joining',
  'active',
  'reconnecting',
  'ending',
  'ended',
  'failed',
]);

/**
 * These literal values are deliberate hard guards. Runtime wiring must not make
 * generated audio eligible for the raw STT bus.
 */
export const MediaPolicySchema = z
  .object({
    mediaClock: MediaClockDescriptorSchema,
    sttInput: z.literal('raw-source-only'),
    generatedAudioEgress: z.literal('generated-audio-egress-only'),
    rejectStaleMediaRevision: z.literal(true),
  })
  .strict();

export const CaptionPolicySchema = z
  .object({
    enabled: z.boolean(),
    keepOriginalAvailable: z.boolean(),
    rejectStaleLanguageRevision: z.literal(true),
  })
  .strict();

export const VoicePolicySchema = z
  .object({
    allowPersonalVoice: z.boolean(),
    fallbackOrder: z.tuple([
      z.literal('personal-voice'),
      z.literal('standard-tts'),
      z.literal('translated-text'),
      z.literal('original-media'),
    ]),
  })
  .strict();

/**
 * Adapter identifiers and any external identifier stay under metadata. The core
 * only consumes canonical session and participant identifiers.
 */
export const IntegrationContextSchema = z
  .object({
    adapterId: z.string().min(1).max(256),
    adapterKind: z.enum(['native-sdk', 'official-adapter', 'webrtc', 'sip-rtp', 'media-bridge']),
    capabilities: AdapterCapabilitiesSchema,
    externalIdentifiers: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

/**
 * Participant records remain authoritative in participant-contracts; this package
 * composes that schema instead of creating a second participant authority.
 */
export const CallSessionSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    mode: CallSessionModeSchema,
    lifecycleState: CallSessionLifecycleStateSchema,
    participants: z.array(ParticipantSchema),
    mediaPolicy: MediaPolicySchema,
    captionPolicy: CaptionPolicySchema,
    voicePolicy: VoicePolicySchema,
    integrationContext: IntegrationContextSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((session, context) => {
    session.participants.forEach((participant, index) => {
      if (participant.sessionId !== session.sessionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['participants', index, 'sessionId'],
          message: 'every participant must belong to the call session',
        });
      }
    });
  });

/** Session-scoped authoritative revisions used at service boundaries. */
export const ParticipantRevisionContextSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    participantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
  })
  .strict();

export type CallSession = z.infer<typeof CallSessionSchema>;
export type MediaPolicy = z.infer<typeof MediaPolicySchema>;
export type CaptionPolicy = z.infer<typeof CaptionPolicySchema>;
export type VoicePolicy = z.infer<typeof VoicePolicySchema>;
export type IntegrationContext = z.infer<typeof IntegrationContextSchema>;

export function parseCallSession(raw: unknown): CallSession {
  return CallSessionSchema.parse(raw);
}

export function safeParseCallSession(raw: unknown) {
  return CallSessionSchema.safeParse(raw);
}
