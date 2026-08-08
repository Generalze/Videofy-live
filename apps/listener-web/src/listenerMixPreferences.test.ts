import { describe, expect, it } from 'vitest';
import type { AudioMixPreferences } from '@videofy-live/shared-types';
import { changedMixPreferences } from './listenerMixPreferences';

const defaults: AudioMixPreferences = {
  mode: 'interpretation',
  originalVolume: 0.2,
  translatedVolume: 1,
  subtitlesEnabled: true,
};

describe('changedMixPreferences', () => {
  it('applies the initial operator preferences', () => {
    expect(changedMixPreferences(null, defaults)).toEqual({
      mode: true,
      originalVolume: true,
      translatedVolume: true,
      subtitlesEnabled: true,
    });
  });

  it('does not overwrite viewer-local controls for a repeated operator event', () => {
    expect(changedMixPreferences(defaults, { ...defaults })).toEqual({
      mode: false,
      originalVolume: false,
      translatedVolume: false,
      subtitlesEnabled: false,
    });
  });

  it('applies only values that the operator actually changed', () => {
    expect(
      changedMixPreferences(defaults, {
        ...defaults,
        originalVolume: 0.45,
      }),
    ).toEqual({
      mode: false,
      originalVolume: true,
      translatedVolume: false,
      subtitlesEnabled: false,
    });
  });
});
