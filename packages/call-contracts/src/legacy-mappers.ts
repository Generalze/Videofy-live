/** @owner masterzee001 */
import type {
  GeneratedAudioReadyEvent,
  TimestampedTranslationEvent,
  TranslationEvent,
} from '@videofy-live/shared-types';
import { z } from 'zod';
import { GeneratedVoiceEventSchema, RoutedTranslationEventSchema } from './events.js';
import {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
  ProviderIdSchema,
} from './primitives.js';
import type { GeneratedVoiceEvent, RoutedTranslationEvent } from './events.js';

/**
 * The caller must bind a legacy programme event to its current canonical context.
 * This prevents stream, event, platform, or transport identifiers becoming call IDs.
 */
export const LegacyProgrammeContextSchema = z
  .object({
    sessionId: CallSessionIdSchema,
    participantId: ParticipantIdSchema,
    mediaRevision: MediaRevisionSchema,
    languageRevision: LanguageRevisionSchema,
    provider: ProviderIdSchema,
  })
  .strict();

export const LegacyGeneratedAudioProgrammeContextSchema = LegacyProgrammeContextSchema.extend({
  voiceMode: z.enum(['standard', 'personal']),
}).strict();

export type LegacyProgrammeContext = z.infer<typeof LegacyProgrammeContextSchema>;
export type LegacyProgrammeContextInput = z.input<typeof LegacyProgrammeContextSchema>;
export type LegacyGeneratedAudioProgrammeContext = z.infer<
  typeof LegacyGeneratedAudioProgrammeContextSchema
>;
export type LegacyGeneratedAudioProgrammeContextInput = z.input<
  typeof LegacyGeneratedAudioProgrammeContextSchema
>;

function parseCreatedAtMs(createdAt: string): number {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs < 0) {
    throw new TypeError(
      'Legacy event createdAt must be a valid timestamp on or after the Unix epoch',
    );
  }
  return createdAtMs;
}

/** Maps a legacy TranslationEvent without changing or reusing its eventId as a session identity. */
export function mapLegacyTranslationEvent(
  event: TranslationEvent,
  context: LegacyProgrammeContextInput,
): RoutedTranslationEvent {
  const binding = LegacyProgrammeContextSchema.parse(context);
  return RoutedTranslationEventSchema.parse({
    sessionId: binding.sessionId,
    participantId: binding.participantId,
    mediaRevision: binding.mediaRevision,
    languageRevision: binding.languageRevision,
    sourceSequence: event.sequence,
    targetLanguage: event.targetLanguage,
    translatedText: event.translatedText,
    provider: binding.provider,
    createdAtMs: parseCreatedAtMs(event.createdAt),
  });
}

/** Maps a timestamped legacy programme translation at the explicit programme boundary. */
export function mapLegacyTimestampedTranslationEvent(
  event: TimestampedTranslationEvent,
  context: LegacyProgrammeContextInput,
): RoutedTranslationEvent {
  if (event.status !== 'translated') {
    throw new TypeError(
      'Only legacy TimestampedTranslationEvent values with status="translated" can be routed',
    );
  }
  const binding = LegacyProgrammeContextSchema.parse(context);
  return RoutedTranslationEventSchema.parse({
    sessionId: binding.sessionId,
    participantId: binding.participantId,
    mediaRevision: binding.mediaRevision,
    languageRevision: binding.languageRevision,
    sourceSequence: event.sequence,
    targetLanguage: event.targetLanguage,
    translatedText: event.translatedText,
    provider: binding.provider,
    createdAtMs: parseCreatedAtMs(event.createdAt),
  });
}

/** Maps generated programme audio only with an explicit canonical context and voice mode. */
export function mapLegacyGeneratedAudioReadyEvent(
  event: GeneratedAudioReadyEvent,
  context: LegacyGeneratedAudioProgrammeContextInput,
): GeneratedVoiceEvent {
  const binding = LegacyGeneratedAudioProgrammeContextSchema.parse(context);
  return GeneratedVoiceEventSchema.parse({
    sessionId: binding.sessionId,
    speakerParticipantId: binding.participantId,
    mediaRevision: binding.mediaRevision,
    languageRevision: binding.languageRevision,
    sourceSequence: event.sequence,
    targetLanguage: event.targetLanguage,
    voiceMode: binding.voiceMode,
    voiceId: event.voiceId,
    audioRef: event.audioUrl,
    startTimestampMs: event.startMs,
    durationMs: event.durationMs,
    provider: binding.provider,
    createdAtMs: parseCreatedAtMs(event.createdAt),
  });
}
