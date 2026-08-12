import { describe, expect, it } from 'vitest';
import {
  parseTimestampedTranslationEvent,
  safeParseTimestampedTranslationEvent,
} from '../timestamped-translation-schema.js';

const validEvent = {
  sessionId: 'ps_123',
  streamId: 'stream_123',
  segmentId: 'ps_123:chunk:0',
  sequence: 0,
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  sourceText: 'hello',
  translatedText: '[fr] hello',
  startMs: 0,
  endMs: 15_000,
  status: 'translated',
  latency: {
    queuedMs: 0,
    providerMs: 4,
    totalMs: 4,
  },
  createdAt: '2026-07-27T00:00:00.000Z',
};

describe('TimestampedTranslationEventSchema validation', () => {
  it('parses a valid timestamped translation event', () => {
    const result = parseTimestampedTranslationEvent(validEvent);
    expect(result.status).toBe('translated');
    expect(result.translatedText).toBe('[fr] hello');
  });

  it('preserves the optional sourceLanguageRevision instead of stripping it', () => {
    const result = parseTimestampedTranslationEvent({
      ...validEvent,
      sourceLanguageRevision: 2,
    });

    expect(result.sourceLanguageRevision).toBe(2);
  });

  it('rejects a negative sourceLanguageRevision', () => {
    const result = safeParseTimestampedTranslationEvent({
      ...validEvent,
      sourceLanguageRevision: -1,
    });

    expect(result.success).toBe(false);
  });

  it('accepts empty source and translated text', () => {
    const result = safeParseTimestampedTranslationEvent({
      ...validEvent,
      sourceText: '',
      translatedText: '',
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = safeParseTimestampedTranslationEvent({
      ...validEvent,
      status: 'complete',
    });

    expect(result.success).toBe(false);
  });

  it('rejects negative latency', () => {
    const result = safeParseTimestampedTranslationEvent({
      ...validEvent,
      latency: {
        ...validEvent.latency,
        totalMs: -1,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects timestamps with no positive duration', () => {
    const result = safeParseTimestampedTranslationEvent({
      ...validEvent,
      startMs: 15_000,
      endMs: 15_000,
    });

    expect(result.success).toBe(false);
  });
});
