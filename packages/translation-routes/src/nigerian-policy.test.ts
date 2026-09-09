/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_CLOUD_TRANSLATION_PROVIDER,
  OPUS_MT_TRANSLATION_PROVIDER,
  isNigerianMachineTranslationPair,
  providerMatchesTranslationProvider,
} from './nigerian-policy.js';

describe('Nigerian MT pair policy', () => {
  it('is limited to English paired with Yoruba, Igbo or Hausa', () => {
    expect(isNigerianMachineTranslationPair('en', 'yo')).toBe(true);
    expect(isNigerianMachineTranslationPair('ig', 'EN')).toBe(true);
    expect(isNigerianMachineTranslationPair('ha-NG', 'en-US')).toBe(true);
    expect(isNigerianMachineTranslationPair('yo', 'fr')).toBe(false);
    expect(isNigerianMachineTranslationPair('yo', 'ig')).toBe(false);
    expect(isNigerianMachineTranslationPair('en', 'pcm')).toBe(false);
    expect(isNigerianMachineTranslationPair('yo', 'yo')).toBe(false);
  });
});

describe('translation provider matching', () => {
  it('matches route provider ids to runtime model-qualified names', () => {
    expect(
      providerMatchesTranslationProvider(
        GOOGLE_CLOUD_TRANSLATION_PROVIDER,
        'google-cloud:translate-v3',
      ),
    ).toBe(true);
    expect(
      providerMatchesTranslationProvider(OPUS_MT_TRANSLATION_PROVIDER, 'opus-mt+m2m100'),
    ).toBe(true);
  });

  it('does not match by arbitrary substring', () => {
    expect(providerMatchesTranslationProvider('cloud', 'google-cloud:translate-v3')).toBe(false);
    expect(providerMatchesTranslationProvider('opus-mt', 'nllb200')).toBe(false);
  });
});
