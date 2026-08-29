/** @author masterzee001 */
/**
 * What the LIVE translation chain can honestly do for each catalogue language.
 *
 * Why this exists: three surfaces were each answering "can we do Yoruba?" from
 * a different list -- media-ingest's TARGET_LANGUAGE_CANDIDATES, the env CSVs
 * on the staging box, and the registry's per-model `verifiedLanguages` -- and
 * none of them distinguished a language a vendor LISTS from one that has been
 * heard working. The 2026-08-26 finding made the gap concrete: ElevenLabs and
 * Azure return HTTP 200 and plausible audio for Yoruba, Hausa and Igbo, and
 * none of it is intelligible. Every server-side signal was green. So the
 * answer here is built from evidence GRADES, not from "does the call succeed".
 *
 * The chain this describes is the one that actually runs today:
 *
 *   STT  Deepgram (nova-3 / flux)
 *   MT   opus-mt, self-hosted Marian models, one model per direction
 *   TTS  ElevenLabs then Azure, with 9jaLingo in front for ha/ig/yo/pcm
 *
 * Per stage a language earns one of four evidence levels, and the row's state
 * is the WEAKEST stage:
 *
 *   live      a `liveObservations` entry names the language        -> qualified
 *   declared  the model's `verifiedLanguages` (documentation read) -> available
 *   claimed   `claimedLanguages`, or any provider still at the
 *             `configured` stage, whose adapter has never been run -> limited
 *   none      no provider at all                                  -> unavailable
 *
 * Every catalogue language gets a row, `unavailable` ones included, so a picker
 * can SHOW the language and refuse to SELECT it rather than pretend it does
 * not exist. The three stage booleans are reported separately because a
 * language may be a usable target (MT + TTS) without being a usable source
 * (STT); the state answers the conservative question, the booleans answer the
 * specific one.
 *
 * DELIBERATELY NOT HERE: per-grade routing. The tariff has two grades that
 * differ only in synthesis vendor (standard = Azure, premium = ElevenLabs),
 * but the live path does not yet select synthesis by grade -- it runs a fixed
 * fallback chain. Reporting two columns would describe a router that does not
 * exist. `grade` is accepted so callers can pass it now, and it changes
 * nothing until live-provider-wiring selects by grade; the seam is marked.
 *
 * The opus-mt table is a MIRROR of media-ingest's config defaults
 * (DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES, DEFAULT_OPUS_MT_LANGUAGE_MODELS).
 * This library cannot import a service, so the values are copied and named as
 * copies. A change to either belongs in both until media-ingest consumes the
 * registry directly.
 */
import { LANGUAGE_CATALOGUE, baseSubtag } from '@videofy-live/language-catalogue';
import { COMMERCIAL_PROVIDERS, type CommercialProvider } from './commercial-providers.js';

export type LanguageCapabilityState = 'available' | 'qualified' | 'limited' | 'unavailable';

/** The two tariff grades. Today they resolve identically; see the header. */
export type SynthesisGrade = 'standard' | 'premium';

export type CapabilityStage = 'stt' | 'mt' | 'tts';

export interface LanguageCapability {
  readonly code: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly state: LanguageCapabilityState;
  readonly stt: boolean;
  readonly mt: boolean;
  readonly tts: boolean;
  readonly providers: { readonly stt?: string; readonly mt?: string; readonly tts?: string };
  /** Present whenever the state is below `qualified`; names the stage(s) at fault. */
  readonly reason?: string;
}

export interface ResolveLanguageCapabilitiesInput {
  /**
   * SEAM: accepted and ignored. When live-provider-wiring selects synthesis by
   * grade, this is where the TTS stage narrows to that grade's vendor. Until
   * then both grades return the same rows, which is the truth of the live path.
   */
  readonly grade?: SynthesisGrade;
  /** Injectable for tests; defaults to the registry. The function reads nothing else. */
  readonly providers?: readonly CommercialProvider[];
}

/** Ordered weakest to strongest so `Math.min` over indices picks the row's state. */
const EVIDENCE_ORDER = ['none', 'claimed', 'declared', 'live'] as const;
type Evidence = (typeof EVIDENCE_ORDER)[number];

const STATE_BY_EVIDENCE: Record<Evidence, LanguageCapabilityState> = {
  none: 'unavailable',
  claimed: 'limited',
  declared: 'available',
  live: 'qualified',
};

/** Which registry providers serve which stage of the live chain, in chain order. */
const LIVE_CHAIN: Readonly<Record<'stt' | 'tts', readonly string[]>> = {
  stt: ['deepgram'],
  // 9jaLingo first: the live synthesis router puts the specialist in front of
  // the general chain for its four languages. Order only breaks evidence ties.
  tts: ['naijalingo', 'elevenlabs', 'azure'],
};

export const OPUS_MT_PROVIDER_ID = 'opus-mt';

/**
 * Mirror of DEFAULT_OPUS_MT_LANGUAGE_MODELS: languages with an explicit,
 * configured Marian route. `declared`, not `live` -- staging has reported these
 * pairs resolvable, but no observation in the registry records a translation
 * in them, and this file only reads the registry.
 */
const OPUS_MT_ROUTED_LANGUAGES: readonly string[] = ['en', 'fr', 'es', 'pt'];

/**
 * Mirror of DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES minus the routed
 * set: listed as targets with no explicit model route, so the runtime must
 * find a Helsinki-NLP snapshot by convention. A convention is a claim.
 */
const OPUS_MT_CLAIMED_LANGUAGES: readonly string[] = ['de', 'it', 'ja', 'zh', 'ar', 'yo'];

const STAGE_LABEL: Record<CapabilityStage, string> = {
  stt: 'STT',
  mt: 'MT',
  tts: 'TTS',
};

interface StageResult {
  readonly evidence: Evidence;
  readonly provider?: string;
}

function strongest(a: Evidence, b: Evidence): Evidence {
  return EVIDENCE_ORDER.indexOf(a) >= EVIDENCE_ORDER.indexOf(b) ? a : b;
}

function listsLanguage(tags: readonly string[] | undefined, code: string): boolean {
  return (tags ?? []).some((tag) => baseSubtag(tag) === code);
}

function providerEvidence(
  provider: CommercialProvider,
  capability: 'transcription' | 'tts',
  code: string,
): Evidence {
  let best: Evidence = 'none';
  for (const model of provider.models) {
    const modelCapability = capability === 'tts' ? model.capabilities.tts : model.capabilities.transcription;
    if (modelCapability === undefined) continue;
    if (listsLanguage(model.claimedLanguages, code)) best = strongest(best, 'claimed');
    if (listsLanguage(model.verifiedLanguages, code)) {
      // A vendor whose adapter has never been run (`configured`) can only
      // claim: reading its page is not the same as hearing it speak.
      best = strongest(best, provider.integrationStage === 'configured' ? 'claimed' : 'declared');
    }
  }
  const observedLive = provider.liveObservations.some(
    (observation) =>
      observation.capability === capability &&
      listsLanguage(observation.languages, code) &&
      (observation.modelId === undefined ||
        provider.models.some((model) => model.modelId === observation.modelId)),
  );
  if (observedLive && best !== 'none') best = 'live';
  return best;
}

function resolveChainStage(
  stage: 'stt' | 'tts',
  code: string,
  providers: readonly CommercialProvider[],
): StageResult {
  const capability = stage === 'stt' ? 'transcription' : 'tts';
  let result: StageResult = { evidence: 'none' };
  for (const providerId of LIVE_CHAIN[stage]) {
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    if (provider === undefined) continue;
    const evidence = providerEvidence(provider, capability, code);
    // Strictly-greater keeps chain order as the tiebreak.
    if (EVIDENCE_ORDER.indexOf(evidence) > EVIDENCE_ORDER.indexOf(result.evidence)) {
      result = { evidence, provider: providerId };
    }
  }
  return result;
}

function resolveTranslationStage(code: string): StageResult {
  if (OPUS_MT_ROUTED_LANGUAGES.includes(code)) {
    return { evidence: 'declared', provider: OPUS_MT_PROVIDER_ID };
  }
  if (OPUS_MT_CLAIMED_LANGUAGES.includes(code)) {
    return { evidence: 'claimed', provider: OPUS_MT_PROVIDER_ID };
  }
  return { evidence: 'none' };
}

function describeShortfall(stages: Record<CapabilityStage, StageResult>, weakest: Evidence): string {
  const named = (Object.keys(stages) as CapabilityStage[])
    .filter((stage) => stages[stage].evidence === weakest)
    .map((stage) => STAGE_LABEL[stage])
    .join(', ');
  switch (weakest) {
    case 'none':
      return `No provider for ${named} on the live chain.`;
    case 'claimed':
      return `${named} rests on a vendor claim only: listed, never exercised here.`;
    case 'declared':
      return `${named} documented but no live observation names this language.`;
    case 'live':
      return '';
  }
}

/**
 * One row per catalogue language, in catalogue (rank) order. Pure: the result
 * depends only on the catalogue, the providers passed in (default: the
 * registry constant), and nothing on the clock or the environment.
 */
export function resolveLanguageCapabilities(
  input: ResolveLanguageCapabilitiesInput = {},
): readonly LanguageCapability[] {
  const providers = input.providers ?? COMMERCIAL_PROVIDERS;
  // `input.grade` is read here and nowhere else: the seam described in the
  // header. It is intentionally not folded into the result yet.
  void input.grade;

  return LANGUAGE_CATALOGUE.map((language) => {
    const stages: Record<CapabilityStage, StageResult> = {
      stt: resolveChainStage('stt', language.code, providers),
      mt: resolveTranslationStage(language.code),
      tts: resolveChainStage('tts', language.code, providers),
    };
    const weakest = (Object.values(stages) as StageResult[])
      .map((stage) => stage.evidence)
      .reduce((a, b) => (EVIDENCE_ORDER.indexOf(a) <= EVIDENCE_ORDER.indexOf(b) ? a : b));
    const reason = describeShortfall(stages, weakest);
    const providerNames: { stt?: string; mt?: string; tts?: string } = {};
    if (stages.stt.provider !== undefined) providerNames.stt = stages.stt.provider;
    if (stages.mt.provider !== undefined) providerNames.mt = stages.mt.provider;
    if (stages.tts.provider !== undefined) providerNames.tts = stages.tts.provider;
    return {
      code: language.code,
      englishName: language.englishName,
      nativeName: language.nativeName,
      state: STATE_BY_EVIDENCE[weakest],
      stt: stages.stt.evidence !== 'none',
      mt: stages.mt.evidence !== 'none',
      tts: stages.tts.evidence !== 'none',
      providers: providerNames,
      ...(reason === '' ? {} : { reason }),
    };
  });
}
