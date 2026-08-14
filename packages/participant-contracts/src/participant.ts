/** @author masterzee001 */
import { z } from 'zod';

import {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  LanguageTagSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
} from './identifiers.js';
import { ParticipantMediaCapabilitiesSchema } from './media.js';
import { AudioModeSchema, SourceLanguageModeSchema, VoiceModeSchema } from './preferences.js';

/**
 * §8.1's core participant shape. `role` is intentionally open: `programme`
 * is a first-class role, while adapters cannot impose platform role enums.
 */
export const ParticipantSchema = z
  .object({
    participantId: ParticipantIdSchema,
    sessionId: CallSessionIdSchema,
    displayName: z.string().min(1),
    role: z.string().min(1),
    sourceLanguage: LanguageTagSchema.nullable(),
    sourceLanguageMode: SourceLanguageModeSchema,
    sourceLanguageLocked: z.boolean(),
    preferredLanguage: LanguageTagSchema,
    captionLanguage: LanguageTagSchema,
    audioMode: AudioModeSchema,
    voiceMode: VoiceModeSchema,
    voiceProfileId: z.string().min(1).optional(),
    connectionCapabilities: ParticipantMediaCapabilitiesSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
  })
  .strict()
  .superRefine((value, context) => {
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
  });

export type Participant = z.infer<typeof ParticipantSchema>;

export function parseParticipant(raw: unknown): Participant {
  return ParticipantSchema.parse(raw);
}
