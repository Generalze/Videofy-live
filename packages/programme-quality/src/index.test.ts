/** @author masterzee001 */
/**
 * The page may not promote anything.
 *
 * These tests drive the derivation through the REAL registry rather than
 * hand-written decisions, because the property being protected is that Page 06
 * cannot turn a refusal into a usable state. A test that fabricates its own
 * `{ allowed: true }` proves the renderer works and proves nothing about the
 * gate, which is the only part anybody would get wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  createTranslationRouteRegistry,
  type ServiceScope,
} from '@videofy-live/translation-routes';
import type {
  ScopeApproval,
  TargetLanguageCapability,
} from '@videofy-live/shared-types';

/*
 * Local document builders, rather than the translation-routes fixtures.
 *
 * Those are excluded from that package's build on purpose, so reaching them
 * would mean importing another package's SOURCE by relative path -- the exact
 * shape that produced a day of module-shadowing confusion here before. These
 * are plain literals; the part that must be real is the registry below, and
 * that is imported properly.
 */
const MEASURED = {
  sampleCount: 5,
  successRate: 1,
  latencyMs: { min: 120, median: 180, mean: 190, max: 260 },
  recordedAt: '2026-08-30T00:00:00.000Z',
  notes: 'fixture measurement; availability and latency only',
};

function scopes(
  overrides: Partial<Record<ServiceScope, ScopeApproval>> = {},
): Record<string, ScopeApproval> {
  return {
    messaging: 'unapproved',
    'programme-live': 'unapproved',
    'call-live': 'unapproved',
    ...overrides,
  };
}

/** Refused for everything. Each test turns on exactly the one thing it is about. */
function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'm2m100',
    modelId: 'facebook/m2m100_418M',
    executionClass: 'local',
    productionApproved: false,
    technicalEvidence: null,
    humanReviewStatus: 'required-not-done',
    licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'fixture' },
    serviceScopes: scopes(),
    ...overrides,
  };
}

function documentOf(...routes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { version: 1, reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm'], routes };
}
import {
  deriveRouteQuality,
  deriveTtsStage,
  recommendDelay,
  weakest,
  type StageReport,
} from './index.js';

const SCOPE: ServiceScope = 'programme-live';

function registryOf(...routes: readonly Record<string, unknown>[]) {
  const made = createTranslationRouteRegistry(documentOf(...routes));
  if (!made.ok) throw new Error(`fixture document invalid: ${JSON.stringify(made.problems)}`);
  return made.registry;
}

/** A language that works end to end, unless a test says otherwise. */
function capability(over: Partial<TargetLanguageCapability> = {}): TargetLanguageCapability {
  return {
    language: 'fr',
    label: 'French',
    sourceState: 'qualified',
    targetState: 'qualified',
    providers: { stt: 'deepgram-nova nova-3', mt: 'opus-mt', tts: 'piper fr' },
    translationAvailable: true,
    voiceAvailable: true,
    textOnly: false,
    experimental: false,
    availability: 'available',
    translationModel: 'opus-mt',
    voiceId: 'piper-fr-1',
    license: 'Apache-2.0',
    commercialUse: 'allowed',
    ...over,
  } as TargetLanguageCapability;
}

/** An approved, measured, human-cleared route for a non-Nigerian direction. */
const QUALIFIED_EN_FR = route({
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  provider: 'opus-mt',
  modelId: 'Helsinki-NLP/opus-mt-en-fr',
  productionApproved: true,
  technicalEvidence: MEASURED,
  humanReviewStatus: 'passed',
  serviceScopes: scopes({ 'programme-live': 'approved' }),
});

describe('a qualified non-Nigerian route reports a truthful usable state', () => {
  it('is READY across all three stages, with the real providers named', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      scope: SCOPE,
      decision: registryOf(QUALIFIED_EN_FR).mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });

    expect(row.overall).toBe('ready');
    expect(row.translation.state).toBe('ready');
    expect(row.translation.provider).toBe('opus-mt Helsinki-NLP/opus-mt-en-fr');
    expect(row.stt.provider).toBe('deepgram-nova nova-3');
    expect(row.tts.provider).toBe('piper fr');
    // A ready stage is the only one allowed to have no reason.
    expect(row.translation.reason).toBeNull();
  });
});

describe('rows are directional and never collapse into a language', () => {
  it('en->fr being approved leaves fr->en refused', () => {
    // Only ONE direction is in the document, which is the realistic case.
    const registry = registryOf(QUALIFIED_EN_FR);
    const forward = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: SCOPE,
      decision: registry.mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    const reverse = deriveRouteQuality({
      sourceLanguage: 'fr', targetLanguage: 'en', scope: SCOPE,
      decision: registry.mayTranslate('fr', 'en', SCOPE),
      sourceCapability: capability(),
      targetCapability: capability({ language: 'en' }),
    });

    expect(forward.translation.state).toBe('ready');
    // THE REVERSE DIRECTION PASSING IS NOT EVIDENCE. This is the assertion
    // that fails if anybody keys the page by language instead of direction.
    expect(reverse.translation.state).toBe('unavailable');
    expect(reverse.translation.reason).toMatch(/fr->en/u);
    expect(forward.sourceLanguage).toBe('en');
    expect(reverse.sourceLanguage).toBe('fr');
  });

  it('one language being qualified does not carry another on the same provider', () => {
    // Same provider, same model family, different target. Nothing transfers.
    const registry = registryOf(QUALIFIED_EN_FR);
    const other = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'de', scope: SCOPE,
      decision: registry.mayTranslate('en', 'de', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability({ language: 'de' }),
    });
    expect(other.translation.state).toBe('unavailable');
    expect(other.overall).toBe('unavailable');
  });
});

describe('Nigerian directions stay REVIEW PENDING whatever the machine says', () => {
  /*
   * The strongest a Nigerian route can legitimately be today: production
   * approved, richly measured, and with every service scope still unapproved
   * because no speaker has reviewed it. The document validator REFUSES the
   * stronger version -- see the test below -- so this is not a weakened
   * fixture, it is the real ceiling.
   */
  const NIGERIAN_WITH_GREAT_NUMBERS = route({
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'naijalingo',
    modelId: 'naijalingo/yo-1',
    // Everything a benchmark can establish, at its best.
    productionApproved: true,
    technicalEvidence: { ...MEASURED, sampleCount: 500, successRate: 1 },
    humanReviewStatus: 'required-not-done',
    serviceScopes: scopes(),
  });

  it('the DOCUMENT itself is refused if somebody approves a scope anyway', () => {
    // Defence before the gate: this shape cannot even be written down, so the
    // page never gets the chance to render it.
    const made = createTranslationRouteRegistry(documentOf(route({
      sourceLanguage: 'en', targetLanguage: 'yo',
      provider: 'naijalingo', modelId: 'naijalingo/yo-1',
      productionApproved: true, technicalEvidence: MEASURED,
      humanReviewStatus: 'required-not-done',
      serviceScopes: scopes({ 'programme-live': 'approved' }),
    })));
    expect(made.ok).toBe(false);
    if (made.ok) throw new Error('unreachable');
    expect(JSON.stringify(made.problems)).toMatch(/human review is outstanding/u);
  });

  it.each(['yo', 'ha', 'ig', 'pcm'])('en->%s is review-pending, not ready', (target) => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: target, scope: SCOPE,
      decision: registryOf({
        ...NIGERIAN_WITH_GREAT_NUMBERS, targetLanguage: target,
      }).mayTranslate('en', target, SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability({ language: target }),
    });

    expect(row.translation.state).toBe('review-pending');
    expect(row.overall).toBe('review-pending');
    expect(row.translation.reason).toBeTruthy();
  });

  it('shows the measurement but labels it speed only, never reassurance', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'yo', scope: SCOPE,
      decision: registryOf(NIGERIAN_WITH_GREAT_NUMBERS).mayTranslate('en', 'yo', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability({ language: 'yo' }),
    });
    // The number is real and is shown...
    expect(row.translation.measuredLatencyMs).toEqual(MEASURED.latencyMs);
    // ...and cannot be read as a quality verdict.
    expect(row.translation.latencyEvidence).toMatch(/speed only/u);
    expect(row.translation.latencyEvidence).toMatch(/correctness is unreviewed/u);
  });

  it('recommends NO delay, because the route cannot go to air', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'yo', scope: SCOPE,
      decision: registryOf(NIGERIAN_WITH_GREAT_NUMBERS).mayTranslate('en', 'yo', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability({ language: 'yo' }),
    });
    expect(row.recommendedDelay.seconds).toBeNull();
    expect(row.recommendedDelay.basis).toBe('not-applicable');
  });
});

describe('nothing else promotes a route either', () => {
  it('a model name in the record is not approval', () => {
    // A fully named provider and model, approved for NOTHING.
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: SCOPE,
      decision: registryOf(route({
        sourceLanguage: 'en', targetLanguage: 'fr',
        provider: 'opus-mt', modelId: 'Helsinki-NLP/opus-mt-en-fr',
        humanReviewStatus: 'not-required',
      })).mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    expect(row.translation.state).toBe('unavailable');
    expect(row.translation.provider).toBe('opus-mt Helsinki-NLP/opus-mt-en-fr');
    // Named, and still refused. Provider text is description, not permission.
  });

  it('approval for one scope is not approval for another', () => {
    const messagingOnly = route({
      sourceLanguage: 'en', targetLanguage: 'fr',
      provider: 'opus-mt', modelId: 'x', productionApproved: true,
      technicalEvidence: MEASURED, humanReviewStatus: 'passed',
      serviceScopes: scopes({ messaging: 'approved' }),
    });
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: 'programme-live',
      decision: registryOf(messagingOnly).mayTranslate('en', 'fr', 'programme-live'),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    expect(row.translation.state).toBe('unavailable');
  });
});

describe('a failed stage is never hidden behind the other two', () => {
  it('unsupported recognition makes the row UNAVAILABLE though translation is ready', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'ig', targetLanguage: 'fr', scope: SCOPE,
      decision: registryOf(route({
        sourceLanguage: 'ig', targetLanguage: 'fr', provider: 'opus-mt', modelId: 'x',
        productionApproved: true, technicalEvidence: MEASURED,
        humanReviewStatus: 'passed', serviceScopes: scopes({ 'programme-live': 'approved' }),
      })).mayTranslate('ig', 'fr', SCOPE),
      // Nothing transcribes Igbo.
      sourceCapability: capability({
        language: 'ig', sourceState: 'unavailable',
        reason: 'no recogniser covers Igbo on this deployment',
      }),
      targetCapability: capability(),
    });

    expect(row.translation.state).toBe('ready');
    expect(row.tts.state).toBe('ready');
    expect(row.stt.state).toBe('unavailable');
    // The weakest stage wins. Two greens do not outvote a red.
    expect(row.overall).toBe('unavailable');
    expect(row.stt.reason).toMatch(/no recogniser covers Igbo/u);
  });

  it('degraded synthesis makes the row DEGRADED though the rest is ready', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'yo', scope: SCOPE,
      decision: registryOf(route({
        sourceLanguage: 'en', targetLanguage: 'yo', provider: 'naijalingo', modelId: 'y',
        productionApproved: true, technicalEvidence: MEASURED,
        humanReviewStatus: 'passed', serviceScopes: scopes({ 'programme-live': 'approved' }),
      })).mayTranslate('en', 'yo', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability({
        language: 'yo', degraded: true,
        reason: 'Yoruba is being spoken by a general vendor voice, not the specialist',
      }),
    });

    expect(row.translation.state).toBe('ready');
    expect(row.tts.state).toBe('degraded');
    expect(row.overall).toBe('degraded');
    expect(row.tts.reason).toMatch(/general vendor voice/u);
  });

  it('weakest() never averages', () => {
    expect(weakest(['ready', 'ready', 'unavailable'])).toBe('unavailable');
    expect(weakest(['ready', 'degraded', 'ready'])).toBe('degraded');
    expect(weakest(['degraded', 'review-pending', 'ready'])).toBe('review-pending');
    expect(weakest(['ready', 'ready', 'ready'])).toBe('ready');
  });
});

describe('every state that is not ready carries a reason', () => {
  it('holds across a spread of failure shapes', () => {
    const rows = [
      deriveTtsStage(null, 'zz'),
      deriveTtsStage(capability({ captionsOnly: true, reason: undefined }), 'fr'),
      deriveTtsStage(capability({ voiceAvailable: false, reason: undefined }), 'fr'),
      deriveTtsStage(capability({ degraded: true, reason: undefined }), 'yo'),
      deriveTtsStage(capability({ targetState: 'limited', reason: undefined }), 'fr'),
      deriveTtsStage(capability({ targetState: 'unavailable', reason: undefined }), 'fr'),
    ];
    for (const report of rows) {
      expect(report.state).not.toBe('ready');
      // A state an operator cannot act on is a support ticket by design.
      expect(report.reason, `${report.state} had no reason`).toBeTruthy();
    }
  });
});

describe('measured latency, and the absence of it', () => {
  it('recognition and synthesis report NOT MEASURED rather than a timeout', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: SCOPE,
      decision: registryOf(QUALIFIED_EN_FR).mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    // Nothing on this deployment measures these. Null is the honest answer;
    // a socket timeout dressed as an observation is not.
    expect(row.stt.measuredLatencyMs).toBeNull();
    expect(row.tts.measuredLatencyMs).toBeNull();
    expect(row.translation.measuredLatencyMs).toEqual(MEASURED.latencyMs);
    expect(row.translation.latencyEvidence).toMatch(/5 samples/u);
  });

  it('a route cannot be approved with no benchmark at all', () => {
    /*
     * Worth pinning because it is what makes the page's numbers trustworthy:
     * a READY translation stage always has a measurement behind it, since the
     * document validator refuses approval without one. The "no measurement
     * anywhere" branch of recommendDelay is therefore unreachable through the
     * registry today, and is unit-tested directly below rather than through a
     * document that cannot exist.
     */
    const made = createTranslationRouteRegistry(documentOf({
      ...QUALIFIED_EN_FR, technicalEvidence: null,
    }));
    expect(made.ok).toBe(false);
    if (made.ok) throw new Error('unreachable');
    expect(JSON.stringify(made.problems)).toMatch(/nothing has been measured/u);
  });

  it('with nothing measured anywhere, no delay is invented', () => {
    const unmeasured: StageReport[] = (['stt', 'translation', 'tts'] as const).map(
      (stage) => ({
        stage, state: 'ready', provider: 'x', reason: null,
        measuredLatencyMs: null, latencyEvidence: null,
      }),
    );
    const delay = recommendDelay(unmeasured, 'ready');
    expect(delay.seconds).toBeNull();
    expect(delay.basis).toBe('unmeasured');
    expect(delay.explanation).toMatch(/would be invented/u);
  });
});

describe('the recommended delay shows its workings', () => {
  it('picks the lowest grade that clears the worst observed time, and says so', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: SCOPE,
      decision: registryOf(QUALIFIED_EN_FR).mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    // 260 ms worst observed, x1.5 = 390 ms, cleared by the lowest grade.
    expect(row.recommendedDelay.measuredFloorMs).toBe(260);
    expect(row.recommendedDelay.seconds).toBe(30);
    expect(row.recommendedDelay.explanation).toMatch(/260 ms/u);
    expect(row.recommendedDelay.explanation).toMatch(/1\.5x margin/u);
  });

  it('names the unmeasured stages instead of pretending the budget is complete', () => {
    const row = deriveRouteQuality({
      sourceLanguage: 'en', targetLanguage: 'fr', scope: SCOPE,
      decision: registryOf(QUALIFIED_EN_FR).mayTranslate('en', 'fr', SCOPE),
      sourceCapability: capability({ language: 'en' }),
      targetCapability: capability(),
    });
    expect(row.recommendedDelay.basis).toBe('partly-measured');
    expect(row.recommendedDelay.unmeasuredStages).toEqual(['stt', 'tts']);
    expect(row.recommendedDelay.explanation).toMatch(/FLOOR, not a full budget/u);
  });

  it('a slow pipeline climbs to a higher grade rather than staying at 30', () => {
    const slow: StageReport = {
      stage: 'translation', state: 'ready', provider: 'x', reason: null,
      measuredLatencyMs: { min: 1000, median: 30_000, mean: 30_000, max: 50_000 },
      latencyEvidence: 'fixture',
    };
    // 50 s worst x1.5 = 75 s, which only the 90 s grade clears.
    expect(recommendDelay([slow], 'ready').seconds).toBe(90);
  });

  it('never recommends a delay for a route that cannot run', () => {
    const dead: StageReport = {
      stage: 'stt', state: 'unavailable', provider: null, reason: 'none',
      measuredLatencyMs: null, latencyEvidence: null,
    };
    const delay = recommendDelay([dead], 'unavailable');
    expect(delay.seconds).toBeNull();
    expect(delay.basis).toBe('not-applicable');
  });
});
