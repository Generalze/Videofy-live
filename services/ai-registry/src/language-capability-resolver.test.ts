/** @author masterzee001 */
/**
 * The resolver must never say more than the registry's evidence supports.
 * Each test pins one direction the answer is not allowed to drift in.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import { COMMERCIAL_PROVIDERS, type CommercialProvider } from './commercial-providers.js';
import { resolveLanguageCapabilities } from './language-capability-resolver.js';

const STATE_RANK = { unavailable: 0, limited: 1, available: 2, qualified: 3 } as const;

function row(code: string, rows = resolveLanguageCapabilities()) {
  const found = rows.find((candidate) => candidate.code === code);
  if (found === undefined) throw new Error(`no row for ${code}`);
  return found;
}

describe('resolveLanguageCapabilities', () => {
  it('reports every catalogue language exactly once, in catalogue order', () => {
    const rows = resolveLanguageCapabilities();
    expect(rows.map((r) => r.code)).toEqual(LANGUAGE_CATALOGUE.map((l) => l.code));
  });

  it('English is at least available on the live chain', () => {
    const english = row('en');
    expect(STATE_RANK[english.state]).toBeGreaterThanOrEqual(STATE_RANK.available);
    expect(english).toMatchObject({ stt: true, mt: true, tts: true });
    expect(english.providers).toMatchObject({ stt: 'deepgram', mt: 'opus-mt' });
  });

  it('a language with no TTS provider is unavailable with a reason naming the stage', () => {
    // Strip every TTS-capable model and observation so nothing can synthesise.
    const withoutTts: CommercialProvider[] = COMMERCIAL_PROVIDERS.map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => model.capabilities.tts === undefined),
      liveObservations: provider.liveObservations.filter((o) => o.capability !== 'tts'),
    }));
    const english = row('en', resolveLanguageCapabilities({ providers: withoutTts }));
    expect(english.state).toBe('unavailable');
    expect(english.tts).toBe(false);
    expect(english.stt).toBe(true);
    expect(english.reason).toMatch(/TTS/);
    expect(english.reason).not.toMatch(/STT/);
  });

  it('Yoruba, Hausa and Igbo are at most limited without live evidence', () => {
    for (const code of ['yo', 'ha', 'ig']) {
      const language = row(code);
      const hasLiveEvidence = COMMERCIAL_PROVIDERS.some((p) =>
        p.liveObservations.some((o) => (o.languages ?? []).includes(code)),
      );
      if (!hasLiveEvidence) {
        expect(STATE_RANK[language.state], code).toBeLessThanOrEqual(STATE_RANK.limited);
        expect(language.reason, code).toBeTruthy();
      }
    }
  });

  it('a vendor claim never rises above limited', () => {
    // Nova-3 lists German; nobody here has read a German transcript.
    const german = row('de');
    expect(STATE_RANK[german.state]).toBeLessThanOrEqual(STATE_RANK.limited);
    expect(german.reason).toMatch(/claim/);
  });

  it('a provider that has never been run counts as a claim even where its page is explicit', () => {
    // 9jaLingo is `configured`: its documented languages must not read as declared.
    const withStt: CommercialProvider[] = COMMERCIAL_PROVIDERS.map((provider) =>
      provider.providerId === 'deepgram'
        ? {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              verifiedLanguages: [...model.verifiedLanguages, 'yo'],
            })),
          }
        : provider,
    );
    const yoruba = row('yo', resolveLanguageCapabilities({ providers: withStt }));
    expect(yoruba.tts).toBe(true);
    expect(yoruba.providers.tts).toBe('naijalingo');
    expect(yoruba.state).toBe('limited');
  });

  it('unavailable rows still carry names so a picker can show them disabled', () => {
    const rows = resolveLanguageCapabilities();
    const unavailable = rows.filter((r) => r.state === 'unavailable');
    expect(unavailable.length).toBeGreaterThan(0);
    for (const language of unavailable) {
      expect(language.englishName).toBeTruthy();
      expect(language.nativeName).toBeTruthy();
      expect(language.reason).toMatch(/No provider for/);
    }
  });

  it('regional verified tags count for their base subtag', () => {
    // Azure verifies `en-US`; the catalogue key is `en`.
    const english = row('en');
    expect(english.providers.tts).toBeDefined();
  });

  it('never reports qualified unless every stage has a live observation naming the language', () => {
    // Give English live STT and live TTS. MT has no observation path in the
    // registry today, so the weakest stage holds the row at `available` and
    // the reason names MT alone: qualified needs all three, not a majority.
    const liveEnglish: CommercialProvider[] = COMMERCIAL_PROVIDERS.map((provider) =>
      provider.providerId === 'elevenlabs'
        ? {
            ...provider,
            liveObservations: [
              ...provider.liveObservations,
              {
                observedAt: '2026-08-29',
                environment: 'test',
                capability: 'tts',
                languages: ['en'],
                sampleCount: 1,
                summary: 'Synthetic observation for the resolver test only.',
              },
            ],
          }
        : provider,
    );
    const english = row('en', resolveLanguageCapabilities({ providers: liveEnglish }));
    expect(english.state).toBe('available');
    expect(english.reason).toMatch(/MT/);
    expect(english.reason).not.toMatch(/STT|TTS/);
    expect(resolveLanguageCapabilities().some((r) => r.state === 'qualified')).toBe(false);
  });

  it('is pure and deterministic, and the grade seam changes nothing today', () => {
    const first = resolveLanguageCapabilities();
    const second = resolveLanguageCapabilities();
    const standard = resolveLanguageCapabilities({ grade: 'standard' });
    const premium = resolveLanguageCapabilities({ grade: 'premium' });
    expect(second).toEqual(first);
    expect(standard).toEqual(first);
    expect(premium).toEqual(first);
    expect(resolveLanguageCapabilities({ providers: [] }).every((r) => r.state === 'unavailable')).toBe(
      true,
    );
  });
});
