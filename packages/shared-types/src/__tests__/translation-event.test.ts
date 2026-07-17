import { describe, it, expect } from 'vitest';
import type { TranslationEvent, LatencyBreakdown, AudioFormat } from '../translation-event.js';

describe('TranslationEvent type shape', () => {
  it('constructs a valid translation event object', () => {
    const latency: LatencyBreakdown = {
      audioCaptureMs: 50,
      transcriptionMs: 200,
      translationMs: 150,
      speechGenerationMs: 300,
      deliveryMs: 30,
      synchronizationOffsetMs: 4500,
    };

    const event: TranslationEvent = {
      eventId: 'demo-event',
      sequence: 1,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      sourceText: 'Welcome to the programme.',
      translatedText: 'Bienvenue au programme.',
      audioUrl: null,
      audioFormat: null as AudioFormat,
      audioDurationMs: null,
      final: true,
      videoTimestampMs: 5000,
      createdAt: '2026-07-17T00:00:00.000Z',
      latency,
    };

    expect(event.eventId).toBe('demo-event');
    expect(event.sequence).toBe(1);
    expect(event.sourceLanguage).toBe('en');
    expect(event.targetLanguage).toBe('fr');
    expect(event.final).toBe(true);
    expect(event.audioUrl).toBeNull();
    expect(event.audioFormat).toBeNull();
    expect(event.audioDurationMs).toBeNull();
    expect(event.videoTimestampMs).toBe(5000);
    expect(event.latency.audioCaptureMs).toBe(50);
    expect(event.latency.synchronizationOffsetMs).toBe(4500);
  });

  it('allows partial transcriptions (final=false)', () => {
    const event: TranslationEvent = {
      eventId: 'demo-event',
      sequence: 2,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      sourceText: 'Hello',
      translatedText: 'Bonjour',
      audioUrl: null,
      audioFormat: null as AudioFormat,
      audioDurationMs: null,
      final: false,
      videoTimestampMs: 1000,
      createdAt: new Date().toISOString(),
      latency: {
        audioCaptureMs: 0,
        transcriptionMs: 0,
        translationMs: 0,
        speechGenerationMs: 0,
        deliveryMs: 0,
        synchronizationOffsetMs: 0,
      },
    };
    expect(event.final).toBe(false);
  });
});

describe('languageRoom helper', () => {
  it('formats language room names correctly', async () => {
    const { languageRoom } = await import('../socket-events.js');
    expect(languageRoom('fr')).toBe('lang:fr');
    expect(languageRoom('es')).toBe('lang:es');
    expect(languageRoom('zh-TW')).toBe('lang:zh-TW');
  });
});
