/** @author masterzee001 */
/**
 * Whether a language may carry a programme, as opposed to being speakable.
 *
 * THESE FOUR LANGUAGES BREAK EVERY ORDINARY READINESS SIGNAL. Azure returns
 * HTTP 200, in good time, with audio that sounds fluent -- and mispronounces
 * Yoruba, Igbo, Hausa and Nigerian Pidgin badly enough that a speaker hears it
 * immediately and a monitor never will. So for these four, "the chain
 * produced audio" is not weak evidence of readiness; it is precisely the
 * evidence that must not be accepted as readiness.
 *
 * A configured provider may exist. A technical fallback may exist. Linguistic
 * qualification is a separate fact, and without it the programme route is
 * closed.
 */
import { describe, expect, it } from 'vitest';
import { buildTargetLanguageCatalogue, applyProgrammeRoute } from '../language-controls.js';
import { nigerianRouteQualified } from '../provider-readiness-wiring.js';
import type { RouteEvidence } from '../provider-readiness-wiring.js';

const NIGERIAN = ['yo', 'ig', 'ha', 'pcm'] as const;

function catalogue(providerIds: readonly string[], qualified?: (language: string) => boolean) {
  const built = buildTargetLanguageCatalogue({
    supportedTranslationLanguages: ['yo', 'ig', 'ha', 'fr', 'es'],
    supportedVoiceLanguages: ['yo', 'ig', 'ha', 'pcm', 'fr', 'es'],
    configuredProviderIds: providerIds,
    ...(qualified === undefined ? {} : { programmeRouteQualified: qualified }),
  });
  return new Map(built.map((capability) => [capability.language, capability]));
}

function evidence(over: Record<string, unknown> = {}, approved = ['programme-live']): RouteEvidence {
  return {
    routes: () => [
      {
        sourceLanguage: 'en',
        targetLanguage: 'yo',
        modelId: 'naija-1',
        humanReviewStatus: 'passed',
        reviewEvidence: {
          engine: 'naijalingo',
          model: 'naija',
          modelVersion: 'naija-1',
          corpusHash: 'abc123',
          corpusVersion: '2026.09',
          evaluator: 'a Yoruba speaker',
          assessedAt: '2026-09-01T00:00:00.000Z',
          method: 'native-listener',
          score: 4,
          scale: '1-5',
          evidenceReference: 'docs/certification/translation-quality-nigerian.md',
        },
        ...over,
      },
    ],
    approvedScopes: () => approved,
  };
}

describe('Azure being able to say it is not readiness', () => {
  it('CLOSES THE PROGRAMME ROUTE FOR ALL FOUR WHEN ONLY THE GENERAL VENDOR IS THERE', () => {
    /*
     * The exact situation on production today: AZURE_SPEECH_KEY set, no
     * NAIJALINGO_API_KEY. The chain works. Every request returns 200. And an
     * audience would hear their own language mispronounced for the length of
     * the broadcast.
     */
    const built = catalogue(['azure', 'deepgram', 'opus-mt']);
    for (const language of NIGERIAN) {
      const capability = built.get(language);
      expect(capability?.programmeRoute?.available, language).toBe(false);
      expect(capability?.programmeRoute?.reason, language).toMatch(/9jaLingo specialist/u);
    }
  });

  it('still reports the technical capability honestly', () => {
    // Not hidden, and not renamed. The chain really can produce audio; what
    // it may not do is carry a programme. Collapsing the two would leave an
    // operator unable to see why a language they can hear is refused.
    const built = catalogue(['azure', 'deepgram', 'opus-mt']);
    expect(built.get('yo')?.voiceAvailable).toBe(true);
    expect(built.get('yo')?.degraded).toBe(true);
  });

  it('CLOSES IT EVEN WITH THE SPECIALIST CONFIGURED, UNTIL SOMEBODY HAS JUDGED IT', () => {
    /*
     * The subtler half of the ruling. A credential is not a qualification: the
     * specialist being wired says the audio will come from the right vendor,
     * not that anybody has listened to it.
     */
    const built = catalogue(['naijalingo', 'azure', 'deepgram', 'opus-mt']);
    for (const language of NIGERIAN) {
      expect(built.get(language)?.programmeRoute?.available, language).toBe(false);
      expect(built.get(language)?.programmeRoute?.reason, language).toMatch(/judged/u);
    }
  });

  it('opens it once a speaker has judged the route and the document admits it', () => {
    const built = catalogue(['naijalingo', 'azure', 'deepgram', 'opus-mt'], (language) =>
      language === 'yo',
    );
    expect(built.get('yo')?.programmeRoute?.available).toBe(true);
    expect(built.get('yo')?.programmeRoute?.reason).toBeNull();
    // And only that one. A review of Yoruba says nothing about Igbo.
    expect(built.get('ig')?.programmeRoute?.available).toBe(false);
  });

  it('leaves every other language on the existing rule', () => {
    /*
     * Widening qualification to all languages is a policy change, not a bug
     * fix, and would silently withdraw languages in service today.
     */
    const built = catalogue(['azure', 'deepgram', 'opus-mt']);
    expect(built.get('fr')?.programmeRoute?.available).toBe(true);
    expect(built.get('es')?.programmeRoute?.available).toBe(true);
  });
});

describe('the verdict is re-decided when the catalogue is read', () => {
  it('does not freeze "nobody has judged this" at construction time', () => {
    /*
     * The route document loads after the session store is built. A verdict
     * fixed at construction would say unqualified for the life of the process
     * and would never notice a review that landed since boot.
     */
    const built = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['yo'],
      supportedVoiceLanguages: ['yo'],
      configuredProviderIds: ['naijalingo', 'azure', 'deepgram', 'opus-mt'],
    });
    const yorubaIn = (list: readonly { language: string; programmeRoute?: { available: boolean } }[]) =>
      list.find((capability) => capability.language === 'yo')?.programmeRoute?.available;
    expect(yorubaIn(built)).toBe(false);

    const reread = applyProgrammeRoute(built, () => true);
    expect(yorubaIn(reread)).toBe(true);
  });
});

describe('what counts as qualified is the ladder own answer', () => {
  it('requires a review AND the document approving it for this scope', () => {
    expect(nigerianRouteQualified(evidence(), 'en', 'yo')).toBe(true);
    // Reviewed, and not admitted for this scope. Two separate facts.
    expect(nigerianRouteQualified(evidence({}, ['calls']), 'en', 'yo')).toBe(false);
  });

  it('refuses a pass that carries no evidence', () => {
    // A verdict without its subject. Nothing to check the judgement against,
    // and nothing to notice going stale when the model moves on.
    expect(nigerianRouteQualified(evidence({ reviewEvidence: undefined }), 'en', 'yo')).toBe(false);
  });

  it('refuses a review of a DIFFERENT model version', () => {
    // The route now runs naija-2; the review was of naija-1. That evidence
    // describes something that is no longer there.
    expect(nigerianRouteQualified(evidence({ modelId: 'naija-2' }), 'en', 'yo')).toBe(false);
  });

  it('refuses everything when no route document is loaded', () => {
    /*
     * A deployment with no document has had nobody judge anything. This is the
     * answer that cannot be recovered from if it is wrong, so it is the
     * conservative one.
     */
    expect(nigerianRouteQualified(null, 'en', 'yo')).toBe(false);
  });

  it('refuses a language the document says nothing about', () => {
    expect(nigerianRouteQualified(evidence(), 'en', 'ha')).toBe(false);
  });
});
