/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';

import { resolveLegacyProgrammeListenerOutputPolicy } from './legacy-programme-listener-output-policy.js';

const base = {
  sourceLanguage: 'en',
  selectedLanguage: 'es',
  subtitlesEnabled: true,
  mix: { mode: 'interpretation' as const, originalVolume: 0.2, translatedVolume: 1 },
  originalMediaAvailable: true,
  originalCaptionsAvailable: false,
};

describe('resolveLegacyProgrammeListenerOutputPolicy', () => {
  it('preserves original-channel output', () => {
    expect(
      resolveLegacyProgrammeListenerOutputPolicy({ ...base, selectedLanguage: 'original' }),
    ).toMatchObject({
      fallbackPath: 'same-language-original',
      originalAudioRequired: true,
      expectsGeneratedAudio: false,
    });
  });

  it('preserves captions-only and preparing fallback to original audio', () => {
    expect(
      resolveLegacyProgrammeListenerOutputPolicy({
        ...base,
        capability: { voiceAvailable: false, textOnly: true, voiceId: null },
        output: { captionsAvailable: true, audioAvailable: false },
      }),
    ).toMatchObject({
      fallbackPath: 'translated-text',
      originalAudioRequired: true,
      expectsGeneratedAudio: false,
    });
  });

  it('expects generated audio only for a ready, identified standard voice', () => {
    expect(
      resolveLegacyProgrammeListenerOutputPolicy({
        ...base,
        capability: { voiceAvailable: true, textOnly: false, voiceId: 'voice-es' },
        output: { captionsAvailable: true, audioAvailable: true },
        deliveredGeneratedAudio: { voiceId: 'voice-es' },
      }),
    ).toMatchObject({
      fallbackPath: 'standard',
      originalAudioRequired: false,
      expectsGeneratedAudio: true,
      selectedVoiceId: 'voice-es',
    });
  });

  it('treats delivered audio as stronger evidence than stale capability metadata', () => {
    expect(
      resolveLegacyProgrammeListenerOutputPolicy({
        ...base,
        capability: { voiceAvailable: false, textOnly: true, voiceId: null },
        output: { captionsAvailable: false, audioAvailable: true },
        deliveredGeneratedAudio: { voiceId: 'voice-es-delivered' },
      }),
    ).toMatchObject({
      fallbackPath: 'standard',
      originalAudioRequired: false,
      expectsGeneratedAudio: true,
      selectedVoiceId: 'voice-es-delivered',
    });
  });

  it('truthfully falls back when readiness claims audio but no usable voice/caption output exists', () => {
    expect(
      resolveLegacyProgrammeListenerOutputPolicy({
        ...base,
        subtitlesEnabled: false,
        capability: { voiceAvailable: false, textOnly: false, voiceId: null },
        output: { captionsAvailable: false, audioAvailable: true },
      }),
    ).toMatchObject({
      fallbackPath: 'original-media',
      originalAudioRequired: true,
      expectsGeneratedAudio: false,
      deliverCaption: false,
    });
  });
});
