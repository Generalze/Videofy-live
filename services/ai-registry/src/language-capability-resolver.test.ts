/** @author masterzee001 */
/**
 * The resolver must never say more than the registry's evidence supports.
 * Each test pins one direction the answer is not allowed to drift in.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import { COMMERCIAL_PROVIDERS, type CommercialProvider } from './commercial-providers.js';
import {
  isOfferableSource,
  isOfferableTarget,
  resolveLanguageCapabilities,
} from './language-capability-resolver.js';
import { SELF_HOSTED_ENGINES, type SelfHostedEngine } from './self-hosted-engines.js';

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
    const english = row('en', resolveLanguageCapabilities({ providers: withoutTts, engines: [] }));
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
    expect(
      resolveLanguageCapabilities({ providers: [], engines: [] }).every(
        (r) => r.state === 'unavailable',
      ),
    ).toBe(true);
  });
});

/**
 * The matrix tests below build their own tiny chain rather than leaning on the
 * registry, so they pin the RULE and not today's vendor list. A test written
 * against the real providers passes for the wrong reason the moment somebody
 * adds a language to a model card.
 */
const NIGERIAN = ['ha', 'ig', 'yo', 'pcm'] as const;

function engine(
  engineId: string,
  stage: SelfHostedEngine['stage'],
  exercised: readonly string[],
  declared: readonly string[],
): SelfHostedEngine {
  return {
    engineId,
    displayName: engineId,
    stage,
    selectedBy: 'TEST_ONLY_ENV_NAME',
    exercisedLanguages: exercised,
    declaredLanguages: declared,
    evidence: 'test fixture',
  };
}

/** Every stage present at the same level, so the row's state is that level. */
function chainOf(exercised: readonly string[], declared: readonly string[]): SelfHostedEngine[] {
  return [
    engine('test-stt', 'stt', exercised, declared),
    engine('test-mt', 'mt', exercised, declared),
    engine('test-tts', 'tts', exercised, declared),
  ];
}

describe('the stage matrix', () => {
  it('reads every stage from the declarations, so all three present means available', () => {
    const rows = resolveLanguageCapabilities({ providers: [], engines: chainOf(['sw'], []) });
    const swahili = row('sw', rows);
    expect(swahili.state).toBe('available');
    expect(swahili.sourceState).toBe('available');
    expect(swahili.targetState).toBe('available');
    expect(swahili.stageStates).toEqual({ stt: 'available', mt: 'available', tts: 'available' });
    expect(swahili.captionsOnly).toBe(false);
  });

  it('holds the row at the WEAKEST stage: one partial stage caps all of it', () => {
    const engines = [
      engine('test-stt', 'stt', ['sw'], []),
      engine('test-mt', 'mt', ['sw'], []),
      // TTS only claims it: a model card, never run here.
      engine('test-tts', 'tts', [], ['sw']),
    ];
    const swahili = row('sw', resolveLanguageCapabilities({ providers: [], engines }));
    expect(swahili.stageStates).toEqual({ stt: 'available', mt: 'available', tts: 'limited' });
    expect(swahili.state).toBe('limited');
    expect(swahili.sourceState).toBe('available');
    expect(swahili.targetState).toBe('limited');
    expect(swahili.reason).toMatch(/TTS/);
    expect(swahili.reason).not.toMatch(/STT|MT/);
  });

  it('separates SOURCE from TARGET, so no recogniser never blocks being listened to', () => {
    /*
     * Zulu's real shape, and Igbo's: Whisper's tokenizer lists neither and
     * Deepgram does not claim them, while the translation engines and a voice
     * vendor serve both. Gating a TARGET list on the conservative state is what
     * made the console refuse languages a listener could perfectly well hear.
     */
    const engines = [engine('test-mt', 'mt', ['zu'], []), engine('test-tts', 'tts', ['zu'], [])];
    const zulu = row('zu', resolveLanguageCapabilities({ providers: [], engines }));
    expect(zulu.stt).toBe(false);
    expect(zulu.sourceState).toBe('unavailable');
    expect(zulu.targetState).toBe('available');
    expect(isOfferableSource(zulu)).toBe(false);
    expect(isOfferableTarget(zulu)).toBe(true);
    // The conservative single word is still the weakest stage, for callers
    // that only ever wanted one.
    expect(zulu.state).toBe('unavailable');
  });

  it('marks a translatable language with no voice as captions-only, not as a failure', () => {
    const engines = [engine('test-stt', 'stt', ['wo'], []), engine('test-mt', 'mt', ['wo'], [])];
    const wolof = row('wo', resolveLanguageCapabilities({ providers: [], engines }));
    expect(wolof.captionsOnly).toBe(true);
    expect(wolof.tts).toBe(false);
    expect(isOfferableTarget(wolof)).toBe(true);
  });

  it('a stage with no provider at all is unavailable and names itself', () => {
    const engines = [engine('test-stt', 'stt', ['sw'], []), engine('test-tts', 'tts', ['sw'], [])];
    const swahili = row('sw', resolveLanguageCapabilities({ providers: [], engines }));
    expect(swahili.stageStates.mt).toBe('unavailable');
    expect(swahili.reason).toMatch(/No provider for MT/);
  });

  it('honours configuredProviderIds: a declaration nobody configured is not a capability', () => {
    const engines = chainOf(['sw'], []);
    const rows = resolveLanguageCapabilities({
      providers: [],
      engines,
      configuredProviderIds: ['test-stt', 'test-mt'],
    });
    const swahili = row('sw', rows);
    expect(swahili.tts).toBe(false);
    expect(swahili.targetState).toBe('unavailable');
  });
});

describe('the Nigerian specialist rule', () => {
  it('never lets a general vendor rise above limited for ha, ig, yo or pcm', () => {
    /*
     * Azure with those four languages VERIFIED and a live observation naming
     * them -- the strongest evidence the model can express. It still must not
     * read as available, because the evidence is about HTTP, and the 2026-08-26
     * listening test is about the audio.
     */
    const overClaimingAzure: CommercialProvider[] = COMMERCIAL_PROVIDERS.map((provider) =>
      provider.providerId === 'azure'
        ? {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              verifiedLanguages: [...model.verifiedLanguages, ...NIGERIAN],
            })),
            liveObservations: [
              ...provider.liveObservations,
              {
                observedAt: '2026-08-30',
                environment: 'test',
                capability: 'tts' as const,
                languages: [...NIGERIAN],
                sampleCount: 9,
                summary: 'Synthetic: audio returned for all four. Says nothing about the audio.',
              },
            ],
          }
        : provider,
    );
    const rows = resolveLanguageCapabilities({
      providers: overClaimingAzure,
      // 9jaLingo is registered but NOT configured on this deployment.
      configuredProviderIds: ['deepgram', 'elevenlabs', 'azure', 'google-cloud', 'opus-mt', 'm2m100', 'nllb-200', 'piper', 'mms-tts'],
    });
    for (const code of NIGERIAN) {
      const language = row(code, rows);
      expect(language.stageStates.tts, code).toBe('limited');
      expect(STATE_RANK[language.targetState], code).toBeLessThanOrEqual(STATE_RANK.limited);
      expect(language.degraded, code).toBe(true);
      expect(language.providers.tts, code).toBe('azure');
      expect(language.reason, code).toMatch(/DEGRADED/);
      expect(language.reason, code).toMatch(/9jaLingo/);
      expect(language.reason, code).toMatch(/NAIJALINGO_API_KEY/);
    }
  });

  it('stops being degraded once the specialist is configured, and still does not overstate', () => {
    const rows = resolveLanguageCapabilities({
      configuredProviderIds: ['deepgram', 'azure', 'naijalingo', 'opus-mt', 'm2m100', 'nllb-200'],
    });
    for (const code of NIGERIAN) {
      const language = row(code, rows);
      expect(language.providers.tts, code).toBe('naijalingo');
      expect(language.degraded, code).toBeUndefined();
      // 9jaLingo is `configured`: documented, never exercised here. That is a
      // claim, and a claim is `limited` however specialist the vendor is.
      expect(language.stageStates.tts, code).toBe('limited');
    }
  });

  it('does not quietly widen the Nigerian chain with a local voice engine', () => {
    // MMS-TTS pins a Yoruba voice, and commercial-routing rules the chain is
    // 9jaLingo then Azure and nothing else. A local engine answering here
    // would be a third vendor nobody decided on.
    const rows = resolveLanguageCapabilities({
      providers: [],
      engines: SELF_HOSTED_ENGINES,
    });
    expect(row('yo', rows).providers.tts).toBeUndefined();
    expect(row('yo', rows).stageStates.tts).toBe('unavailable');
  });
});

describe('breadth, without overstatement', () => {
  it('offers most of the catalogue as a target instead of the old ten-language list', () => {
    const rows = resolveLanguageCapabilities();
    const offerable = rows.filter(isOfferableTarget);
    // The regression this guards: the MT stage answered from a ten-entry array,
    // which made ninety languages unavailable for want of a written-down fact.
    expect(offerable.length).toBeGreaterThan(60);
    expect(offerable.length).toBeLessThanOrEqual(rows.length);
  });

  it('still refuses the languages no engine declares', () => {
    const rows = resolveLanguageCapabilities();
    // No translation engine in this deployment lists Nigerian Pidgin or Venda.
    for (const code of ['pcm', 've']) {
      const language = row(code, rows);
      expect(language.mt, code).toBe(false);
      expect(language.targetState, code).toBe('unavailable');
      expect(language.reason, code).toMatch(/No provider for/);
    }
  });

  it('promotes nothing beyond its evidence: every row is backed by a declaring provider', () => {
    for (const language of resolveLanguageCapabilities()) {
      if (language.stt) expect(language.providers.stt, language.code).toBeDefined();
      if (language.mt) expect(language.providers.mt, language.code).toBeDefined();
      if (language.tts) expect(language.providers.tts, language.code).toBeDefined();
      if (language.state !== 'qualified') expect(language.reason, language.code).toBeTruthy();
    }
  });
});
