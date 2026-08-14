/** @owner masterzee001 */
import { z } from 'zod';
import {
  CallSessionIdSchema,
  EventSequenceSchema,
  LanguageRevisionSchema,
  LanguageTagSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
  ProviderIdSchema,
  TimestampMsSchema,
} from './primitives.js';

const RevisionedSpeakerEventSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    participantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
  })
  .strict();

/** Caption contract from architecture section 12. */
export const CaptionEventSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    speakerParticipantId: ParticipantIdSchema,
    sourceRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    sequence: EventSequenceSchema,
    sourceLanguage: LanguageTagSchema,
    targetLanguage: LanguageTagSchema,
    originalText: z.string(),
    translatedText: z.string(),
    startTimestamp: TimestampMsSchema,
    endTimestamp: TimestampMsSchema,
    confidence: z.number().min(0).max(1),
    isFinal: z.boolean(),
  })
  .strict()
  .refine((event) => event.endTimestamp > event.startTimestamp, {
    message: 'endTimestamp must be greater than startTimestamp',
    path: ['endTimestamp'],
  });

/**
 * Collision-safe replacement for the legacy shared-types TranslationEvent.
 * Its name and provenance make it a routed call/programme output, not a legacy
 * stream event.
 */
export const RoutedTranslationEventSchema = RevisionedSpeakerEventSchema.extend({
  sourceSequence: EventSequenceSchema,
  targetLanguage: LanguageTagSchema,
  translatedText: z.string().min(1),
  provider: ProviderIdSchema,
  createdAtMs: TimestampMsSchema,
}).strict();

export const GeneratedVoiceEventSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    speakerParticipantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    sourceSequence: EventSequenceSchema,
    targetLanguage: LanguageTagSchema,
    voiceMode: z.enum(['standard', 'personal']),
    voiceId: z.string().min(1).max(256),
    audioRef: z.string().min(1),
    startTimestampMs: TimestampMsSchema,
    durationMs: z.number().int().nonnegative(),
    provider: ProviderIdSchema,
    createdAtMs: TimestampMsSchema,
  })
  .strict();

export type CaptionEvent = z.infer<typeof CaptionEventSchema>;
export type RoutedTranslationEvent = z.infer<typeof RoutedTranslationEventSchema>;
export type GeneratedVoiceEvent = z.infer<typeof GeneratedVoiceEventSchema>;

export function parseCaptionEvent(raw: unknown): CaptionEvent {
  return CaptionEventSchema.parse(raw);
}

export function parseRoutedTranslationEvent(raw: unknown): RoutedTranslationEvent {
  return RoutedTranslationEventSchema.parse(raw);
}

export function parseGeneratedVoiceEvent(raw: unknown): GeneratedVoiceEvent {
  return GeneratedVoiceEventSchema.parse(raw);
}
