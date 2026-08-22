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
 *     Nigerian tts   9jaLingo      specialist, ahead of the primary
 *     local models   degraded      only where the profile permits it
 *
 * A specialist is not a better provider; it is a provider for a case the
 * primary does not serve. 9jaLingo goes ahead of ElevenLabs for Hausa, Igbo,
 * Yoruba and Nigerian Pidgin and behind it for everything else, which is what
 * "specialist" has to mean if it is to mean anything.
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

  const plan: RoutePlanEntry[] = [...ROUTE_PLAN[input.capability]];
  if (input.capability === 'tts' && isNigerianSpecialistLanguage(input.language)) {
    // Ahead of the primary, and only for these languages. A specialist that
    // outranked the primary everywhere would just be a different primary.
    plan.unshift({ providerId: 'naijalingo', role: 'specialist' });
  }

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
