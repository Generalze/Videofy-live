/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';

import { selectLegacyProgrammeAudiences } from './legacy-programme-audience-selector.js';

describe('selectLegacyProgrammeAudiences', () => {
  it('sends ordinary legacy TranslationEvent delivery to its language and operator', () => {
    expect(
      selectLegacyProgrammeAudiences({ kind: 'translation', event: { targetLanguage: 'fr' } }),
    ).toEqual([{ kind: 'language', language: 'fr' }, { kind: 'operator' }]);
  });

  it('sends translated timestamped events to operator, target language, and original', () => {
    expect(
      selectLegacyProgrammeAudiences({
        kind: 'timestamped-translation',
        event: { targetLanguage: 'es', status: 'translated' },
      }),
    ).toEqual([
      { kind: 'operator' },
      { kind: 'language', language: 'es' },
      { kind: 'language', language: 'original' },
    ]);
  });

  it.each(['queued', 'translating', 'retrying', 'failed'])(
    'suppresses timestamped %s listeners while retaining operator visibility',
    (status) => {
      expect(
        selectLegacyProgrammeAudiences({
          kind: 'timestamped-translation',
          event: { targetLanguage: 'es', status },
        }),
      ).toEqual([{ kind: 'operator' }]);
    },
  );

  it('sends generated audio to its language and the operator', () => {
    expect(
      selectLegacyProgrammeAudiences({
        kind: 'generated-audio-ready',
        event: { targetLanguage: 'pt' },
      }),
    ).toEqual([{ kind: 'language', language: 'pt' }, { kind: 'operator' }]);
  });
});
