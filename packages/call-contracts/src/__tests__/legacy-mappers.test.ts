/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  mapLegacyGeneratedAudioReadyEvent,
  mapLegacyTimestampedTranslationEvent,
  mapLegacyTranslationEvent,
} from '../index.js';

const context = {
  sessionId: 'call_programme_1',
  participantId: 'programme_participant_1',
  mediaRevision: 4,
  languageRevision: 7,
  provider: 'programme-translation-provider',
};

describe('legacy programme compatibility mappers', () => {
  it('binds legacy translations only to supplied programme context without mutation', () => {
    const legacy = Object.freeze({
      eventId: 'legacy-event-id-not-a-call-id',
      sequence: 8,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceText: '  bytes stay as supplied  ',
      translatedText: '  los bytes se conservan  ',
      audioUrl: null,
      audioFormat: null,
      audioDurationMs: null,
      final: true,
      videoTimestampMs: 500,
      createdAt: '2026-06-01T00:00:00.000Z',
      latency: {
        audioCaptureMs: 0,
        transcriptionMs: 0,
        translationMs: 0,
        speechGenerationMs: 0,
        deliveryMs: 0,
        synchronizationOffsetMs: 0,
      },
    });
    const originalShape = structuredClone(legacy);

    const mapped = mapLegacyTranslationEvent(legacy, context);

    expect(legacy).toEqual(originalShape);
    expect(mapped).toMatchObject({
      sessionId: context.sessionId,
      participantId: context.participantId,
      mediaRevision: context.mediaRevision,
      languageRevision: context.languageRevision,
      provider: context.provider,
      sourceSequence: legacy.sequence,
      translatedText: legacy.translatedText,
    });
    expect(mapped).not.toHaveProperty('eventId');
    expect(mapped).not.toHaveProperty('streamId');
  });

  it('preserves timestamped translated text while ignoring legacy transport/session identifiers', () => {
    const legacy = Object.freeze({
      sessionId: 'legacy-processing-session',
      streamId: 'external-stream-id',
      segmentId: 'external-segment-id',
      sequence: 9,
      sourceLanguage: 'en',
      sourceLanguageRevision: 1,
      targetLanguage: 'fr',
      sourceText: 'hello',
      translatedText: 'bonjour',
      startMs: 0,
      endMs: 1000,
      status: 'translated' as const,
      latency: { queuedMs: 0, providerMs: 1, totalMs: 1 },
      createdAt: '2026-06-01T00:00:01.000Z',
    });
    const originalShape = structuredClone(legacy);

    const mapped = mapLegacyTimestampedTranslationEvent(legacy, context);

    expect(legacy).toEqual(originalShape);
    expect(mapped.sessionId).toBe(context.sessionId);
    expect(mapped.participantId).toBe(context.participantId);
    expect(mapped.translatedText).toBe(legacy.translatedText);
    expect(mapped).not.toHaveProperty('streamId');
    expect(() =>
      mapLegacyTimestampedTranslationEvent({ ...legacy, status: 'queued' }, context),
    ).toThrow('status="translated"');
  });

  it('preserves generated-audio reference and requires explicit provider/revisions/voice mode', () => {
    const legacy = Object.freeze({
      sessionId: 'legacy-processing-session',
      streamId: 'external-stream-id',
      segmentId: 'external-segment-id',
      sequence: 10,
      targetLanguage: 'es',
      translatedText: 'hola',
      startMs: 100,
      endMs: 500,
      voiceId: 'legacy-voice',
      durationMs: 400,
      providerLatencyMs: 12,
      audioUrl: 'https://example.test/opaque%20audio.wav',
      createdAt: '2026-06-01T00:00:02.000Z',
    });
    const originalShape = structuredClone(legacy);
    const mapped = mapLegacyGeneratedAudioReadyEvent(legacy, { ...context, voiceMode: 'standard' });

    expect(legacy).toEqual(originalShape);
    expect(mapped.audioRef).toBe(legacy.audioUrl);
    expect(mapped.durationMs).toBe(legacy.durationMs);
    expect(mapped.provider).toBe(context.provider);
    expect(mapped).not.toHaveProperty('streamId');
    expect(() =>
      mapLegacyTranslationEvent(legacy as never, { ...context, provider: '' }),
    ).toThrow();
    expect(() =>
      mapLegacyGeneratedAudioReadyEvent(legacy, {
        ...context,
        voiceMode: 'original-only',
      } as never),
    ).toThrow();
  });
});
