import { describe, it, expect } from 'vitest';
import { parseMediaStateEvent, safeParseMediaStateEvent } from '../media-state-schema.js';

const validState = {
  eventId: 'demo-event',
  streamStatus: 'live',
  videoSource: 'mock',
  videoTimestampMs: 5000,
  sourceAudioActive: true,
  translatedLanguages: ['fr'],
  connectedListeners: 1,
  createdAt: '2026-07-17T00:00:00.000Z',
};

describe('MediaStateEventSchema validation', () => {
  it('parses a valid media state event', () => {
    const result = parseMediaStateEvent(validState);
    expect(result.streamStatus).toBe('live');
    expect(result.videoSource).toBe('mock');
  });

  it('rejects invalid streamStatus', () => {
    const result = safeParseMediaStateEvent({ ...validState, streamStatus: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid videoSource', () => {
    const result = safeParseMediaStateEvent({ ...validState, videoSource: 'youtube' });
    expect(result.success).toBe(false);
  });

  it('rejects negative connectedListeners', () => {
    const result = safeParseMediaStateEvent({ ...validState, connectedListeners: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts all valid stream statuses', () => {
    for (const status of ['idle', 'connecting', 'live', 'paused', 'ended', 'error']) {
      const result = safeParseMediaStateEvent({ ...validState, streamStatus: status });
      expect(result.success).toBe(true);
    }
  });
});
