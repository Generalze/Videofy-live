/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  LanguagePreferenceSchema,
  LanguageTagSchema as ParticipantLanguageTagSchema,
} from '@videofy-live/participant-contracts';
import { CaptionEventSchema, LanguageTagSchema as CallLanguageTagSchema } from '../index.js';

describe('canonical language-tag authority', () => {
  it('shares participant-contracts language tags across preferences and call events', () => {
    expect(CallLanguageTagSchema).toBe(ParticipantLanguageTagSchema);
    expect(ParticipantLanguageTagSchema.safeParse('x').success).toBe(true);
    expect(ParticipantLanguageTagSchema.safeParse('x'.repeat(65)).success).toBe(false);

    expect(
      LanguagePreferenceSchema.safeParse({
        sourceLanguage: 'x',
        sourceLanguageMode: 'manual',
        sourceLanguageLocked: true,
        preferredLanguage: 'x',
        captionLanguage: 'x',
        languageRevision: 0,
      }).success,
    ).toBe(true);
    expect(
      CaptionEventSchema.safeParse({
        sessionId: 'call_1',
        speakerParticipantId: 'participant_1',
        sourceRevision: 0,
        languageRevision: 0,
        sequence: 0,
        sourceLanguage: 'x',
        targetLanguage: 'x',
        originalText: 'source',
        translatedText: 'target',
        startTimestamp: 0,
        endTimestamp: 1,
        confidence: 1,
        isFinal: true,
      }).success,
    ).toBe(true);
  });
});
