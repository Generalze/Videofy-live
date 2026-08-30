import { describe, expect, it } from 'vitest';
import { buildAudioMixBroadcast } from './audioMixBroadcast';

const defaults = {
  mode: 'interpretation' as const,
  originalVolume: 0.2,
  translatedVolume: 1,
  subtitlesEnabled: true,
};

describe('buildAudioMixBroadcast', () => {
  it('does not broadcast on connect or reload before any operator interaction', () => {
    expect(
      buildAudioMixBroadcast({
        ...defaults,
        connected: true,
        operatorHasAdjustedMix: false,
      }),
    ).toBeNull();
  });

  it('broadcasts the current preferences after an explicit operator interaction', () => {
    expect(
      buildAudioMixBroadcast({
        connected: true,
        operatorHasAdjustedMix: true,
        mode: 'replacement',
        originalVolume: 0,
        translatedVolume: 0.8,
        subtitlesEnabled: false,
      }),
    ).toEqual({
      mode: 'replacement',
      originalVolume: 0,
      translatedVolume: 0.8,
      subtitlesEnabled: false,
    });
  });

  it('never broadcasts while the gateway socket is disconnected', () => {
    expect(
      buildAudioMixBroadcast({
        ...defaults,
        connected: false,
        operatorHasAdjustedMix: true,
      }),
    ).toBeNull();
  });
});

describe('the original level is its own field', () => {
  /*
   * Founder requirement (Audio & Voices master, 30 Aug 2026): moving the
   * original level 100 -> 50 -> 0 changes what listeners hear without
   * touching translated gain. The wire carries the two as separate fields
   * and the listener applies each only when it changed
   * (listener-web/listenerMixPreferences.ts), so this pins the operator
   * half: every step ships the new original level and the same translated one.
   */
  it('ships 100, 50 and 0 for the original while the translated level stays put', () => {
    const levels = [1, 0.5, 0].map((originalVolume) =>
      buildAudioMixBroadcast({
        connected: true,
        operatorHasAdjustedMix: true,
        mode: 'interpretation',
        originalVolume,
        translatedVolume: 1,
        subtitlesEnabled: true,
      }),
    );
    expect(levels.map((entry) => entry?.originalVolume)).toEqual([1, 0.5, 0]);
    expect(levels.map((entry) => entry?.translatedVolume)).toEqual([1, 1, 1]);
  });
});
