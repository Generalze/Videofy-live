import { beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';

function makeEvent(sequence: number, targetLanguage = 'fr') {
  return {
    eventId: 'demo-event',
    sequence,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: 'Hello',
    translatedText: 'Bonjour',
    audioUrl: null,
    audioFormat: null as null,
    audioDurationMs: null,
    final: true,
    videoTimestampMs: sequence * 1000,
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
}

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
  });

  it('accepts a new event', () => {
    expect(store.accept(makeEvent(1))).toBe(true);
  });

  it('rejects a duplicate sequence', () => {
    store.accept(makeEvent(1));
    expect(store.accept(makeEvent(1))).toBe(false);
  });

  it('accepts events in order', () => {
    expect(store.accept(makeEvent(1))).toBe(true);
    expect(store.accept(makeEvent(2))).toBe(true);
    expect(store.accept(makeEvent(3))).toBe(true);
  });

  it('accepts out-of-order events within threshold', () => {
    store.accept(makeEvent(10));
    expect(store.accept(makeEvent(5))).toBe(true);
  });

  it('rejects events beyond the stale threshold', () => {
    store.accept(makeEvent(100));
    expect(store.accept(makeEvent(1))).toBe(false);
  });

  it('tracks last sequence per language', () => {
    store.accept(makeEvent(1, 'fr'));
    store.accept(makeEvent(3, 'fr'));
    store.accept(makeEvent(2, 'es'));
    expect(store.getLastSequence('fr')).toBe(3);
    expect(store.getLastSequence('es')).toBe(2);
    expect(store.getLastSequence('de')).toBe(0);
  });

  it('tracks duplicates independently per language', () => {
    store.accept(makeEvent(1, 'fr'));
    expect(store.accept(makeEvent(1, 'es'))).toBe(true);
    expect(store.accept(makeEvent(1, 'fr'))).toBe(false);
  });

  it('resets cleanly', () => {
    store.accept(makeEvent(5));
    store.reset();
    expect(store.accept(makeEvent(5))).toBe(true);
  });
});
