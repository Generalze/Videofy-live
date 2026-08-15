import { describe, expect, it } from 'vitest';
import { parseTranscriptionEvent, safeParseTranscriptionEvent } from '../transcription-schema.js';

const validEvent = {
  sessionId: 'ps_123',
  streamId: 'stream_123',
  chunkId: 'ps_123:chunk:0',
  sequence: 0,
  sourceText: 'hello',
  detectedLanguage: 'en',
  startMs: 0,
  endMs: 15000,
  confidence: 0.97,
  providerLatencyMs: 123,
  status: 'transcribed',
  createdAt: '2026-07-17T00:00:00.000Z',
};

describe('TranscriptionEventSchema validation', () => {
  it('accepts a valid transcription event', () => {
    expect(safeParseTranscriptionEvent(validEvent).success).toBe(true);
  });

  it('accepts empty speech', () => {
    expect(safeParseTranscriptionEvent({ ...validEvent, sourceText: '' }).success).toBe(true);
  });

  it('accepts all valid transcription statuses', () => {
    for (const status of ['queued', 'transcribing', 'transcribed', 'failed', 'retrying']) {
      expect(safeParseTranscriptionEvent({ ...validEvent, status }).success).toBe(true);
    }
  });

  it('rejects invalid confidence', () => {
    expect(safeParseTranscriptionEvent({ ...validEvent, confidence: 2 }).success).toBe(false);
  });
});

describe('streaming caption flags', () => {
  it('preserves isFinal=false and partialSequence instead of stripping them', () => {
    const result = parseTranscriptionEvent({
      ...validEvent,
      isFinal: false,
      partialSequence: 2,
    });

    expect(result.isFinal).toBe(false);
    expect(result.partialSequence).toBe(2);
  });

  it('treats an event without the flag as final', () => {
    expect(parseTranscriptionEvent(validEvent).isFinal).toBeUndefined();
  });

  it('rejects isFinal=true, since absence is the only way to say final', () => {
    expect(safeParseTranscriptionEvent({ ...validEvent, isFinal: true }).success).toBe(false);
  });
});
