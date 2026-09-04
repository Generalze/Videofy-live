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

  it('PIN: 9jaLingo now routes for yo, and ONLY because a run earned it', () => {
    /*
     * This test used to assert the opposite, and both readings are the same
     * rule seen at two moments. 9jaLingo sat at `configured` while no key
     * existed and no request had ever been made; the C-AI1.2 benchmark on
     * 2026-08-30 ran five real Yoruba syntheses through the deployed adapter,
     * and the stage moved BECAUSE OF THAT and nothing else.
     *
     * What is still pinned is the ordering the founder ruled: for a Nigerian
     * language the chain is the specialist, then AZURE, and nothing else --
     * ElevenLabs is absent by design because it answers Yoruba with confident,
     * wrong audio.
     */
    const tts = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(tts.ordered.map((c) => c.providerId)).toEqual(['naijalingo', 'azure']);
    // The role is 'specialist', not 'primary'. That distinction is the whole
    // Nigerian-language ruling in one word: this vendor leads because it is the
    // one that speaks the language, not because it won a general ranking.
    expect(tts.ordered[0]?.role).toBe('specialist');
    expect(tts.ordered.map((c) => c.providerId)).not.toContain('elevenlabs');
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

describe('9jaLingo is a specialist, which is not the same as better', () => {
  it('PIN: it leads for Nigerian languages only', () => {
    for (const language of NIGERIAN_SPECIALIST_LANGUAGES) {
      // At `configured`, so the ORDERING rule is visible. The separate pin
      // below proves that today's `integrated` requirement excludes it.
      const result = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' });
      expect(result.ordered[0], language).toMatchObject({
        providerId: 'naijalingo',
        role: 'specialist',
      });
    }
  });

  it('PIN: it does not appear at all for other languages', () => {
    for (const language of ['es', 'en', 'fr', undefined]) {
      const ids = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' })
        .ordered.map((c) => c.providerId);
      // A specialist that outranked the primary everywhere would just be a
      // different primary.
      expect(ids, String(language)).not.toContain('naijalingo');
      expect(ids[0], String(language)).toBe('elevenlabs');
    }
  });

  it('PIN: a region tag does not change who speaks the language best', () => {
    expect(isNigerianSpecialistLanguage('yo-NG')).toBe(true);
    expect(isNigerianSpecialistLanguage('IG')).toBe(true);
    expect(isNigerianSpecialistLanguage('en-NG')).toBe(false);
    expect(isNigerianSpecialistLanguage(undefined)).toBe(false);
  });

  it('PIN: being a specialist does not activate the language in the product', () => {
    /*
     * THE CLAIM THIS TEST MAKES SURVIVED THE STAGE CHANGE, and it is worth
     * saying why. 9jaLingo is now `certified` on 2026-08-30 evidence, so it
     * routes -- but ROUTING IS NOT ACTIVATION. That a chain exists for Yoruba
     * says only who would speak it if the product asked; whether Yoruba is
     * offered to anyone stays a demand-led product decision made elsewhere,
     * and no table in this package switches a language on.
     *
     * The specialist rule itself is what is pinned: the chain is the
     * specialist then Azure, and ElevenLabs is never in it.
     */
    const result = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(result.ordered.map((c) => c.providerId)).toEqual(['naijalingo', 'azure']);
    expect(result.ordered.map((c) => c.providerId)).not.toContain('elevenlabs');
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
describe('ha/ig/yo/pcm: 9jaLingo, then Azure, then nothing', () => {
  it('PIN: the chain is EXACTLY the specialist then Azure, for all four', () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm']) {
      const ids = route('tts', PROG_UPLOAD, { language, minimumStage: 'configured' }).ordered.map(
        (c) => c.providerId,
      );
      // Not `toContain`, not `[0]`. The whole list, because the defect this
      // replaces was an EXTRA member: ElevenLabs sat third and answered
      // whenever the first two did not, in confident, wrong Yoruba.
      expect(ids, language).toEqual(['naijalingo', 'azure']);
    }
  });

  it('PIN: ElevenLabs never speaks a Nigerian language, however the chain fails', () => {
    for (const language of NIGERIAN_SPECIALIST_LANGUAGES) {
      // Even with the specialist unusable -- no key, or a key that does not
      // resolve -- the answer is Azure alone. "One more vendor behind the
      // fallback" is not extra safety here; it is a third chance to serve
      // fluent nonsense.
      const result = route('tts', PROG_UPLOAD, {
        language,
        minimumStage: 'configured',
        isUsable: (id) => id !== 'naijalingo',
      });
      expect(result.ordered.map((c) => c.providerId), language).toEqual(['azure']);
      expect(result.refusals.join(' ')).toMatch(/naijalingo: credentials or authentication/);
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
    expect(NIGERIAN_TTS_ROUTE_ORDER).toEqual([
      NIGERIAN_SPECIALIST_PROVIDER_ID,
      NIGERIAN_FALLBACK_PROVIDER_ID,
    ]);
    expect(
      route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'configured' }).ordered.map(
        (c) => c.providerId,
      ),
    ).toEqual([...NIGERIAN_TTS_ROUTE_ORDER]);
  });

  it('PIN: anything but the specialist is DEGRADED for these languages, and only these', () => {
    for (const language of ['ha', 'ig', 'yo', 'pcm', 'YO-ng']) {
      expect(isDegradedNigerianSynthesis(language, 'azure'), language).toBe(true);
      expect(isDegradedNigerianSynthesis(language, 'elevenlabs'), language).toBe(true);
      expect(isDegradedNigerianSynthesis(language, 'naijalingo'), language).toBe(false);
    }
    // A general language served by a general vendor is not degradation; saying
    // it was would make the marker meaningless everywhere it matters.
    for (const language of ['es', 'en', 'fr', undefined]) {
      expect(isDegradedNigerianSynthesis(language, 'azure'), String(language)).toBe(false);
    }
  });
});
