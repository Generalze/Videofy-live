import { describe, expect, it } from 'vitest';
import {
  INTERPRETATION_ORIGINAL_GAIN,
  anyRemoteTranslationExpected,
  generatedClipEligibility,
  primaryLanguageSubtag,
  resolveCallAudioMix,
  resolveSpeakerAudioMix,
  resolveSpeakerAudioMixes,
  speakerOriginalSuppressed,
  speakerTranslationRequired,
} from './callAudioMix';

/* ============================================================================
 * P6.4-W4 — per speaker/listener pair. The reference topology throughout is
 * the work order's: listener p1 hears French; A=p2 speaks English, B=p3
 * speaks French, C=p4 speaks Spanish.
 * ========================================================================== */

const A = { participantId: 'p2', speakLanguage: 'en' };
const B = { participantId: 'p3', speakLanguage: 'fr' };
const C = { participantId: 'p4', speakLanguage: 'es' };
const SELF = { participantId: 'p1', speakLanguage: 'fr' };

describe('resolveSpeakerAudioMix — the locked pair semantics', () => {
  it('translated + translation required: original 0, generated audible (TTS is the delivery)', () => {
    expect(resolveSpeakerAudioMix({ audioMode: 'translated', translationRequired: true })).toEqual({
      originalGain: 0,
      translatedAudible: true,
    });
  });

  it('translated + same language: original full, no synthetic replacement', () => {
    expect(resolveSpeakerAudioMix({ audioMode: 'translated', translationRequired: false })).toEqual(
      { originalGain: 1, translatedAudible: false },
    );
  });

  it('interpretation + translation required: original underneath at the interpretation level, generated primary', () => {
    expect(
      resolveSpeakerAudioMix({ audioMode: 'interpretation', translationRequired: true }),
    ).toEqual({ originalGain: INTERPRETATION_ORIGINAL_GAIN, translatedAudible: true });
  });

  it('interpretation + same language: full level, no unnecessary ducking', () => {
    expect(
      resolveSpeakerAudioMix({ audioMode: 'interpretation', translationRequired: false }),
    ).toEqual({ originalGain: 1, translatedAudible: false });
  });

  it('original mode: full original and no audible generated speech, for every pair', () => {
    expect(resolveSpeakerAudioMix({ audioMode: 'original', translationRequired: true })).toEqual({
      originalGain: 1,
      translatedAudible: false,
    });
    expect(resolveSpeakerAudioMix({ audioMode: 'original', translationRequired: false })).toEqual({
      originalGain: 1,
      translatedAudible: false,
    });
  });

  it('the interpretation level is the one named development-demo constant', () => {
    // DEVELOPMENT-DEMO MIX VALUE, subject to listening calibration — asserted
    // here so a tuning change is a deliberate one-line diff, never a drive-by.
    expect(INTERPRETATION_ORIGINAL_GAIN).toBe(0.25);
    expect(INTERPRETATION_ORIGINAL_GAIN).toBeGreaterThan(0);
    expect(INTERPRETATION_ORIGINAL_GAIN).toBeLessThan(1);
  });
});

describe('speakerTranslationRequired — derived per pair from language state', () => {
  it('compares by primary subtag, so regional variants are the same language', () => {
    expect(speakerTranslationRequired('en', 'fr')).toBe(true);
    expect(speakerTranslationRequired('fr', 'fr')).toBe(false);
    expect(speakerTranslationRequired('fr-CA', 'fr')).toBe(false);
    expect(speakerTranslationRequired(' EN-us ', 'en')).toBe(false);
  });

  it('treats an unknown speaker language as NOT requiring translation', () => {
    // Guessing "required" on missing data silences a real voice; guessing
    // "not required" leaves an original audible alongside captions. Only one
    // of those failures is silent.
    expect(speakerTranslationRequired(undefined, 'fr')).toBe(false);
  });
});

describe('W4 conference matrix — listener hears fr; A=en, B=fr, C=es', () => {
  const gains = (audioMode: 'translated' | 'interpretation' | 'original') => {
    const decisions = resolveSpeakerAudioMixes([SELF, A, B, C], 'p1', 'fr', audioMode);
    return {
      a: decisions.get('p2')!,
      b: decisions.get('p3')!,
      c: decisions.get('p4')!,
    };
  };

  it('TRANSLATED: A 0, B 1, C 0; A/C generated eligible, B not required', () => {
    const { a, b, c } = gains('translated');
    expect(a).toEqual({ originalGain: 0, translatedAudible: true });
    expect(b).toEqual({ originalGain: 1, translatedAudible: false });
    expect(c).toEqual({ originalGain: 0, translatedAudible: true });
  });

  it('INTERPRETATION: A and C at the interpretation gain SIMULTANEOUSLY, B untouched at 1', () => {
    const { a, b, c } = gains('interpretation');
    expect(a).toEqual({ originalGain: INTERPRETATION_ORIGINAL_GAIN, translatedAudible: true });
    expect(b).toEqual({ originalGain: 1, translatedAudible: false });
    expect(c).toEqual({ originalGain: INTERPRETATION_ORIGINAL_GAIN, translatedAudible: true });
  });

  it('ORIGINAL: A 1, B 1, C 1; no generated clip audible for anyone', () => {
    const { a, b, c } = gains('original');
    expect(a).toEqual({ originalGain: 1, translatedAudible: false });
    expect(b).toEqual({ originalGain: 1, translatedAudible: false });
    expect(c).toEqual({ originalGain: 1, translatedAudible: false });
  });

  it('N=3 subset (listener + A + B) decides each pair identically — C absent changes nothing for A or B', () => {
    for (const mode of ['translated', 'interpretation', 'original'] as const) {
      const withC = resolveSpeakerAudioMixes([SELF, A, B, C], 'p1', 'fr', mode);
      const withoutC = resolveSpeakerAudioMixes([SELF, A, B], 'p1', 'fr', mode);
      expect(withoutC.get('p2')).toEqual(withC.get('p2'));
      expect(withoutC.get('p3')).toEqual(withC.get('p3'));
      expect(withoutC.has('p4')).toBe(false);
    }
  });

  it('never returns a decision for self, and never one global decision', () => {
    const decisions = resolveSpeakerAudioMixes([SELF, A, B, C], 'p1', 'fr', 'translated');
    expect(decisions.has('p1')).toBe(false);
    expect(decisions.size).toBe(3);
  });

  it('a hear-language change recalculates ONLY the affected relationships', () => {
    // Listener switches fr → es: A (en) stays a translation pair with the same
    // verdict; B (fr) becomes one; C (es) stops being one.
    const before = resolveSpeakerAudioMixes([SELF, A, B, C], 'p1', 'fr', 'translated');
    const after = resolveSpeakerAudioMixes([SELF, A, B, C], 'p1', 'es', 'translated');

    expect(after.get('p2')).toEqual(before.get('p2'));
    expect(before.get('p3')).toEqual({ originalGain: 1, translatedAudible: false });
    expect(after.get('p3')).toEqual({ originalGain: 0, translatedAudible: true });
    expect(before.get('p4')).toEqual({ originalGain: 0, translatedAudible: true });
    expect(after.get('p4')).toEqual({ originalGain: 1, translatedAudible: false });
  });

  it('two-party parity: N=2 is just the conference rules at conference size 2', () => {
    // Cross-language pair: exactly the two-party translated-call behaviour.
    const cross = resolveSpeakerAudioMixes([SELF, A], 'p1', 'fr', 'translated');
    expect(cross.get('p2')).toEqual({ originalGain: 0, translatedAudible: true });
    // Same-language pair: the original IS the delivery, in every mode.
    for (const mode of ['translated', 'interpretation', 'original'] as const) {
      const same = resolveSpeakerAudioMixes([SELF, B], 'p1', 'fr', mode);
      expect(same.get('p3')).toEqual({ originalGain: 1, translatedAudible: false });
    }
  });
});

describe('generatedClipEligibility — synthetic audio never plays on a guess', () => {
  const required = resolveSpeakerAudioMix({ audioMode: 'translated', translationRequired: true });
  const notRequired = resolveSpeakerAudioMix({
    audioMode: 'translated',
    translationRequired: false,
  });

  it('a known pair requiring generated delivery is eligible', () => {
    expect(generatedClipEligibility(required, true)).toBe('eligible');
  });

  it('a known pair NOT requiring generated delivery is rejected', () => {
    // Correct planning outcome, not an anomaly: the original carries them.
    expect(generatedClipEligibility(notRequired, true)).toBe('ineligible');
  });

  it('an unresolved speaker fails CLOSED — never the mode-level guess', () => {
    // Original audio fails open on unknown language; generated audio fails
    // closed on unknown identity. The two directions are deliberately
    // asymmetric: silence loses a person, a wrong synthetic voice misleads.
    expect(generatedClipEligibility(undefined, true)).toBe('unresolved-speaker');
  });

  it('generated playback disabled beats everything, known or not', () => {
    expect(generatedClipEligibility(required, false)).toBe('ineligible');
    expect(generatedClipEligibility(undefined, false)).toBe('ineligible');
  });
});

describe('speakerOriginalSuppressed — W3.1 compatibility over the W4 resolver', () => {
  it('silences a cross-language speaker in translated mode: their delivery is TTS', () => {
    expect(speakerOriginalSuppressed('translated', 'fr', 'en')).toBe(true);
  });

  it('keeps a same-language speaker audible: their original IS the delivery', () => {
    expect(speakerOriginalSuppressed('translated', 'en', 'en')).toBe(false);
    expect(speakerOriginalSuppressed('translated', 'en-US', 'en')).toBe(false);
  });

  it('interpretation is reduction, not suppression; original mode suppresses nothing', () => {
    expect(speakerOriginalSuppressed('interpretation', 'fr', 'en')).toBe(false);
    expect(speakerOriginalSuppressed('original', 'fr', 'en')).toBe(false);
  });

  it('does not suppress a speaker whose language is unknown', () => {
    expect(speakerOriginalSuppressed('translated', undefined, 'en')).toBe(false);
  });
});

describe('resolveCallAudioMix — listener-level levels only', () => {
  it('original mode plays the real voice at the slider level with no generated audio', () => {
    expect(
      resolveCallAudioMix({ audioMode: 'original', originalVolume: 0.8, translatedVolume: 0.9 }),
    ).toEqual({ originalVolume: 0.8, translatedVolume: 0, playGenerated: false });
  });

  it('translated mode pins the master original level to 1: the slider is disabled there, and a stale value must not scale same-language delivery', () => {
    expect(
      resolveCallAudioMix({ audioMode: 'translated', originalVolume: 0.3, translatedVolume: 0.7 }),
    ).toEqual({ originalVolume: 1, translatedVolume: 0.7, playGenerated: true });
  });

  it('interpretation mode passes the slider through as a plain listening level — the duck is per-speaker policy now', () => {
    expect(
      resolveCallAudioMix({
        audioMode: 'interpretation',
        originalVolume: 0.8,
        translatedVolume: 0.6,
      }),
    ).toEqual({ originalVolume: 0.8, translatedVolume: 0.6, playGenerated: true });
  });

  it('disables generated playback when no remote pair needs translation', () => {
    expect(
      resolveCallAudioMix({
        audioMode: 'translated',
        originalVolume: 0.9,
        translatedVolume: 1,
        remoteTranslationExpected: false,
      }),
    ).toEqual({ originalVolume: 1, translatedVolume: 0, playGenerated: false });
  });

  it('clamps slider values into the 0..1 range', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'interpretation',
      originalVolume: 4,
      translatedVolume: -2,
    });

    expect(decision.originalVolume).toBe(1);
    expect(decision.translatedVolume).toBe(0);
  });

  it('treats non-finite slider values as silent', () => {
    const decision = resolveCallAudioMix({
      audioMode: 'interpretation',
      originalVolume: Number.NaN,
      translatedVolume: Number.POSITIVE_INFINITY,
    });

    expect(decision.originalVolume).toBe(0);
    expect(decision.translatedVolume).toBe(0);
  });

  it('compares languages by primary subtag', () => {
    expect(primaryLanguageSubtag(' EN-us ')).toBe('en');
    expect(primaryLanguageSubtag('fr')).toBe('fr');
  });
});

describe('anyRemoteTranslationExpected — no more "first other participant"', () => {
  const p = (participantId: string, speakLanguage: string) => ({ participantId, speakLanguage });

  it('is true when ANY remote speaks another language, wherever they sort', () => {
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
