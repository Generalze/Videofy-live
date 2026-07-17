import type { TranslationEvent } from '@videofy-live/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';

function makeEvent(
  sequence: number,
  targetLanguage = 'fr',
  eventId = 'demo-event',
): TranslationEvent {
  return {
    eventId,
    sequence,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: 'Hello',
    translatedText: 'Bonjour',
    audioUrl: null,
    audioFormat: null,
    audioDurationMs: null,
    final: true,
    videoTimestampMs: sequence * 1000,
    createdAt: '2026-07-17T08:30:00.000Z',
    latency: {
      audioCaptureMs: 0,
      transcriptionMs: 0,
      translationMs: 0,
      speechGenerationMs: 0,
      deliveryMs: 0,
      synchronizationOffsetMs: 0,
    },
  };
}

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore({ maxGap: 5, maxBufferedEvents: 10 });
  });

  it('delivers 1, 2, 3 immediately in order', () => {
    expect(store.offer(makeEvent(1)).ready.map((event) => event.sequence)).toEqual([1]);
    expect(store.offer(makeEvent(2)).ready.map((event) => event.sequence)).toEqual([2]);
    expect(store.offer(makeEvent(3)).ready.map((event) => event.sequence)).toEqual([3]);
  });

  it('buffers 1, 3, 2 and releases accepted events in sequence order', () => {
    expect(store.offer(makeEvent(1)).ready.map((event) => event.sequence)).toEqual([1]);
    expect(store.offer(makeEvent(3)).ready).toEqual([]);
    expect(store.offer(makeEvent(2)).ready.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it('rejects duplicates', () => {
    expect(store.offer(makeEvent(1)).accepted).toBe(true);
    const duplicate = store.offer(makeEvent(1));
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe('stale');
  });

  it('rejects large stale gaps', () => {
    const result = store.offer(makeEvent(10));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('gap-too-large');
  });

  it('keeps simultaneous French channels for different event IDs independent', () => {
    expect(store.offer(makeEvent(1, 'fr', 'event-a')).ready.map((event) => event.eventId)).toEqual([
      'event-a',
    ]);
    expect(store.offer(makeEvent(1, 'fr', 'event-b')).ready.map((event) => event.eventId)).toEqual([
      'event-b',
    ]);
  });

  it('keeps French and Spanish channels independent', () => {
    expect(store.offer(makeEvent(1, 'fr')).ready.map((event) => event.targetLanguage)).toEqual([
      'fr',
    ]);
    expect(store.offer(makeEvent(1, 'es')).ready.map((event) => event.targetLanguage)).toEqual([
      'es',
    ]);
  });

  it('handles gaps deterministically by buffering within maxGap', () => {
    expect(store.offer(makeEvent(2)).accepted).toBe(true);
    expect(store.getBufferedCount('demo-event', 'fr')).toBe(1);
    expect(store.offer(makeEvent(1)).ready.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('resets a single event-language channel without clearing others', () => {
    store.offer(makeEvent(1, 'fr', 'event-a'));
    store.offer(makeEvent(1, 'es', 'event-a'));
    store.reset('event-a', 'fr');
    expect(store.getNextSequence('event-a', 'fr')).toBe(1);
    expect(store.getNextSequence('event-a', 'es')).toBe(2);
  });
});
