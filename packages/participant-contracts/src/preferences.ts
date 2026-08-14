/** @author masterzee001 */
import { z } from 'zod';

import { LanguageRevisionSchema, LanguageTagSchema } from './identifiers.js';

const RecipientAudioLevelSchema = z.number().finite().min(0).max(1);

export const SourceLanguageModeSchema = z.enum(['manual', 'auto', 'confirmed-auto']);

const LanguagePreferenceBaseSchema = z
  .object({
    sourceLanguage: LanguageTagSchema.nullable(),
    sourceLanguageMode: SourceLanguageModeSchema,
    sourceLanguageLocked: z.boolean(),
    preferredLanguage: LanguageTagSchema,
    captionLanguage: LanguageTagSchema,
    languageRevision: LanguageRevisionSchema,
  })
  .strict();

/** §24.2 language authority, including non-null language lock invariants. */
export const LanguagePreferenceSchema = LanguagePreferenceBaseSchema.superRefine(
  (value, context) => {
    if (value.sourceLanguageMode === 'manual' && value.sourceLanguage === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceLanguage'],
        message: 'manual source language requires sourceLanguage',
      });
    }

    if (value.sourceLanguageLocked && value.sourceLanguage === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceLanguage'],
        message: 'a locked source language requires sourceLanguage',
      });
    }
  },
);

/** Caption language remains solely on LanguagePreference.captionLanguage. */
export const CaptionPreferenceSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const AudioModeSchema = z.enum(['translated', 'interpretation', 'original']);

/** Levels are local to the recipient who owns this preference. */
export const AudioPreferenceSchema = z
  .object({
    mode: AudioModeSchema,
    originalAudioLevel: RecipientAudioLevelSchema,
    translatedAudioLevel: RecipientAudioLevelSchema,
  })
  .strict();

export const VoiceModeSchema = z.enum(['standard', 'personal', 'original-only']);
export const StandardVoiceGenderSchema = z.enum(['male', 'female']);

/** Exact §24.3 voice preference shape. */
export const VoicePreferenceSchema = z
  .object({
    mode: VoiceModeSchema,
    standardVoiceGender: StandardVoiceGenderSchema.optional(),
    standardVoiceId: z.string().min(1).optional(),
    voiceProfileId: z.string().min(1).optional(),
    fallbackVoiceId: z.string().min(1).optional(),
  })
  .strict();

export type SourceLanguageMode = z.infer<typeof SourceLanguageModeSchema>;
export type LanguagePreference = z.infer<typeof LanguagePreferenceSchema>;
export type CaptionPreference = z.infer<typeof CaptionPreferenceSchema>;
export type AudioMode = z.infer<typeof AudioModeSchema>;
export type AudioPreference = z.infer<typeof AudioPreferenceSchema>;
export type VoiceMode = z.infer<typeof VoiceModeSchema>;
export type VoicePreference = z.infer<typeof VoicePreferenceSchema>;

export function parseLanguagePreference(raw: unknown): LanguagePreference {
  return LanguagePreferenceSchema.parse(raw);
}
