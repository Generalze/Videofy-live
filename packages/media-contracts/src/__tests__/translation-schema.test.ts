import { describe, it, expect } from 'vitest';
import {
  parseTranslationEvent,
  safeParseTranslationEvent,
  TranslationEventSchema,
} from '../translation-schema.js';

const validEvent = {
  eventId: 'demo-event',
  sequence: 1,
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  sourceText: 'Welcome to the programme.',
  translatedText: 'Bienvenue au programme.',
  audioUrl: null,
  audioFormat: null,
  audioDurationMs: null,
  final: true,
  videoTimestampMs: 5000,
  createdAt: '2026-07-17T00:00:00.000Z',
  latency: {
    audioCaptureMs: 0,
    transcriptionMs: 0,
    translationMs: 0,
    speechGenerationMs: 0,
    deliveryMs: 0,
    synchronizationOffsetMs: 0,
  },
};

describe('TranslationEventSchema validation', () => {
  it('parses a valid event without error', () => {
    const result = parseTranslationEvent(validEvent);
    expect(result.eventId).toBe('demo-event');
    expect(result.sequence).toBe(1);
    expect(result.final).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { eventId: _eventId, ...withoutEventId } = validEvent;
    const result = safeParseTranslationEvent(withoutEventId);
    expect(result.success).toBe(false);
  });

  it('rejects sequence numbers below 1', () => {
    const result = safeParseTranslationEvent({ ...validEvent, sequence: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative videoTimestampMs', () => {
    const result = safeParseTranslationEvent({ ...validEvent, videoTimestampMs: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid audioFormat', () => {
    const result = safeParseTranslationEvent({ ...validEvent, audioFormat: 'flac' });
    expect(result.success).toBe(false);
  });

  it('accepts valid audio formats', () => {
    for (const fmt of ['mp3', 'ogg', 'wav', 'webm']) {
      const result = safeParseTranslationEvent({
        ...validEvent,
        audioUrl: 'https://example.com/audio.mp3',
        audioFormat: fmt,
        audioDurationMs: 3000,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid ISO-8601 createdAt', () => {
    const result = safeParseTranslationEvent({ ...validEvent, createdAt: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('accepts Python UTC Z timestamps with millisecond precision', () => {
    const result = safeParseTranslationEvent({
      ...validEvent,
      createdAt: '2026-07-17T08:30:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative latency values', () => {
    const result = safeParseTranslationEvent({
      ...validEvent,
      latency: { ...validEvent.latency, audioCaptureMs: -1 },
    });
    expect(result.success).toBe(false);
  });
});
