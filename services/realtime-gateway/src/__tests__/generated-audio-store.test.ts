import type { GeneratedAudioReadyEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { GeneratedAudioStore } from '../generated-audio-store.js';

describe('GeneratedAudioStore', () => {
  it('retains independent language snapshots for viewers that switch after delivery', () => {
    const store = new GeneratedAudioStore();

    expect(store.offer(event(0, 'es')).ready).toHaveLength(1);
    expect(store.offer(event(0, 'fr')).ready).toHaveLength(1);
    expect(store.offer(event(1, 'es')).ready).toHaveLength(1);

    expect(store.getSnapshot('ps_multi', 'es').map((item) => item.sequence)).toEqual([0, 1]);
    expect(store.getSnapshot('ps_multi', 'fr').map((item) => item.sequence)).toEqual([0]);
    expect(store.getSnapshot('ps_multi', 'yo')).toEqual([]);
  });

  it('caps retained history to the configured maximum of most recent events', () => {
    const store = new GeneratedAudioStore(20, 3);

    for (let sequence = 0; sequence < 6; sequence++) {
      expect(store.offer(event(sequence, 'es')).ready).toHaveLength(1);
    }

    expect(store.getSnapshot('ps_multi', 'es').map((item) => item.sequence)).toEqual([3, 4, 5]);
  });

  it('clears every language channel of a session on resetSession without touching other sessions', () => {
    const store = new GeneratedAudioStore();
    store.offer(event(0, 'es'));
    store.offer(event(0, 'fr'));
    store.offer({ ...event(0, 'es'), sessionId: 'ps_other' });

    store.resetSession('ps_multi');

    expect(store.getSnapshot('ps_multi', 'es')).toEqual([]);
    expect(store.getSnapshot('ps_multi', 'fr')).toEqual([]);
    expect(store.getSnapshot('ps_other', 'es')).toHaveLength(1);
    // Channel sequencing restarts cleanly after the session reset.
    expect(store.offer(event(0, 'es'))).toMatchObject({ accepted: true });
  });

  it('does not duplicate retained output and clears only the requested channel', () => {
    const store = new GeneratedAudioStore();
    store.offer(event(0, 'es'));
    expect(store.offer(event(0, 'es'))).toMatchObject({ accepted: false, reason: 'stale' });

    store.reset('ps_multi', 'es');

    expect(store.getSnapshot('ps_multi', 'es')).toEqual([]);
  });
});

function event(sequence: number, targetLanguage: string): GeneratedAudioReadyEvent {
  return {
    sessionId: 'ps_multi',
    streamId: 'stream_multi',
    segmentId: `chunk-${sequence}`,
    sequence,
    targetLanguage,
    translatedText: `${targetLanguage}:${sequence}`,
    startMs: sequence * 1000,
    endMs: sequence * 1000 + 900,
    voiceId: `${targetLanguage}-voice`,
    durationMs: 900,
    providerLatencyMs: 5,
    audioUrl: `http://localhost/${targetLanguage}/${sequence}.wav`,
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}
