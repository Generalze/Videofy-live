/** @author masterzee001 */
/**
 * Which provider serves which capability, for which service.
 *
 * PLATFORM-OWNED AND SERVICE-AWARE, which are two separate claims:
 *
 *   platform-owned   the order is decided here, from the registry's recorded
 *                    capabilities and stages. No adapter votes for itself, and
 *                    no vendor's availability changes who is primary.
 *   service-aware    `call/live`, `programme/live` and `programme/uploaded`
 *                    genuinely want different providers, because they want
 *                    different execution modes. A batch-only recogniser is
 *                    excellent for an uploaded programme and cannot be primary
 *                    on a call at all.
 *
 * NOTHING IS INFERRED FROM TRANSPORT. Not from a `call_` prefix, not from a SIP
 * Call-ID, not from `sourceKind`, not from whether the audio arrived on a
 * socket. Every one of those has been tried somewhere in this repository and
 * every one of them eventually gave the wrong answer to a session that was
 * named unusually. The service context is passed in because whoever created the
 * session knew it, and passing it is cheaper than deducing it wrongly.
 *
 * THE FIRST-DEPLOYMENT ROUTE, stated plainly:
 *
 *     transcription  Deepgram      primary
 *     translation    Google        primary
 *     tts            ElevenLabs    primary,  Azure fallback
 *     Nigerian tts   ElevenLabs    approved (2026-09-18); nothing else
 *     local models   degraded      only where the profile permits it
 *
 * A specialist is not a better provider; it is a provider for a case the
 * primary does not serve.
 *
 * THE NIGERIAN CHAIN REPLACES THE GENERAL ONE; it does not sit on top of it.
 * A founder ruling of 2026-08-30, and still right for the reason it was made:
 * a vendor returning HTTP 200 with fluent-sounding, wrong Yoruba is not extra
 * safety behind an approved voice, it is another chance to serve confident
 * nonsense to somebody who cannot tell.
 *
 * WHO IS APPROVED CHANGED ON 2026-09-18. The chain was 9jaLingo then Azure,
 * with ElevenLabs deliberately excluded on the 2026-08-26 listening test. The
 * founder's finding since is that 9jaLingo does not work and ElevenLabs does,
 * so ElevenLabs is the approved voice and the chain is one entry long. Azure
 * is still DEFINED and still recognised as degraded -- it is simply no longer
 * reached, because a fallback nobody approved is the thing this rule exists to
 * refuse.
 *
 * THIS FILE IS THE SINGLE SOURCE OF THAT RULE. `media-ingest`'s
 * `live-provider-wiring` imports the constants below rather than restating
 * them -- it already depends on this package -- so the language list and the
 * fallback order cannot drift apart between the planner and the live path.
 */
import {
  capabilitySupported,
  executionPolicyFor,
  serviceContextKey,
  type ProviderServiceContext,
} from './execution-policy.js';
import { findCommercialProvider } from './commercial-providers.js';
import { stageAtLeast, type ProviderIntegrationStage } from './provider-runtime.js';

export type RoutedCapability = 'transcription' | 'translation' | 'tts';

export type RouteRole = 'primary' | 'fallback' | 'specialist' | 'degraded';

export interface RouteCandidate {
  readonly providerId: string;
  readonly role: RouteRole;
  readonly reason: string;
}

export interface RouteResult {
  /** Best first. Empty means nothing is usable, and `refusals` says why. */
  readonly ordered: readonly RouteCandidate[];
  /** Every provider considered and rejected, with the reason. Never silent. */
  readonly refusals: readonly string[];
}

/**
 * Languages 9jaLingo is a specialist FOR.
 *
 * Recorded from its documented `lang` values. Being on this list makes
 * 9jaLingo the preferred TTS for that language; it does NOT activate the
 * language in the product. Which languages a deployment offers is a demand-led
 * commercial decision, made where languages are configured, not here.
 */
export const NIGERIAN_SPECIALIST_LANGUAGES: readonly string[] = ['ha', 'ig', 'yo', 'pcm'];

/**
 * The APPROVED voice for those four languages.
 *
 * ELEVENLABS, BY FOUNDER RULING OF 2026-09-18, which reverses the 2026-08-30
 * arrangement where 9jaLingo was the specialist and ElevenLabs was
 * deliberately excluded on the 2026-08-26 listening test. The founder's
 * finding is plain: 9jaLingo does not work and ElevenLabs does. That is a
 * statement about the product, and it outranks the earlier test.
 *
 * THE CONCEPT AROUND IT IS UNCHANGED AND STILL LOAD-BEARING. These four
 * languages are decided by QUALIFICATION -- by somebody judging the output
 * fit -- and never by whether a vendor returned HTTP 200, because both
 * general vendors return 200 with fluent, wrongly-pronounced Yoruba that only
 * a speaker can detect. What changed is WHICH vendor is qualified, not the
 * rule that one has to be.
 */
export const NIGERIAN_SPECIALIST_PROVIDER_ID = 'elevenlabs';

/**
 * The vendor that must always be RECOGNISED for these languages, and never
 * routed to.
 *
 * Azure returns HTTP 200 and plausible audio for Hausa, Igbo and Yoruba, and
 * pronounces them wrongly. It was the one named fallback under the 2026-08-30
 * ruling; since 2026-09-18 the chain is ElevenLabs alone and this is reached
 * by nothing.
 *
 * IT IS KEPT, and keeping it is the point: `isDegradedNigerianSynthesis` has
 * to be able to say that audio from this vendor is degraded if it ever appears
 * by some other path. Deleting the constant would remove the ability to
 * recognise the failure, not the possibility of it.
 */
export const NIGERIAN_FALLBACK_PROVIDER_ID = 'azure';

/**
 * Best first. The whole chain for ha/ig/yo/pcm, and nothing after it.
 *
 * ONE ENTRY SINCE 2026-09-18. Azure stays defined below and stays recognised
 * as degraded, but it is no longer reached: the founder's ruling is that
 * ElevenLabs is the only voice that passes for these languages. Silence is the
 * honest outcome when it cannot answer, because the alternative is audio that
 * plays perfectly, pronounces the language wrongly, and reports success to
 * every signal a server has.
 */
export const NIGERIAN_TTS_ROUTE_ORDER: readonly string[] = [
  NIGERIAN_SPECIALIST_PROVIDER_ID,
];

/**
 * Was this Nigerian-language audio produced by something other than the
 * specialist?
 *
 * The question every surface that reports synthesis has to be able to ask.
 * Answering it wrongly is the failure this whole wave exists to prevent: audio
 * plays either way, every server signal is green, and only a speaker of the
 * language can hear that the wrong vendor answered.
 */
export function isDegradedNigerianSynthesis(
  language: string | undefined,
  providerId: string,
): boolean {
  if (!isNigerianSpecialistLanguage(language)) return false;
  return providerId !== NIGERIAN_SPECIALIST_PROVIDER_ID;
}

export function isNigerianSpecialistLanguage(language: string | undefined): boolean {
  if (language === undefined) return false;
  // `yo-NG` and `yo` are the same language for this purpose; the region does
  // not change who speaks it best.
  const base = language.toLowerCase().split(/[-_]/)[0] ?? '';
  return NIGERIAN_SPECIALIST_LANGUAGES.includes(base);
}

interface RoutePlanEntry {
  readonly providerId: string;
  readonly role: RouteRole;
}

/** The declared order per capability, before any provider is checked. */
const ROUTE_PLAN: Record<RoutedCapability, readonly RoutePlanEntry[]> = {
  transcription: [{ providerId: 'deepgram', role: 'primary' }],
  translation: [{ providerId: 'google-cloud', role: 'primary' }],
  tts: [
    { providerId: 'elevenlabs', role: 'primary' },
    { providerId: 'azure', role: 'fallback' },
  ],
};

export interface CommercialRouteInput {
  readonly capability: RoutedCapability;
  readonly service: ProviderServiceContext;
  /** The language being PRODUCED (tts) or consumed (transcription). */
  readonly language?: string | undefined;
  /** Minimum stage this deployment accepts. */
  readonly minimumStage: ProviderIntegrationStage;
  /** Providers whose credentials/auth actually resolved. */
  readonly isUsable: (providerId: string) => boolean;
}

/**
 * The ordered candidates for one capability in one service context.
 *
 * Refusals are returned rather than logged, because "no provider is eligible"
 * is a sentence somebody has to act on and a bare empty list tells them
 * nothing about which of six reasons applied.
 */
export function resolveCommercialRoute(input: CommercialRouteInput): RouteResult {
  const ordered: RouteCandidate[] = [];
  const refusals: string[] = [];
  const policy = executionPolicyFor(input.service);
  const where = serviceContextKey(input.service);

  /*
   * REPLACED, NOT PREPENDED, for the four Nigerian languages.
   *
   * Leaving the general chain in place behind a specialist reads as caution
   * and is the opposite: a general vendor answers those languages with
   * confident, wrong audio, so a second entry buys a second wrong rendering
   * rather than a second chance.
   *
   * BUILT FROM `NIGERIAN_TTS_ROUTE_ORDER`, not restated. This was a hardwired
   * two-entry array beside the exported constant, so the constant described
   * the rule and the code applied its own copy -- two sources for one
   * decision, exactly the drift the constant exists to prevent. The first
   * entry leads as `specialist`, meaning "judged fit for this language",
   * which is the whole ruling in one word; anything after it is a fallback.
   */
  const plan: RoutePlanEntry[] =
    input.capability === 'tts' && isNigerianSpecialistLanguage(input.language)
      ? NIGERIAN_TTS_ROUTE_ORDER.map((providerId, index) => ({
          providerId,
          role: index === 0 ? ('specialist' as const) : ('fallback' as const),
        }))
      : [...ROUTE_PLAN[input.capability]];

  for (const entry of plan) {
    const provider = findCommercialProvider(entry.providerId);
    if (provider === undefined) {
      refusals.push(`${entry.providerId}: not registered.`);
      continue;
    }
    if (!stageAtLeast(provider.integrationStage, input.minimumStage)) {
      refusals.push(
        `${entry.providerId}: stage '${provider.integrationStage}' is below the required ` +
          `'${input.minimumStage}'.`,
      );
      continue;
    }
    if (!input.isUsable(entry.providerId)) {
      refusals.push(`${entry.providerId}: credentials or authentication did not resolve.`);
      continue;
    }

    const capabilities = provider.capabilities[input.capability];
    if (capabilities === undefined) {
      refusals.push(`${entry.providerId}: declares no ${input.capability} capability.`);
      continue;
    }

    // EXECUTION MODE, from the existing policy rather than a second copy of it.
    // `call/live` REQUIRES streaming transcription: a batch-only recogniser
    // cannot be primary there however good its accuracy on files is.
    if (input.capability === 'transcription' && entry.role === 'primary') {
      const transcription = capabilities as { streaming?: string; batch?: string };
      const wantsStreaming = policy.primaryTranscriptionMode === 'streaming';
      const supported = capabilitySupported(
        (wantsStreaming ? transcription.streaming : transcription.batch) as
          | 'yes'
          | 'no'
          | 'unverified'
          | undefined,
      );
      if (!supported && policy.primaryStrength === 'required') {
        refusals.push(
          `${entry.providerId}: ${where} requires ${policy.primaryTranscriptionMode} ` +
            'transcription for its primary, which this provider does not declare.',
        );
        continue;
      }
    }

    if (input.capability === 'tts') {
      const tts = capabilities as { streamingAudio?: string; completeAudio?: string };
      const live = input.service.mediaMode === 'live';
      const declared = live ? tts.streamingAudio : tts.completeAudio;
      if (!capabilitySupported(declared as 'yes' | 'no' | 'unverified' | undefined)) {
        refusals.push(
          `${entry.providerId}: ${where} needs ${live ? 'streaming' : 'complete'} audio, ` +
            'which this provider does not declare.',
        );
        continue;
      }
    }

    ordered.push({
      providerId: entry.providerId,
      role: entry.role,
      reason:
        entry.role === 'specialist'
          ? `specialist for ${String(input.language)} in ${where}`
          : `${entry.role} for ${input.capability} in ${where}`,
    });
  }

  return { ordered, refusals };
}

/**
 * May a local model serve this capability?
 *
 * Separate from the commercial route on purpose. Local models are a
 * DEVELOPMENT and DEGRADED path, and letting them appear in the same ordered
 * list as commercial providers is how a deployment that meant to use Deepgram
 * quietly runs a small local model instead and reports success.
 */
export function localFallbackPermitted(profile: string): boolean {
  return profile === 'development-demo' || profile === 'commercial-local' || profile === 'videofy-native';
}
