/** @author masterzee001 */
/**
 * The phone's picker, tested where it is pure: the merge of a bundled
 * catalogue with a deployment's capability rows, the two direction questions,
 * and the search. No device, no bundler, no React.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import {
  canHear,
  canSpeak,
  capabilityNote,
  fetchLanguageCapabilities,
  filterChoices,
  languageChoices,
  languageName,
  withChosenFirst,
  type CapabilityRow,
} from '../people/languageChoices';

function choice(code: string, rows: readonly CapabilityRow[] = []) {
  const found = languageChoices(rows).find((candidate) => candidate.code === code);
  if (found === undefined) throw new Error(`no choice for ${code}`);
  return found;
}

describe('languageChoices', () => {
  it('offers the whole catalogue, not the three languages the screen used to hold', () => {
    const choices = languageChoices();
    expect(choices.length).toBe(LANGUAGE_CATALOGUE.length);
    expect(choices.length).toBeGreaterThan(90);
    for (const code of ['yo', 'ha', 'ig', 'pcm', 'sw', 'zu', 'ar', 'zh']) {
      expect(choices.some((c) => c.code === code), code).toBe(true);
    }
    expect(choices[0]?.code).toBe('en');
  });

  it('reports unknown when the deployment could not be asked, never available', () => {
    // A phone that cannot reach media ingest does not thereby know a language
    // works. Guessing `available` here is exactly the green-signal failure
    // this product keeps meeting.
    for (const language of languageChoices()) {
      expect(language.state, language.code).toBe('unknown');
      expect(language.sourceState, language.code).toBe('unknown');
      expect(language.degraded, language.code).toBe(false);
    }
  });

  it('takes the capability words from the deployment when it answers', () => {
    const rows: CapabilityRow[] = [
      { language: 'es', state: 'available', sourceState: 'available', targetState: 'available' },
      { language: 'wo', state: 'unavailable', sourceState: 'limited', targetState: 'unavailable', captionsOnly: true },
      { language: 'yo', state: 'limited', sourceState: 'limited', targetState: 'limited', degraded: true, reason: 'DEGRADED Yoruba: served by azure...' },
    ];
    expect(choice('es', rows).targetState).toBe('available');
    expect(choice('wo', rows).captionsOnly).toBe(true);
    expect(choice('yo', rows).degraded).toBe(true);
    expect(choice('yo', rows).reason).toMatch(/DEGRADED/);
    // A language the deployment did not mention stays unknown rather than
    // inheriting its neighbour's answer.
    expect(choice('ig', rows).state).toBe('unknown');
  });

  it('falls back to the conservative word when only one is sent', () => {
    const rows: CapabilityRow[] = [{ language: 'fr', state: 'limited' }];
    expect(choice('fr', rows).sourceState).toBe('limited');
    expect(choice('fr', rows).targetState).toBe('limited');
  });
});

describe('the two questions', () => {
  const rows: CapabilityRow[] = [
    { language: 'ig', state: 'unavailable', sourceState: 'unavailable', targetState: 'limited' },
    { language: 'wo', state: 'unavailable', sourceState: 'limited', targetState: 'unavailable', captionsOnly: true },
    { language: 've', state: 'unavailable', sourceState: 'unavailable', targetState: 'unavailable' },
  ];

  it('lets somebody HEAR a language nothing can transcribe', () => {
    expect(canHear(choice('ig', rows))).toBe(true);
    expect(canSpeak(choice('ig', rows))).toBe(false);
  });

  it('lets somebody hear a captions-only language, and refuses one with nothing at all', () => {
    expect(canHear(choice('wo', rows))).toBe(true);
    expect(canHear(choice('ve', rows))).toBe(false);
    expect(canSpeak(choice('ve', rows))).toBe(false);
  });

  it('allows an unknown language rather than blocking on an unread signal', () => {
    expect(canSpeak(choice('sw'))).toBe(true);
    expect(canHear(choice('sw'))).toBe(true);
  });

  it('says what is wrong in one short word', () => {
    expect(capabilityNote(choice('ig', rows))).toBe('beta');
    expect(capabilityNote(choice('wo', rows))).toBe('captions only');
    expect(capabilityNote(choice('ve', rows))).toBe('no voice yet');
    expect(capabilityNote(choice('yo', [{ language: 'yo', state: 'limited', degraded: true }]))).toBe('degraded voice');
    expect(capabilityNote(choice('es', [{ language: 'es', state: 'available', targetState: 'available' }]))).toBeNull();
  });
});

describe('filterChoices and ordering', () => {
  const all = languageChoices();

  it('finds a language by endonym, by English name and by code', () => {
    expect(filterChoices(all, 'yorùbá')[0]?.code).toBe('yo');
    expect(filterChoices(all, 'YORUBA')[0]?.code).toBe('yo');
    expect(filterChoices(all, 'naija')[0]?.code).toBe('pcm');
    expect(filterChoices(all, 'ha')[0]?.code).toBe('ha');
    expect(filterChoices(all, 'tl')[0]?.code).toBe('fil');
  });

  it('opens on the whole list and honours the limit', () => {
    expect(filterChoices(all, '', 12)).toHaveLength(12);
    expect(filterChoices(all, '   ', 5)).toHaveLength(5);
    expect(filterChoices(all, 'zzzz')).toEqual([]);
  });

  it('puts the current choice first so nobody sets a language they cannot see', () => {
    expect(withChosenFirst(all, 'yo')[0]?.code).toBe('yo');
    expect(withChosenFirst(all, 'en')[0]?.code).toBe('en');
    expect(withChosenFirst(all, null)[0]?.code).toBe('en');
    expect(withChosenFirst(all, 'not-a-language')).toHaveLength(all.length);
  });

  it('names a code for a subtitle', () => {
    expect(languageName('ig')).toBe('Igbo');
    expect(languageName(null)).toBe('—');
    expect(languageName('tlh')).toBe('tlh');
  });
});

describe('fetchLanguageCapabilities', () => {
  const ok = (body: unknown): Response =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it('reads the public catalogue route with no credential', async () => {
    let seen = '';
    const rows = await fetchLanguageCapabilities({
      fetch: async (url) => {
        seen = url;
        return ok({ catalogue: [{ language: 'es', state: 'available' }] });
      },
      ingestUrl: 'https://c7.example/media',
    });
    expect(seen).toBe('https://c7.example/media/languages/catalogue');
    expect(rows).toEqual([{ language: 'es', state: 'available' }]);
  });

  it('returns null on a refusal, a wrong shape or a thrown fetch', async () => {
    const refused = await fetchLanguageCapabilities({
      fetch: async () => ({ ok: false }) as unknown as Response,
      ingestUrl: 'x',
    });
    expect(refused).toBeNull();

    const wrongShape = await fetchLanguageCapabilities({
      fetch: async () => ok({ languages: [] }),
      ingestUrl: 'x',
    });
    expect(wrongShape).toBeNull();

    const threw = await fetchLanguageCapabilities({
      fetch: async () => {
        throw new Error('offline');
      },
      ingestUrl: 'x',
    });
    expect(threw).toBeNull();
  });

  it('drops rows that do not name a language instead of trusting the body', async () => {
    const rows = await fetchLanguageCapabilities({
      fetch: async () => ok({ catalogue: [{ language: 'fr' }, { nope: true }, null, 'es'] }),
      ingestUrl: 'x',
    });
    expect(rows).toEqual([{ language: 'fr' }]);
  });
});
