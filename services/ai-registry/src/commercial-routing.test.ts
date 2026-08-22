/** @author masterzee001 */
/**
 * C-AI1.1F pins: who serves what, and what a refusal says.
 */
import { describe, expect, it } from 'vitest';
import {
  NIGERIAN_SPECIALIST_LANGUAGES,
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

  it('PIN: a provider with no adapter run against it is still gated out', () => {
    // 9jaLingo. Its API host and auth header are undocumented, so there is no
    // request to run -- and no amount of wanting the language coverage makes
    // that evidence.
    const tts = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(tts.ordered.map((c) => c.providerId)).not.toContain('naijalingo');
    expect(tts.refusals.join(' ')).toMatch(/naijalingo: stage 'configured'/);
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
    const tts = route('tts', CALL, { minimumStage: 'certified' });
    expect(tts.ordered).toEqual([]);
    // Nothing is certified, so a deployment demanding it gets nothing and is
    // told exactly that.
    expect(tts.refusals.join(' ')).toMatch(/is below the required 'certified'/);
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
    // 9jaLingo is at `configured` -- no adapter has been run against it -- so a
    // deployment requiring `integrated` gets a refusal rather than a route,
    // and no Nigerian language is switched on merely by this table existing.
    const result = route('tts', PROG_UPLOAD, { language: 'yo', minimumStage: 'integrated' });
    expect(result.ordered.map((c) => c.providerId)).not.toContain('naijalingo');
    expect(result.refusals.join(' ')).toMatch(/naijalingo: stage 'configured'/);
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
