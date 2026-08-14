/** @owner masterzee001 */
import { z } from 'zod';
import {
  AudioPreferenceSchema,
  CaptionPreferenceSchema,
  LanguagePreferenceSchema,
  ParticipantMediaSchema,
  ParticipantSchema,
  VoicePreferenceSchema,
} from '@videofy-live/participant-contracts';
import {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
} from './primitives.js';

/** External/platform identifiers are allowed only as adapter-bound metadata. */
export const ProgrammeIntegrationMetadataSchema = z
  .object({
    externalIdentifiers: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

/**
 * The programme compatibility input composes the authoritative ParticipantMedia
 * record with ordinary participant language, caption, audio, and voice preferences.
 */
export const ProgrammeParticipantProjectionInputSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    participantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    displayName: z.string().min(1),
    media: ParticipantMediaSchema,
    languagePreference: LanguagePreferenceSchema,
    captionPreference: CaptionPreferenceSchema,
    audioPreference: AudioPreferenceSchema,
    voicePreference: VoicePreferenceSchema,
    integrationMetadata: ProgrammeIntegrationMetadataSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.media.sessionId !== input.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media', 'sessionId'],
        message: 'media.sessionId must match the programme sessionId',
      });
    }
    if (input.media.participantId !== input.participantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media', 'participantId'],
        message: 'media.participantId must match the programme participantId',
      });
    }
    if (input.media.mediaRevision !== input.mediaRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media', 'mediaRevision'],
        message: 'media.mediaRevision must match the programme mediaRevision',
      });
    }
    if (input.languagePreference.languageRevision !== input.languageRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languagePreference', 'languageRevision'],
        message: 'languagePreference.languageRevision must match the programme languageRevision',
      });
    }
  });

export const ProgrammeParticipantProjectionSchema = z
  .object({
    mode: z.literal('programme'),
    participant: ParticipantSchema,
    media: ParticipantMediaSchema,
    integrationMetadata: ProgrammeIntegrationMetadataSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.participant.role !== 'programme') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participant', 'role'],
        message: 'programme projection participant role must be programme',
      });
    }
    if (projection.participant.sessionId !== projection.media.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participant', 'sessionId'],
        message: 'participant and media sessionId must match',
      });
    }
    if (projection.participant.participantId !== projection.media.participantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participant', 'participantId'],
        message: 'participant and media participantId must match',
      });
    }
    if (projection.participant.mediaRevision !== projection.media.mediaRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participant', 'mediaRevision'],
        message: 'participant and media mediaRevision must match',
      });
    }
    if (
      JSON.stringify(projection.participant.connectionCapabilities) !==
      JSON.stringify(projection.media.capabilities)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participant', 'connectionCapabilities'],
        message: 'participant capabilities must be derived from media capabilities',
      });
    }
  });

export type ProgrammeParticipantProjectionInput = z.input<
  typeof ProgrammeParticipantProjectionInputSchema
>;
export type ProgrammeParticipantProjection = z.infer<typeof ProgrammeParticipantProjectionSchema>;

/** Pure programme-as-participant projection; it neither mutates media nor invokes a service. */
export function projectProgrammeParticipant(
  rawInput: ProgrammeParticipantProjectionInput,
): ProgrammeParticipantProjection {
  const input = ProgrammeParticipantProjectionInputSchema.parse(rawInput);
  return ProgrammeParticipantProjectionSchema.parse({
    mode: 'programme',
    participant: {
      participantId: input.participantId,
      sessionId: input.sessionId,
      displayName: input.displayName,
      role: 'programme',
      sourceLanguage: input.languagePreference.sourceLanguage,
      sourceLanguageMode: input.languagePreference.sourceLanguageMode,
      sourceLanguageLocked: input.languagePreference.sourceLanguageLocked,
      preferredLanguage: input.languagePreference.preferredLanguage,
      captionLanguage: input.languagePreference.captionLanguage,
      audioMode: input.audioPreference.mode,
      voiceMode: input.voicePreference.mode,
      ...(input.voicePreference.voiceProfileId === undefined
        ? {}
        : { voiceProfileId: input.voicePreference.voiceProfileId }),
      connectionCapabilities: input.media.capabilities,
      mediaRevision: input.mediaRevision,
      languageRevision: input.languageRevision,
    },
    media: input.media,
    integrationMetadata: input.integrationMetadata,
  });
}
