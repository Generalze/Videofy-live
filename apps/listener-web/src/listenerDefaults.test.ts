/** @owner masterzee001 */
import type { MediaStateEvent, TargetLanguageCapability } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { defaultListenerTargetLanguage, isEnabledTargetLanguage } from './listenerDefaults';

describe('listener defaults', () => {
  it('stays on the original channel until the session reports a target', () => {
    expect(defaultListenerTargetLanguage(null)).toBeUndefined();
    expect(defaultListenerTargetLanguage(session([], []))).toBeUndefined();
  });

  it('joins the first target the deployment has enabled, in operator order', () => {
    const state = session(
      ['yo', 'fr', 'es'],
      [capability('yo', false), capability('fr', true), capability('es', true)],
    );
    expect(defaultListenerTargetLanguage(state)).toBe('fr');
  });

  it('is no longer pinned to Spanish', () => {
    const state = session(['fr', 'es'], [capability('fr', true), capability('es', true)]);
    expect(defaultListenerTargetLanguage(state)).toBe('fr');
  });

  it('offers no default when every session target is disabled', () => {
    const state = session(['yo', 'la'], [capability('yo', false), capability('la', false)]);
    expect(defaultListenerTargetLanguage(state)).toBeUndefined();
  });

  it('trusts the session order when an older ingest sends no catalogue', () => {
    const state = session(['pt', 'es']);
    expect(defaultListenerTargetLanguage(state)).toBe('pt');
  });

  it('treats only a translatable language as enabled', () => {
    expect(isEnabledTargetLanguage(undefined)).toBe(false);
    expect(isEnabledTargetLanguage(capability('cy', false))).toBe(false);
    expect(isEnabledTargetLanguage(capability('fr', true))).toBe(true);
  });
});

function session(
  translatedLanguages: string[],
  targetLanguageCatalogue?: TargetLanguageCapability[],
): MediaStateEvent {
  return {
    translatedLanguages,
    ...(targetLanguageCatalogue === undefined ? {} : { targetLanguageCatalogue }),
  } as MediaStateEvent;
}

function capability(language: string, translationAvailable: boolean): TargetLanguageCapability {
  return {
    language,
    label: language,
    translationAvailable,
    voiceAvailable: false,
    textOnly: translationAvailable,
    experimental: !translationAvailable,
    availability: translationAvailable ? 'text-only' : 'experimental',
    translationModel: null,
    voiceId: null,
    license: 'test',
    commercialUse: 'unknown',
  };
}
