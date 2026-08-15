import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGINAL_DUCK_LEVEL,
  primaryLanguageSubtag,
  defaultOriginalVolumeForMode,
  resolveCallAudioMix,
} from './callAudioMix';

describe('resolveCallAudioMix', () => {
  it('original mode plays the real voice at the slider level with no generated audio', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'original',
      originalVolume: 0.8,
      translatedVolume: 0.9,
      translatedSpeechActive: true,
    });

    expect(decision).toEqual({ originalVolume: 0.8, translatedVolume: 0, playGenerated: false });
  });

  it('translated mode fully suppresses the original even while translation is silent', () => {
    const idle = resolveCallAudioMix({
      audioMode: 'translated',
      originalVolume: 0.8,
      translatedVolume: 0.7,
      translatedSpeechActive: false,
    });
    const speaking = resolveCallAudioMix({
      audioMode: 'translated',
      originalVolume: 0.8,
      translatedVolume: 0.7,
      translatedSpeechActive: true,
    });

    expect(idle).toEqual({ originalVolume: 0, translatedVolume: 0.7, playGenerated: true });
    expect(speaking).toEqual({ originalVolume: 0, translatedVolume: 0.7, playGenerated: true });
  });

  it('interpretation mode keeps the original at full level while translation is silent', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'interpretation',
      originalVolume: 0.2,
      translatedVolume: 1,
      translatedSpeechActive: false,
    });

    expect(decision.originalVolume).toBe(1);
    expect(decision.playGenerated).toBe(true);
  });

  it('interpretation mode ducks the original to the slider level while translation plays', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'interpretation',
      originalVolume: 0.25,
      translatedVolume: 0.6,
      translatedSpeechActive: true,
    });

    expect(decision).toEqual({ originalVolume: 0.25, translatedVolume: 0.6, playGenerated: true });
  });

  it('clamps slider values into the 0..1 range', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'interpretation',
      originalVolume: 4,
      translatedVolume: -2,
      translatedSpeechActive: true,
    });

    expect(decision.originalVolume).toBe(1);
    expect(decision.translatedVolume).toBe(0);
  });

  it('treats non-finite slider values as silent', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'translated',
      originalVolume: Number.NaN,
      translatedVolume: Number.POSITIVE_INFINITY,
      translatedSpeechActive: false,
    });

    expect(decision.translatedVolume).toBe(0);
  });
});

describe('defaultOriginalVolumeForMode', () => {
  it('seeds interpretation with the duck level and other modes with full volume', () => {
    expect(defaultOriginalVolumeForMode('interpretation')).toBe(DEFAULT_ORIGINAL_DUCK_LEVEL);
    expect(defaultOriginalVolumeForMode('translated')).toBe(1);
    expect(defaultOriginalVolumeForMode('original')).toBe(1);
  });
});

describe('same-language direction (no translation will arrive)', () => {
  it('plays the original voice instead of replacement silence in translated mode', () => {
    expect(
      resolveCallAudioMix({
        audioMode: 'translated',
        originalVolume: 0.9,
        translatedVolume: 1,
        translatedSpeechActive: false,
        remoteTranslationExpected: false,
      }),
    ).toEqual({ originalVolume: 0.9, translatedVolume: 0, playGenerated: false });
  });

  it('keeps translation-pair replacement behavior when the flag is omitted', () => {
    expect(
      resolveCallAudioMix({
        audioMode: 'translated',
        originalVolume: 0.9,
        translatedVolume: 1,
        translatedSpeechActive: false,
      }),
    ).toEqual({ originalVolume: 0, translatedVolume: 1, playGenerated: true });
  });

  it('compares languages by primary subtag', () => {
    expect(primaryLanguageSubtag(' EN-us ')).toBe('en');
    expect(primaryLanguageSubtag('fr')).toBe('fr');
  });
});
