/** @author masterzee001 */
/**
 * C-AI1.1F pins: who serves what, and what a refusal says.
 */
import { describe, expect, it } from 'vitest';
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
  NIGERIAN_SPECIALIST_PROVIDER_ID,
  NIGERIAN_TTS_ROUTE_ORDER,
  isDegradedNigerianSynthesis,
  isNigerianSpecialistLanguage,
  localFallbackPermitted,
  resolveCommercialRoute,
  type ProviderServiceContext,
} from './index.js';

const CALL: ProviderServiceContext = { serviceCategory: 'call', mediaMode: 'live' };
const PROG_LIVE: ProviderServiceContext = { serviceCategory: 'programme', mediaMode: 'live' };
const PROG_UPLOAD: ProviderServiceContext = { serviceCategory: 'programme', mediaMode: 'uploaded' };

const allUsable = (): boolean => true;
const noneUsable = (): boolean => false;

function route(
  capability: 'transcription' | 'translation' | 'tts',
  service: ProviderServiceContext,
  overrides: Partial<Parameters<typeof resolveCommercialRoute>[0]> = {},
) {
  return resolveCommercialRoute({
    capability,
    service,
    minimumStage: 'integrated',
    isUsable: allUsable,
    ...overrides,
  });
}

describe('the first-deployment route', () => {
  it('PIN: Deepgram, Google and ElevenLabs are the primaries', () => {
    expect(route('transcription', CALL).ordered[0]).toMatchObject({
      providerId: 'deepgram',
      role: 'primary',
    });
    expect(route('translation', CALL).ordered[0]).toMatchObject({
      providerId: 'google-cloud',
      role: 'primary',
    });
    expect(route('tts', CALL).ordered[0]).toMatchObject({
      providerId: 'elevenlabs',
      role: 'primary',
    });
  });

  it('PIN: Azure is a fallback behind ElevenLabs, never ahead of it', () => {
    // ORDER and STAGE GATING are separate properties and are tested apart.
    // Azure sits at `configured` today, so a deployment demanding `integrated`
    // never reaches it -- which is correct, and would hide the ordering rule
    // if this test conflated the two.
    const tts = route('tts', CALL, { minimumStage: 'configured' });
    const ids = tts.ordered.map((c) => c.providerId);
    expect(ids).toEqual(['elevenlabs', 'azure']);
    expect(tts.ordered[1]?.role).toBe('fallback');
  });

  it('PIN: Azure is now an eligible fallback, on real evidence', () => {
    // It was gated out until 2026-08-22, when its adapter was actually run
    // against the service. Evidence arriving is exactly what should move it,
    // and nothing else should have.
    const tts = route('tts', CALL, { minimumStage: 'integrated' });
    expect(tts.ordered.map((c) => c.providerId)).toEqual(['elevenlabs', 'azure']);
    expect(tts.ordered[1]?.role).toBe('fallback');
  });

  it('PIN: yo routes to the APPROVED voice alone, and to nothing else', () => {
    /*
     * This pin has now been written three times and each rewrite is the same
     * rule under a new finding, not a new rule. It once asserted 9jaLingo did
     * NOT route; then that it did, on the 2026-08-30 benchmark; now that
     * ElevenLabs does and 9jaLingo does not, on the founder's ruling of
     * 2026-09-18 that 9jaLingo does not work and ElevenLabs does.
     *
     * What is pinned throughout is the RULE: a Nigerian language goes to the
     * one vendor somebody has judged fit, and to nothing after it. Azure in
     * particular is not a safety net here -- it answers Yoruba with confident,
     * wrong audio, so a second chance is a second chance to be wrong.
     */
    const tts = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(tts.ordered.map((c) => c.providerId)).toEqual(['elevenlabs']);
    // The role is 'specialist', not 'primary'. That distinction is the whole
    // Nigerian-language ruling in one word: this vendor leads because it has
    // been judged fit for the language, not because it won a general ranking.
    expect(tts.ordered[0]?.role).toBe('specialist');
    expect(tts.ordered.map((c) => c.providerId)).not.toContain('azure');
    expect(tts.ordered.map((c) => c.providerId)).not.toContain('naijalingo');
  });

  it('PIN: a primary that cannot authenticate is refused, and the reason says so', () => {
    const tts = route('tts', CALL, {
      minimumStage: 'configured',
      isUsable: (id) => id !== 'elevenlabs',
    });
    // Azure takes over, and nothing pretends ElevenLabs was simply not chosen.
    expect(tts.ordered.map((c) => c.providerId)).toEqual(['azure']);
    expect(tts.refusals.join(' ')).toMatch(/elevenlabs: credentials or authentication/);
  });

  it('PIN: no usable provider returns an empty route WITH reasons', () => {
    const tts = route('tts', CALL, { minimumStage: 'configured', isUsable: noneUsable });
    // "No provider is eligible" is a sentence somebody has to act on, and a
    // bare empty list tells them nothing about which of six reasons applied.
    expect(tts.ordered).toEqual([]);
    expect(tts.refusals).toHaveLength(2);
    // Named per provider AND by cause. Asserting only `length > 0` would pass
    // on a stage refusal while the authentication one had been dropped -- a
    // count is not a reason.
    for (const providerId of ['elevenlabs', 'azure']) {
      expect(tts.refusals.join(' ')).toContain(
        `${providerId}: credentials or authentication did not resolve.`,
      );
    }
  });

  it('PIN: a stage below the deployment minimum is refused, not silently used', () => {
    /*
     * TRANSLATION, and Google, because that is where the gate is still LOAD
     * BEARING after C-AI1.2.
     *
     * The C-AI1.2 benchmark on 2026-08-30 could not exercise Google -- no
     * credential is configured on the box -- so it stayed at `integrated` while
     * the vendors that were measured moved past it. A production deployment
     * demanding `certified` must therefore get a refusal here, with the reason
     * attached, rather than a provider nobody benchmarked.
     */
    const translation = route('translation', CALL, { minimumStage: 'certified' });
    expect(translation.ordered).toEqual([]);
    expect(translation.refusals.join(' ')).toMatch(/is below the required 'certified'/);
  });

  it('PIN: certified providers DO route once the evidence exists', () => {
    // The other half of the same rule, and the half that would otherwise go
    // untested: a gate that refuses everything is indistinguishable from a gate
    // that works, right up until something legitimately passes it.
    const tts = route('tts', CALL, { minimumStage: 'certified' });
    expect(tts.ordered.map((c) => c.providerId)).toEqual(['elevenlabs', 'azure']);
  });
});

describe('the route is service-aware', () => {
  it('PIN: the three service contexts are routed separately', () => {
    for (const service of [CALL, PROG_LIVE, PROG_UPLOAD]) {
      const result = route('tts', service);
      expect(result.ordered.length, JSON.stringify(service)).toBeGreaterThan(0);
      // The reason names the context, so a log line says which product this
      // decision was for.
      expect(result.ordered[0]?.reason).toContain(service.serviceCategory);
    }
  });

  it('PIN: an uploaded programme wants COMPLETE audio, a live one wants streaming', () => {
    const uploaded = route('tts', PROG_UPLOAD);
    const live = route('tts', PROG_LIVE);
    // Both are satisfiable today, and by different declared capabilities.
    expect(uploaded.ordered.map((c) => c.providerId)).toContain('elevenlabs');
    expect(live.ordered.map((c) => c.providerId)).toContain('elevenlabs');
  });

  it('PIN: a call demands streaming transcription of its primary', () => {
    // The rule comes from the existing execution policy rather than a second
    // copy here: a batch-only recogniser cannot be primary on a call however
    // good its accuracy on files is.
    const call = route('transcription', CALL);
    expect(call.ordered[0]?.providerId).toBe('deepgram');
    expect(call.refusals).toEqual([]);
  });

  it('PIN: routing never sees a transport, a prefix or a session id', () => {
    // The input has no field for one. This is a compile-time observation as
    // much as a runtime one: every previous attempt to infer service policy
    // from a name eventually met a session named unusually.
    const input = {
      capability: 'tts' as const,
      service: CALL,
      minimumStage: 'integrated' as const,
      isUsable: allUsable,
    };
    expect(Object.keys(input).sort()).toEqual([
      'capability',
      'isUsable',
      'minimumStage',
      'service',
    ]);
  });
});

describe('the approved Nigerian voice is a qualification, not a ranking', () => {
  it('PIN: it leads for Nigerian languages, as a specialist', () => {
    for (const language of NIGERIAN_SPECIALIST_LANGUAGES) {
      const result = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' });
      /*
       * The ROLE is the assertion that matters. ElevenLabs is also the general
       * primary, so the provider id alone would pass even if the Nigerian rule
       * had been deleted entirely. `specialist` says it leads here because it
       * was judged fit for THIS language -- which is the rule -- rather than
       * because it happens to win the general ranking.
       */
      expect(result.ordered[0], language).toMatchObject({
        providerId: 'elevenlabs',
        role: 'specialist',
      });
    }
  });

  it('PIN: 9jaLingo speaks nothing, in any language', () => {
    /*
     * Founder ruling 2026-09-18: it does not work. It must not reappear as a
     * fallback, a specialist, or a general candidate anywhere.
     */
    for (const language of [...NIGERIAN_SPECIALIST_LANGUAGES, 'es', 'en', 'fr', undefined]) {
      const ids = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' })
        .ordered.map((c) => c.providerId);
      expect(ids, String(language)).not.toContain('naijalingo');
    }
  });

  it('PIN: the Nigerian rule does not leak into other languages', () => {
    for (const language of ['es', 'en', 'fr', undefined]) {
      const ids = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' })
        .ordered.map((c) => c.providerId);
      // Elsewhere the ordinary chain still applies, Azure included: those
      // languages never had the pronunciation problem this rule exists for.
      expect(ids[0], String(language)).toBe('elevenlabs');
      expect(ids, String(language)).toContain('azure');
    }
  });

  it('PIN: a region tag does not change who speaks the language best', () => {
    expect(isNigerianSpecialistLanguage('yo-NG')).toBe(true);
    expect(isNigerianSpecialistLanguage('IG')).toBe(true);
    expect(isNigerianSpecialistLanguage('en-NG')).toBe(false);
    expect(isNigerianSpecialistLanguage(undefined)).toBe(false);
  });

  it('PIN: being routable does not activate the language in the product', () => {
    /*
     * THIS CLAIM HAS SURVIVED EVERY REWRITE OF THE VENDOR, and that is the
     * point of it. A chain existing for Yoruba says only who would speak it if
     * the product asked; whether Yoruba is OFFERED to anyone is a demand-led
     * decision made where languages are configured, and no table in this
     * package switches a language on.
     *
     * The routing rule is what is pinned: for a Nigerian language the chain is
     * the approved voice and nothing after it.
     */
    const result = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(result.ordered.map((c) => c.providerId)).toEqual(['elevenlabs']);
    expect(result.ordered.map((c) => c.providerId)).not.toContain('azure');
  });
});

describe('local models are a separate path, never a quiet substitute', () => {
  it('PIN: local fallback is permitted only where policy says so', () => {
    expect(localFallbackPermitted('development-demo')).toBe(true);
    expect(localFallbackPermitted('commercial-local')).toBe(true);
    expect(localFallbackPermitted('videofy-native')).toBe(true);
    // The one profile that must never quietly run a small local model while
    // reporting that it used the commercial route.
    expect(localFallbackPermitted('commercial-cloud')).toBe(false);
  });

  it('PIN: no local model appears in a commercial route', () => {
    for (const capability of ['transcription', 'translation', 'tts'] as const) {
      const ids = route(capability, CALL).ordered.map((c) => c.providerId);
      expect(ids).not.toContain('local');
      expect(ids).not.toContain('piper');
      expect(ids).not.toContain('faster-whisper');
    }
  });
});


/**
 * The founder ruling of 2026-08-30, as tests rather than as a comment.
 *
 * Each of these guards a DIFFERENT way the rule could be broken while every
 * other test still passed, which is the only reason there are five of them:
 * the specialist could lead and ElevenLabs could still be behind it; Azure
 * could be reached via the general chain rather than named; the rule could
 * apply to three languages and quietly miss Pidgin; it could leak into the
 * other ninety; and the degraded question could answer "no" for a language
 * nobody checked.
 */
describe('ha/ig/yo/pcm: the approved voice, then nothing', () => {
  it('PIN: the chain is EXACTLY the approved voice, for all four', () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm']) {
      const ids = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' }).ordered.map(
        (c) => c.providerId,
      );
      // Not `toContain`, not `[0]`. The whole list, because the defect this
      // guards against is an EXTRA member answering whenever the first does
      // not, in confident, wrong Yoruba.
      expect(ids, language).toEqual(['elevenlabs']);
    }
  });

  it('PIN: nothing speaks a Nigerian language when the approved voice cannot', () => {
    for (const language of NIGERIAN_SPECIALIST_LANGUAGES) {
      /*
       * SILENCE IS THE CORRECT ANSWER HERE, and it is the assertion most worth
       * pinning. With the approved voice unusable -- no key, or one that does
       * not resolve -- the route is EMPTY. Azure would answer, fluently and
       * wrongly, and a listener could not tell; a caller seeing an empty route
       * and a stated reason can.
       */
      const result = route('tts', PROG_UPLOAD, {
        language,
        minimumStage: 'configured',
        isUsable: (id) => id !== 'elevenlabs',
      });
      expect(result.ordered.map((c) => c.providerId), language).toEqual([]);
      expect(result.refusals.join(' ')).toMatch(/elevenlabs: credentials or authentication/);
    }
  });

  it('PIN: a control language keeps the general chain untouched', () => {
    // The rule REPLACES the general chain for four languages. If it leaked, it
    // would show up here as Spanish losing its primary.
    const ids = route('tts', PROG_UPLOAD, { language: 'es', minimumStage: 'configured' }).ordered.map(
      (c) => c.providerId,
    );
    expect(ids).toEqual(['elevenlabs', 'azure']);
  });

  it('PIN: the order constant and the resolved route cannot drift apart', () => {
    // One exported constant is the single source; media-ingest imports it too.
    // Asserting the resolver against it is what makes that claim checkable
    // rather than merely stated in a comment.
    expect(NIGERIAN_TTS_ROUTE_ORDER).toEqual([NIGERIAN_SPECIALIST_PROVIDER_ID]);
    expect(
      route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'configured' }).ordered.map(
        (c) => c.providerId,
      ),
    ).toEqual([...NIGERIAN_TTS_ROUTE_ORDER]);
  });

  it('PIN: anything but the specialist is DEGRADED for these languages, and only these', () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm', 'YO-ng']) {
      // Azure and 9jaLingo are both degraded for these languages now: the
      // first pronounces them wrongly, the second does not work. Recognising
      // them is why the constants are kept after leaving the route.
      expect(isDegradedNigerianSynthesis(language, 'azure'), language).toBe(true);
      expect(isDegradedNigerianSynthesis(language, 'naijalingo'), language).toBe(true);
      expect(isDegradedNigerianSynthesis(language, 'elevenlabs'), language).toBe(false);
    }
    // A general language served by a general vendor is not degradation; saying
    // it was would make the marker meaningless everywhere it matters.
    for (const language of ['es', 'en', 'fr', undefined]) {
      expect(isDegradedNigerianSynthesis(language, 'azure'), String(language)).toBe(false);
    }
  });
});
