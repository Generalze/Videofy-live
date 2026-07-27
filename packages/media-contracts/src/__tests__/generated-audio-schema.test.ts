import { describe, expect, it } from 'vitest';
import { safeParseGeneratedAudioReadyEvent } from '../generated-audio-schema.js';

const validEvent = {
  sessionId: 'ps_delivery',
  streamId: 'stream_delivery',
  segmentId: 'ps_delivery:chunk:0',
  sequence: 0,
  targetLanguage: 'es',
  translatedText: 'hola',
  startMs: 0,
  endMs: 1200,
  voiceId: 'es-test',
  durationMs: 1000,
  providerLatencyMs: 42,
  audioUrl:
    'http://localhost:3002/sessions/ps_delivery/generated-audio/segments/ps_delivery%3Achunk%3A0/audio',
  createdAt: '2026-07-27T00:00:00.000Z',
};

describe('GeneratedAudioReadyEventSchema', () => {
  it('accepts complete generated-audio delivery metadata', () => {
    const result = safeParseGeneratedAudioReadyEvent(validEvent);

    expect(result.success).toBe(true);
  });

  it('rejects invalid timestamps and non-URL audio locations', () => {
    expect(
      safeParseGeneratedAudioReadyEvent({
        ...validEvent,
        endMs: 0,
      }).success,
    ).toBe(false);

    expect(
      safeParseGeneratedAudioReadyEvent({
        ...validEvent,
        audioUrl: 'C:/uploads/audio.wav',
      }).success,
    ).toBe(false);
  });
});
