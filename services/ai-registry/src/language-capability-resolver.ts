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
 * WHAT CHANGED ON 2026-08-30, and why it is the point of this file.
 *
 * The MT stage used to be answered by two hand-written arrays of ten and six
 * codes copied out of media-ingest's env defaults. Everything else in the
 * catalogue therefore reported `unavailable` -- not because no engine could
 * translate it, but because nobody had written it down here. The console could
 * not show breadth that genuinely exists, which is its own kind of lie. Every
 * stage now ENUMERATES over the providers and engines that declare a language
 * (commercial-providers.ts for vendor accounts, self-hosted-engines.ts for the
 * local models), so a language is enabled by a provider being SEEN, never by
 * anybody adding it to a list. Promotion by hardcoding is what this file
 * exists to make impossible.
 *
 * The chain this describes is the one that actually runs today:
 *
 *   STT  Deepgram (nova-3 / flux), then local faster-whisper
 *   MT   opus-mt / M2M-100, NLLB-200 as the configured fallback, Google last
 *   TTS  ElevenLabs then Azure -- EXCEPT ha/ig/yo/pcm, which are 9jaLingo then
 *        Azure and nothing else (commercial-routing.ts owns that rule)
 *
 * Per stage a language earns one of four evidence levels, and each reported
 * state is the WEAKEST stage that answers its question:
 *
 *   live      a `liveObservations` entry names the language        -> qualified
 *   declared  a model's `verifiedLanguages` (documentation read), or
 *             a local engine PINNED BY REVISION whose asset names it
 *                                                                  -> available
 *   claimed   `claimedLanguages`, a model card's published list, or
 *             any provider still at the `configured` stage whose
 *             adapter has never been run                            -> limited
 *   none      no provider at all                                   -> unavailable
 *
 * THREE STATES, NOT ONE, because "can we do this language" is three questions:
 *
 *   sourceState   STT + MT. Can somebody SPEAK it into a programme?
 *   targetState   MT + TTS. Can a programme be HEARD in it?
 *   state         all three, the conservative answer, unchanged for callers
 *                 that only ever wanted one word.
 *
 * A picker that gated its target list on the conservative state refused Igbo
 * as a target because no recogniser transcribes Igbo -- which has nothing to do
 * with whether a listener can hear Igbo. `captionsOnly` marks the rows that can
 * be translated and not spoken; they are a real product state, not a failure.
 *
 * THE SPECIALIST RULE. For ha/ig/yo/pcm a general vendor can never rise above
 * `claimed`, and when the specialist is not configured the row is flagged
 * `degraded` with a reason that says so in words. This is the founder-confirmed
 * finding of 2026-08-26 expressed as data: those vendors answer with confident,
 * wrong audio, so their HTTP 200 is not evidence about the language and must
 * never be allowed to read as availability. "Enable everything" is not
 * permission to claim everything is good.
 *
 * DELIBERATELY NOT HERE: per-grade routing. The tariff has two grades that
 * differ only in synthesis vendor (standard = Azure, premium = ElevenLabs),
 * but the live path does not yet select synthesis by grade -- it runs a fixed
 * fallback chain. Reporting two columns would describe a router that does not
 * exist. `grade` is accepted so callers can pass it now, and it changes
 * nothing until live-provider-wiring selects by grade; the seam is marked.
 */
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import { COMMERCIAL_PROVIDERS, type CommercialProvider } from './commercial-providers.js';
import {
  NIGERIAN_SPECIALIST_PROVIDER_ID,
  NIGERIAN_TTS_ROUTE_ORDER,
  isNigerianSpecialistLanguage,
} from './commercial-routing.js';
import {
  SELF_HOSTED_ENGINES,
  catalogueKeyOf,
  type CapabilityStage,
  type SelfHostedEngine,
} from './self-hosted-engines.js';

export type LanguageCapabilityState = 'available' | 'qualified' | 'limited' | 'unavailable';

/** The two tariff grades. Today they resolve identically; see the header. */
export type SynthesisGrade = 'standard' | 'premium';

export interface LanguageCapability {
  readonly code: string;
  readonly englishName: string;
  readonly nativeName: string;
  /** The conservative answer: the weakest of all three stages. */
  readonly state: LanguageCapabilityState;
  /** Speaking this language INTO a programme: STT and MT. */
  readonly sourceState: LanguageCapabilityState;
  /** Hearing a programme IN this language: MT and TTS. */
  readonly targetState: LanguageCapabilityState;
  /** Per stage, so a caller can ask its own question instead of ours. */
  readonly stageStates: Readonly<Record<CapabilityStage, LanguageCapabilityState>>;
  readonly stt: boolean;
  readonly mt: boolean;
  readonly tts: boolean;
  /** Translatable but not speakable: a real product state, not a failure. */
  readonly captionsOnly: boolean;
  readonly providers: { readonly stt?: string; readonly mt?: string; readonly tts?: string };
  /**
   * A specialist language being served by a general vendor. The audio plays,
   * every signal is green, and a speaker of the language can hear that it is
   * wrong. Surfaces MUST label it.
   */
  readonly degraded?: boolean;
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
  /** Injectable for tests; defaults to the registry. */
  readonly providers?: readonly CommercialProvider[];
  /** Injectable for tests; defaults to the self-hosted engine declarations. */
  readonly engines?: readonly SelfHostedEngine[];
  /**
   * Which provider and engine ids this deployment actually has configured, by
   * id -- NEVER by credential value; nothing here reads the environment.
   *
   * Omitted means "judge every declaration on its evidence", which is the
   * catalogue-wide answer the operator console wants. Supplied, it is how a
   * service asks the deployment-specific question, and it is the only way to
   * model the case that matters most: WITHOUT 9jaLingo, Hausa, Igbo, Yoruba
   * and Nigerian Pidgin must not read as available, because the general
   * vendors' confident wrong audio is not availability.
   */
  readonly configuredProviderIds?: readonly string[];
}

/** Ordered weakest to strongest so the minimum over a stage set picks the state. */
const EVIDENCE_ORDER = ['none', 'claimed', 'declared', 'live'] as const;
type Evidence = (typeof EVIDENCE_ORDER)[number];

const STATE_BY_EVIDENCE: Record<Evidence, LanguageCapabilityState> = {
  none: 'unavailable',
  claimed: 'limited',
  declared: 'available',
  live: 'qualified',
};

/**
 * Which VENDOR ACCOUNTS serve which stage, in chain order. Order breaks
 * evidence ties and nothing else.
 *
 * The Nigerian TTS order is NOT restated here: it is imported from
 * commercial-routing.ts, which is the single source of that founder ruling.
 * Two copies of "who speaks Yoruba" is exactly how the answer drifts.
 */
const COMMERCIAL_CHAIN: Readonly<Record<CapabilityStage, readonly string[]>> = {
  stt: ['deepgram'],
  // Google is the registry's declared MT primary; it sits behind the local
  // engines here because the local engines are what this deployment runs.
  mt: ['google-cloud'],
  tts: ['elevenlabs', 'azure'],
};

/** Local engines come first at MT and last elsewhere; see COMMERCIAL_CHAIN. */
const ENGINES_BEFORE_VENDORS: Readonly<Record<CapabilityStage, boolean>> = {
  stt: false,
  mt: true,
  tts: false,
};

export const OPUS_MT_PROVIDER_ID = 'opus-mt';

const STAGE_LABEL: Record<CapabilityStage, string> = {
  stt: 'STT',
  mt: 'MT',
  tts: 'TTS',
};

const CAPABILITY_OF_STAGE: Record<CapabilityStage, 'transcription' | 'translation' | 'tts'> = {
  stt: 'transcription',
  mt: 'translation',
  tts: 'tts',
};

interface StageResult {
  readonly evidence: Evidence;
  readonly provider?: string;
  readonly degraded?: boolean;
}

function rank(evidence: Evidence): number {
  return EVIDENCE_ORDER.indexOf(evidence);
}

function strongest(a: Evidence, b: Evidence): Evidence {
  return rank(a) >= rank(b) ? a : b;
}

function weakestOf(evidence: readonly Evidence[]): Evidence {
  return evidence.reduce((a, b) => (rank(a) <= rank(b) ? a : b));
}

/** Cap an evidence level, so a general vendor cannot out-rank its own limits. */
function cappedAt(evidence: Evidence, ceiling: Evidence): Evidence {
  return rank(evidence) <= rank(ceiling) ? evidence : ceiling;
}

/**
 * Does this tag name that catalogue language? Vendor tags are reduced through
 * the catalogue's own aliases, so Deepgram's `tl`, Azure's `fil-PH` and
 * Whisper's `nn` all land on the catalogue key rather than being missed.
 */
function listsLanguage(tags: readonly string[] | undefined, code: string): boolean {
  return (tags ?? []).some((tag) => catalogueKeyOf(tag) === code);
}

function commercialEvidence(
  provider: CommercialProvider,
  capability: 'transcription' | 'translation' | 'tts',
  code: string,
): Evidence {
  let best: Evidence = 'none';
  for (const model of provider.models) {
    const modelCapability =
      capability === 'tts'
        ? model.capabilities.tts
        : capability === 'translation'
          ? model.capabilities.translation
          : model.capabilities.transcription;
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

/**
 * A local engine has no vendor to observe, so it has two levels and not four:
 * a model pinned by revision here that names the language has been RUN here
 * (`declared`); a model card's published list has not (`claimed`).
 */
function engineEvidence(engine: SelfHostedEngine, code: string): Evidence {
  if (listsLanguage(engine.exercisedLanguages, code)) return 'declared';
  if (listsLanguage(engine.declaredLanguages, code)) return 'claimed';
  return 'none';
}

interface ChainCandidate {
  readonly id: string;
  readonly evidence: Evidence;
}

function resolveStage(
  stage: CapabilityStage,
  code: string,
  providers: readonly CommercialProvider[],
  engines: readonly SelfHostedEngine[],
  isConfigured: (id: string) => boolean,
): StageResult {
  const capability = CAPABILITY_OF_STAGE[stage];
  const specialistLanguage = stage === 'tts' && isNigerianSpecialistLanguage(code);

  const vendorIds = specialistLanguage ? NIGERIAN_TTS_ROUTE_ORDER : COMMERCIAL_CHAIN[stage];
  const vendorCandidates: ChainCandidate[] = [];
  for (const providerId of vendorIds) {
    if (!isConfigured(providerId)) continue;
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    if (provider === undefined) continue;
    vendorCandidates.push({ id: providerId, evidence: commercialEvidence(provider, capability, code) });
  }

  /*
   * THE SPECIALIST RULE, applied before anything is ranked.
   *
   * For ha/ig/yo/pcm the general fallback is capped at `claimed` however good
   * its own record looks, because its record is about other languages. If the
   * specialist contributes nothing -- absent from the registry, or not
   * configured on this deployment -- whatever is left is a DEGRADED rendering
   * and says so. Local engines are deliberately not consulted for these four:
   * commercial-routing.ts rules the chain is 9jaLingo, then Azure, then
   * nothing, and a second opinion here would quietly widen it.
   */
  if (specialistLanguage) {
    const specialist = vendorCandidates.find((c) => c.id === NIGERIAN_SPECIALIST_PROVIDER_ID);
    if (specialist !== undefined && specialist.evidence !== 'none') {
      return { evidence: specialist.evidence, provider: specialist.id };
    }
    /*
     * The fallback is reported AT `claimed` even though it lists none of these
     * four languages, and that is deliberate. Azure does not claim Yoruba and
     * synthesises it anyway -- fluently, confidently and wrongly. Reporting
     * `unavailable` here would describe a chain that refuses, when the chain
     * actually answers; the row would read as silence and the listener would
     * get wrong audio. `limited` plus `degraded` is what really happens.
     */
    for (const candidate of vendorCandidates) {
      if (candidate.id === NIGERIAN_SPECIALIST_PROVIDER_ID) continue;
      return { evidence: 'claimed', provider: candidate.id, degraded: true };
    }
    return { evidence: 'none' };
  }

  const engineCandidates: ChainCandidate[] = engines
    .filter((engine) => engine.stage === stage && isConfigured(engine.engineId))
    .map((engine) => ({ id: engine.engineId, evidence: engineEvidence(engine, code) }));

  const ordered = ENGINES_BEFORE_VENDORS[stage]
    ? [...engineCandidates, ...vendorCandidates]
    : [...vendorCandidates, ...engineCandidates];

  let result: StageResult = { evidence: 'none' };
  for (const candidate of ordered) {
    // Strictly-greater keeps chain order as the tiebreak.
    if (rank(candidate.evidence) > rank(result.evidence)) {
      result = { evidence: candidate.evidence, provider: candidate.id };
    }
  }
  return result;
}

function describeShortfall(
  stages: Record<CapabilityStage, StageResult>,
  weakest: Evidence,
  considered: readonly CapabilityStage[],
): string {
  const named = considered
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
 * Why a Nigerian-language row is degraded, in words an operator or a listener
 * can act on. Deliberately specific: "fallback in use" would be read as a
 * routing detail, and this is a quality warning nobody else can give, because
 * every automated signal on this path is green.
 */
function degradedWords(englishName: string, providerId: string | undefined): string {
  return (
    `DEGRADED ${englishName}: served by ${providerId ?? 'a general voice vendor'}, not the ` +
    '9jaLingo specialist. General vendors return HTTP 200 and fluent-sounding audio for ' +
    'this language with the wrong pronunciation -- confirmed by listening on 2026-08-26. ' +
    'Set NAIJALINGO_API_KEY to route it to the specialist.'
  );
}

/**
 * One row per catalogue language, in catalogue (rank) order. Pure: the result
 * depends only on the catalogue, the providers and engines passed in
 * (default: the registry declarations), and nothing on the clock or the
 * environment.
 */
export function resolveLanguageCapabilities(
  input: ResolveLanguageCapabilitiesInput = {},
): readonly LanguageCapability[] {
  const providers = input.providers ?? COMMERCIAL_PROVIDERS;
  const engines = input.engines ?? SELF_HOSTED_ENGINES;
  const configured = input.configuredProviderIds;
  const isConfigured = (id: string): boolean => configured === undefined || configured.includes(id);
  // `input.grade` is read here and nowhere else: the seam described in the
  // header. It is intentionally not folded into the result yet.
  void input.grade;

  return LANGUAGE_CATALOGUE.map((language) => {
    const stages: Record<CapabilityStage, StageResult> = {
      stt: resolveStage('stt', language.code, providers, engines, isConfigured),
      mt: resolveStage('mt', language.code, providers, engines, isConfigured),
      tts: resolveStage('tts', language.code, providers, engines, isConfigured),
    };
    const all: CapabilityStage[] = ['stt', 'mt', 'tts'];
    const weakest = weakestOf(all.map((stage) => stages[stage].evidence));
    const sourceEvidence = weakestOf([stages.stt.evidence, stages.mt.evidence]);
    const targetEvidence = weakestOf([stages.mt.evidence, stages.tts.evidence]);
    const reason = describeShortfall(stages, weakest, all);
    const degraded = all.some((stage) => stages[stage].degraded === true);
    const words = degraded ? `${reason} ${degradedWords(language.englishName, stages.tts.provider)}`.trim() : reason;

    const providerNames: { stt?: string; mt?: string; tts?: string } = {};
    if (stages.stt.provider !== undefined) providerNames.stt = stages.stt.provider;
    if (stages.mt.provider !== undefined) providerNames.mt = stages.mt.provider;
    if (stages.tts.provider !== undefined) providerNames.tts = stages.tts.provider;

    return {
      code: language.code,
      englishName: language.englishName,
      nativeName: language.nativeName,
      state: STATE_BY_EVIDENCE[weakest],
      sourceState: STATE_BY_EVIDENCE[sourceEvidence],
      targetState: STATE_BY_EVIDENCE[targetEvidence],
      stageStates: {
        stt: STATE_BY_EVIDENCE[stages.stt.evidence],
        mt: STATE_BY_EVIDENCE[stages.mt.evidence],
        tts: STATE_BY_EVIDENCE[stages.tts.evidence],
      },
      stt: stages.stt.evidence !== 'none',
      mt: stages.mt.evidence !== 'none',
      tts: stages.tts.evidence !== 'none',
      captionsOnly: stages.mt.evidence !== 'none' && stages.tts.evidence === 'none',
      providers: providerNames,
      ...(degraded ? { degraded: true } : {}),
      ...(words === '' ? {} : { reason: words }),
    };
  });
}

/**
 * The languages a picker may OFFER as targets, and the ones it must show
 * disabled. Exported so the console and the phone ask the same question of the
 * same function rather than each re-deriving "is this selectable".
 */
export function isOfferableTarget(capability: LanguageCapability): boolean {
  return capability.targetState !== 'unavailable' || capability.captionsOnly;
}

/** The same question for the language somebody SPEAKS. */
export function isOfferableSource(capability: LanguageCapability): boolean {
  return capability.sourceState !== 'unavailable';
}
