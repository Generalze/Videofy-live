/** @owner masterzee001 */

/** Abstract legacy delivery target. Socket rooms and event names remain at the gateway boundary. */
export type LegacyProgrammeAudience =
  { readonly kind: 'operator' } | { readonly kind: 'language'; readonly language: string };

export interface LegacyTranslationEventLike {
  readonly targetLanguage: string;
}

export interface LegacyTimestampedTranslationEventLike extends LegacyTranslationEventLike {
  readonly status: string;
}

export interface LegacyGeneratedAudioReadyEventLike {
  readonly targetLanguage: string;
}

export type LegacyProgrammeEventKind =
  'translation' | 'timestamped-translation' | 'generated-audio-ready';

export type LegacyProgrammeEvent =
  | { readonly kind: 'translation'; readonly event: LegacyTranslationEventLike }
  | {
      readonly kind: 'timestamped-translation';
      readonly event: LegacyTimestampedTranslationEventLike;
    }
  | { readonly kind: 'generated-audio-ready'; readonly event: LegacyGeneratedAudioReadyEventLike };

const OPERATOR_AUDIENCE: LegacyProgrammeAudience = { kind: 'operator' };
const ORIGINAL_LANGUAGE = 'original';

/**
 * Preserves the programme gateway's legacy audience rules without importing
 * Socket.IO, room names, event constants or legacy event types.
 */
export function selectLegacyProgrammeAudiences(
  input: LegacyProgrammeEvent,
): LegacyProgrammeAudience[] {
  switch (input.kind) {
    case 'translation':
      return [{ kind: 'language', language: input.event.targetLanguage }, OPERATOR_AUDIENCE];
    case 'timestamped-translation':
      return input.event.status === 'translated'
        ? [
            OPERATOR_AUDIENCE,
            { kind: 'language', language: input.event.targetLanguage },
            { kind: 'language', language: ORIGINAL_LANGUAGE },
          ]
        : [OPERATOR_AUDIENCE];
    case 'generated-audio-ready':
      return [{ kind: 'language', language: input.event.targetLanguage }, OPERATOR_AUDIENCE];
  }
}
