import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGINAL_DUCK_LEVEL,
  anyRemoteTranslationExpected,
  speakerOriginalSuppressed,
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

describe('speakerOriginalSuppressed — suppression is a property of the pair', () => {
  it('silences a cross-language speaker in translated mode: their delivery is TTS', () => {
    expect(speakerOriginalSuppressed('translated', 'fr', 'en')).toBe(true);
  });

  it('keeps a same-language speaker audible: their original IS the delivery', () => {
    // The blanket master-0 got this wrong — it silenced the one voice nothing
    // else carried, which is how a listener lost a speaker entirely.
    expect(speakerOriginalSuppressed('translated', 'en', 'en')).toBe(false);
    expect(speakerOriginalSuppressed('translated', 'en-US', 'en')).toBe(false);
  });

  it('never suppresses outside translated mode — ducking is W4 policy, not this rule', () => {
    expect(speakerOriginalSuppressed('interpretation', 'fr', 'en')).toBe(false);
    expect(speakerOriginalSuppressed('original', 'fr', 'en')).toBe(false);
  });

  it('does not suppress a speaker whose language is unknown', () => {
    // Unknown is not evidence of cross-language; silencing on a guess is the
    // fail-open direction here because the cost of wrongly silencing a person
    // is losing them entirely.
    expect(speakerOriginalSuppressed('translated', undefined, 'en')).toBe(false);
  });
});

describe('anyRemoteTranslationExpected — no more "first other participant"', () => {
  const p = (participantId: string, speakLanguage: string) => ({ participantId, speakLanguage });

  it('is true when ANY remote speaks another language, wherever they sort', () => {
    // The two-party residue consulted participants.find(!== self): at N>2 the
    // whole mix keyed off whoever happened to be first.
    expect(
      anyRemoteTranslationExpected([p('p1', 'en'), p('p2', 'en'), p('p3', 'fr')], 'p1', 'en'),
    ).toBe(true);
  });

  it('is false when every remote already speaks the hear language', () => {
    expect(
      anyRemoteTranslationExpected([p('p1', 'en'), p('p2', 'en'), p('p3', 'en')], 'p1', 'en'),
    ).toBe(false);
  });

  it('ignores self entirely', () => {
    expect(anyRemoteTranslationExpected([p('p1', 'fr'), p('p2', 'en')], 'p1', 'en')).toBe(false);
  });

  it('assumes a translation pair while alone, matching the historical default', () => {
    expect(anyRemoteTranslationExpected([p('p1', 'en')], 'p1', 'en')).toBe(true);
  });
});
