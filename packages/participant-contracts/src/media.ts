/** @author masterzee001 */
import { z } from 'zod';

import { CallSessionIdSchema, MediaRevisionSchema, ParticipantIdSchema } from './identifiers.js';

const OpaqueIdentifierSchema = z.string().min(1);
const PositiveFiniteNumberSchema = z.number().finite().positive();

/** A single millisecond timebase shared by source media and derived output. */
export const MediaClockDescriptorSchema = z
  .object({
    clockId: OpaqueIdentifierSchema,
    timebase: z.literal('milliseconds'),
    originTimestampMs: z.number().finite(),
  })
  .strict();

/**
 * A normalized source track that is eligible for STT. Its literal signal and
 * bus make generated audio structurally incompatible with ParticipantMedia.
 */
export const NormalizedRawAudioTrackSchema = z
  .object({
    trackId: OpaqueIdentifierSchema,
    kind: z.literal('audio'),
    signal: z.literal('raw-audio'),
    bus: z.literal('stt-ingress'),
    codec: OpaqueIdentifierSchema,
    sampleRateHz: PositiveFiniteNumberSchema,
    channels: z.number().int().positive(),
  })
  .strict();

/** §24.1 name; it remains raw-only by construction. */
export const NormalizedAudioTrackSchema = NormalizedRawAudioTrackSchema;

export const NormalizedVideoTrackSchema = z
  .object({
    trackId: OpaqueIdentifierSchema,
    kind: z.literal('video'),
    codec: OpaqueIdentifierSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: PositiveFiniteNumberSchema,
  })
  .strict();

export const ParticipantMediaCapabilitiesSchema = z
  .object({
    rawAudio: z.boolean(),
    video: z.boolean(),
    screenShare: z.boolean(),
    timestamps: z.boolean(),
    codecInformation: z.boolean(),
  })
  .strict();

/** The §24.1 normalized source-media contract. */
export const ParticipantMediaSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    participantId: ParticipantIdSchema,
    adapterId: OpaqueIdentifierSchema,
    mediaRevision: MediaRevisionSchema,
    audioTrack: NormalizedRawAudioTrackSchema.optional(),
    videoTrack: NormalizedVideoTrackSchema.optional(),
    timestamps: MediaClockDescriptorSchema,
    capabilities: ParticipantMediaCapabilitiesSchema,
  })
  .strict();

/**
 * Generated audio is an egress-only payload. It deliberately has no STT bus
 * and cannot be used where NormalizedRawAudioTrack is required.
 */
export const GeneratedAudioEgressSchema = z
  .object({
    recipientParticipantId: ParticipantIdSchema,
    kind: z.literal('audio'),
    signal: z.literal('generated-audio'),
    bus: z.literal('recipient-egress'),
    audioRef: OpaqueIdentifierSchema,
    timestamps: MediaClockDescriptorSchema,
  })
  .strict();

export type MediaClockDescriptor = z.infer<typeof MediaClockDescriptorSchema>;
export type NormalizedRawAudioTrack = z.infer<typeof NormalizedRawAudioTrackSchema>;
export type NormalizedAudioTrack = z.infer<typeof NormalizedAudioTrackSchema>;
export type NormalizedVideoTrack = z.infer<typeof NormalizedVideoTrackSchema>;
export type ParticipantMediaCapabilities = z.infer<typeof ParticipantMediaCapabilitiesSchema>;
export type ParticipantMedia = z.infer<typeof ParticipantMediaSchema>;
export type GeneratedAudioEgress = z.infer<typeof GeneratedAudioEgressSchema>;

export function parseParticipantMedia(raw: unknown): ParticipantMedia {
  return ParticipantMediaSchema.parse(raw);
}

export function parseGeneratedAudioEgress(raw: unknown): GeneratedAudioEgress {
  return GeneratedAudioEgressSchema.parse(raw);
}
