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
