/** @author masterzee001 */
/**
 * The voice rows come from the registry and from nowhere else: no catalogue
 * means Waiting with an unknown provider, never an invented vendor.
 */
import { describe, expect, it } from 'vitest';
import type { TargetLanguageCapability } from '@videofy-live/shared-types';
import { buildVoiceRows, providerLabel } from './voiceRows';

function entry(overrides: Partial<TargetLanguageCapability>): TargetLanguageCapability {
  return {
    language: 'es',
    label: 'Spanish',
    translationAvailable: true,
    voiceAvailable: true,
    textOnly: false,
    experimental: false,
    availability: 'voice-available',
    translationModel: 'opus-mt',
    voiceId: 'es-ES',
    license: 'commercial',
    commercialUse: 'allowed',
    ...overrides,
  };
}

describe('buildVoiceRows', () => {
  it('reports every selected language as Waiting with no provider until the catalogue arrives', () => {
    const rows = buildVoiceRows(['es', 'yo'], undefined);
    expect(rows.map((row) => [row.code, row.label, row.provider, row.status])).toEqual([
      ['es', 'ES', null, 'waiting'],
      ['yo', 'YO', null, 'waiting'],
    ]);
  });

  it('names the vendor the registry resolved and the voice it will use', () => {
    const rows = buildVoiceRows(['es'], [entry({ providers: { tts: 'azure' }, state: 'qualified' })]);
    expect(rows[0]).toMatchObject({ label: 'Spanish', provider: 'Azure Neural (es-ES)', status: 'ready' });
  });

  it('keeps the operator order and does not add catalogue languages that were not chosen', () => {
    const catalogue = [entry({ language: 'fr', label: 'French' }), entry({ language: 'de', label: 'German' })];
    expect(buildVoiceRows(['de', 'fr'], catalogue).map((row) => row.code)).toEqual(['de', 'fr']);
  });

  it('is honest about a language the catalogue lacks or cannot voice', () => {
    const catalogue = [
      entry({ language: 'ha', label: 'Hausa', translationAvailable: false, voiceAvailable: false, voiceId: null, providers: {} }),
      entry({ language: 'ig', label: 'Igbo', textOnly: true, voiceAvailable: false, voiceId: null }),
      entry({ language: 'yo', label: 'Yoruba', state: 'limited', providers: { tts: 'naijalingo' }, voiceId: 'yo' }),
    ];
    const rows = buildVoiceRows(['ha', 'ig', 'yo', 'sw'], catalogue);
    expect(rows.map((row) => [row.status, row.provider])).toEqual([
      ['waiting', null],
      ['captions-only', null],
      ['limited', '9jaLingo (yo)'],
      ['waiting', null],
    ]);
    expect(rows[3]!.reason).toMatch(/outside the deployment catalogue/);
  });
});

describe('providerLabel', () => {
  it('shows an unknown provider id as given rather than hiding it', () => {
    expect(providerLabel('acme-tts', 'v1')).toBe('acme-tts (v1)');
    expect(providerLabel(undefined, 'v1')).toBeNull();
    expect(providerLabel('azure', null)).toBe('Azure Neural');
  });
});
