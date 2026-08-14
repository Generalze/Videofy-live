/** @owner masterzee001 */
import { z } from 'zod';
import {
  AudioModeSchema,
  AudioPreferenceSchema,
  CaptionPreferenceSchema,
  LanguagePreferenceSchema,
  VoiceModeSchema,
  VoicePreferenceSchema,
} from '@videofy-live/participant-contracts';
import {
  CallSessionIdSchema,
  EventSequenceSchema,
  LanguageRevisionSchema,
  LanguageTagSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
} from './primitives.js';

export const RecipientAudioModeSchema = AudioModeSchema;
export const RecipientVoiceModeSchema = VoiceModeSchema;
const RecipientCaptionPreferenceSchema = CaptionPreferenceSchema.extend({
  includeOriginal: z.boolean(),
});
export const RecipientPreferencesSchema = z
  .object({
    language: LanguagePreferenceSchema,
    caption: RecipientCaptionPreferenceSchema,
    audio: AudioPreferenceSchema,
    voice: VoicePreferenceSchema,
  })
  .strict();

/** A platform-neutral request to determine one recipient's output. */
export const RecipientOutputRequestSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    recipientParticipantId: ParticipantIdSchema,
    speakerParticipantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    sourceSequence: EventSequenceSchema,
    recipientPreferences: RecipientPreferencesSchema,
  })
  .strict();

/** The recipient-router decision; it deliberately contains no transport identifiers. */
export const RecipientOutputPlanSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    recipientParticipantId: ParticipantIdSchema,
    speakerParticipantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    sourceSequence: EventSequenceSchema,
    targetLanguage: LanguageTagSchema,
    captionLanguage: LanguageTagSchema.nullable(),
    deliverCaption: z.boolean(),
    deliverGeneratedAudio: z.boolean(),
    generatedAudioEgressOnly: z.literal(true),
    originalAudioTreatment: z.enum(['suppressed', 'ducked', 'primary']),
    selectedVoiceMode: RecipientVoiceModeSchema,
    selectedVoiceId: z.string().min(1).nullable(),
    fallbackPath: z.enum([
      'same-language-original',
      'personal',
      'standard',
      'translated-text',
      'original-media',
      'unavailable',
    ]),
  })
  .strict();

export type RecipientOutputRequest = z.infer<typeof RecipientOutputRequestSchema>;
export type RecipientOutputPlan = z.infer<typeof RecipientOutputPlanSchema>;
export type RecipientPreferences = z.infer<typeof RecipientPreferencesSchema>;
