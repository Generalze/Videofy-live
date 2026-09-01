/** @author masterzee001 */
/**
 * WHAT QUALITY THIS PROGRAMME CAN EXPECT ON THIS ROUTE, AND WHY.
 *
 * One operator question, answered from evidence that already exists elsewhere.
 * This module DERIVES; it does not decide. Every state below is traceable to a
 * translation route record, a language capability, or a measurement -- and when
 * none of those can answer, the answer is "unknown", never an optimistic
 * default.
 *
 * THE DEFECT THIS EXISTS TO PREVENT is a green badge. A console that aggregates
 * three pipeline stages into one indicator will, sooner or later, show READY
 * for a route whose synthesis is a fallback voice reading Yoruba wrongly,
 * because two stages out of three were fine. So the three stages are reported
 * INDEPENDENTLY and the overall state is the WEAKEST of them, never an average
 * and never a majority.
 *
 * WHAT MAY NOT PROMOTE A ROUTE, each of which has been tried somewhere:
 *   - a model name existing in configuration
 *   - a credential being present
 *   - a machine benchmark scoring well
 *   - the reverse direction passing
 *   - a different language on the same provider passing
 * The registry already refuses all five. This module renders that refusal; it
 * has no path to override one, which is why it takes a decision rather than a
 * record and never re-judges the approval itself.
 *
 * THREE NUMBERS THAT ARE NOT THE SAME NUMBER, kept apart here because
 * conflating them is how an operator budgets a delay from a value that was
 * never measured:
 *   MEASURED LATENCY    what a stage was observed to take, from real samples
 *   CONFIGURED TIMEOUT  when we give up on it -- a limit, not an observation
 *   RECOMMENDED DELAY   how much airtime margin the programme should hold
 * A timeout is never reported as a latency. An absent measurement is reported
 * as absent.
 */

import {
  normaliseLanguageTag,
  type LatencyProfile,
  type ServiceScope,
  type TranslationDecision,
} from '@videofy-live/translation-routes';
import type {
  TargetLanguageCapability,
  TargetLanguageCapabilityState,
} from '@videofy-live/shared-types';

/**
 * The four truthful states. There is no fifth, and in particular there is no
 * "probably fine".
 *
 * `review-pending` is NOT a weaker form of `degraded`. Degraded means we know
 * what it does and it is worse than we want; review-pending means NOBODY
 * QUALIFIED HAS LOOKED, so its quality is unknown rather than poor. The 2026
 * finding that vendors return confident wrong Yoruba with HTTP 200 is exactly
 * why these two cannot share a colour.
 */
export type QualityState = 'ready' | 'degraded' | 'review-pending' | 'unavailable';

export type PipelineStage = 'stt' | 'translation' | 'tts';

/** Weakest wins. Used to fold three stages without ever averaging them. */
const SEVERITY: Record<QualityState, number> = {
  ready: 0,
  degraded: 1,
  'review-pending': 2,
  unavailable: 3,
};

export function weakest(states: readonly QualityState[]): QualityState {
  return states.reduce<QualityState>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'ready',
  );
}

/**
 * What one stage of the pipeline is, and what is providing it.
 *
 * `reason` is REQUIRED whenever the state is not `ready`. A state without a
 * reason sends an operator to a support channel to ask what it means, and the
 * answer always existed at the point the state was derived.
 */
export interface StageReport {
  readonly stage: PipelineStage;
  readonly state: QualityState;
  /** The route, model or voice actually selected. Null when there is none. */
  readonly provider: string | null;
  /** Human-readable. Null ONLY when the state is `ready`. */
  readonly reason: string | null;
  /** Observed, from real samples. Null means NOT MEASURED -- never a timeout. */
  readonly measuredLatencyMs: LatencyProfile | null;
  /** Where the measurement came from, so a number can be challenged. */
  readonly latencyEvidence: string | null;
}

/**
 * The delay recommendation, with its own workings shown.
 *
 * `seconds` is null when the route cannot run at all: recommending a delay for
 * a pipeline that will not produce audio is advice about nothing.
 */
export interface RecommendedDelay {
  readonly seconds: number | null;
  /**
   * How much of the pipeline the recommendation actually rests on. `measured`
   * only when EVERY stage was measured; `partly-measured` is the honest state
   * of this deployment today.
   */
  readonly basis: 'measured' | 'partly-measured' | 'unmeasured' | 'not-applicable';
  /** Worst observed total across the stages that HAVE been measured. */
  readonly measuredFloorMs: number;
  /** Named, so the operator knows which part of the number is missing. */
  readonly unmeasuredStages: readonly PipelineStage[];
  /** Why this number. Shown to the operator verbatim. */
  readonly explanation: string;
}

export interface RouteQualityRow {
  /**
   * DIRECTIONAL. `en->fr` and `fr->en` are two rows and never collapse into
   * "French": they are different models, different failure modes, and
   * different people qualified to judge them.
   */
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly scope: ServiceScope;
  readonly stt: StageReport;
  readonly translation: StageReport;
  readonly tts: StageReport;
  /** The WEAKEST stage. A failed stage is never hidden behind this. */
  readonly overall: QualityState;
  readonly recommendedDelay: RecommendedDelay;
}

/**
 * The programme's delay grades, from the blueprint.
 *
 * A recommendation is one of these, chosen because it CLEARS the evidence --
 * not computed to a spurious 37 seconds from four samples.
 */
export const DELAY_GRADES_SECONDS: readonly number[] = [30, 45, 60, 90];

/** Margin over the worst observed pipeline time, before choosing a grade. */
const SAFETY_MULTIPLIER = 1.5;

function mapCapabilityState(
  state: TargetLanguageCapabilityState | undefined,
): QualityState | null {
  if (state === undefined) return null;
  switch (state) {
    case 'qualified':
    case 'available':
      return 'ready';
    case 'limited':
      return 'degraded';
    case 'unavailable':
      return 'unavailable';
    default:
      return null;
  }
}

/**
 * Speech recognition, judged against the SOURCE language.
 *
 * The source is what the recogniser hears. Judging it against the target is the
 * bug that refused Igbo because nothing transcribes Igbo, when Igbo was only
 * ever going to be listened to.
 */
export function deriveSttStage(
  capability: TargetLanguageCapability | null,
  sourceLanguage: string,
): StageReport {
  const base = {
    stage: 'stt' as const,
    // NOTHING IN THIS DEPLOYMENT MEASURES RECOGNITION LATENCY. Reported as
    // absent rather than filled in from the socket timeout, which is a limit.
    measuredLatencyMs: null,
    latencyEvidence: null,
  };

  if (capability === null) {
    return {
      ...base,
      state: 'unavailable',
      provider: null,
      reason:
        `Speech recognition unavailable: ${sourceLanguage} is not in this ` +
        'deployment capability catalogue.',
    };
  }

  const provider = capability.providers?.stt ?? null;
  const mapped = mapCapabilityState(capability.sourceState);

  if (provider === null || mapped === null || mapped === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      provider,
      reason:
        `Speech recognition unavailable for ${sourceLanguage}` +
        (capability.reason !== undefined ? `: ${capability.reason}` : '.'),
    };
  }

  if (mapped === 'degraded') {
    return {
      ...base,
      state: 'degraded',
      provider,
      reason:
        capability.reason ?? `Speech recognition for ${sourceLanguage} is a limited route.`,
    };
  }

  return { ...base, state: 'ready', provider, reason: null };
}

/**
 * Translation, taken from the registry's decision rather than re-judged.
 *
 * This function CANNOT approve anything. It receives a decision and renders it;
 * there is no branch here that turns a refusal into a usable state, which is
 * the property that keeps Nigerian directions from being promoted by a page.
 */
export function deriveTranslationStage(
  decision: TranslationDecision,
  sourceLanguage: string,
  targetLanguage: string,
): StageReport {
  const stage = 'translation' as const;

  if (decision.allowed) {
    const route = decision.route;
    const evidence = route.technicalEvidence;
    return {
      stage,
      state: 'ready',
      provider: `${route.provider} ${route.modelId}`.trim(),
      reason: null,
      // Measured, or honestly absent. A route may be approved on human review
      // with no benchmark behind it, and that is not a reason to invent one.
      measuredLatencyMs: evidence === null ? null : evidence.latencyMs,
      latencyEvidence:
        evidence === null
          ? null
          : `${evidence.sampleCount} samples, recorded ${evidence.recordedAt}`,
    };
  }

  // A REFUSAL. The registry already wrote the sentence; composing a second one
  // here would be an explanation free to drift from the real reason.
  const state: QualityState =
    decision.reason === 'human-review-outstanding' ? 'review-pending' : 'unavailable';

  const evidence = decision.route === null ? null : decision.route.technicalEvidence;
  const where = `${normaliseLanguageTag(sourceLanguage)}->${normaliseLanguageTag(targetLanguage)}`;

  return {
    stage,
    state,
    provider:
      decision.route === null
        ? null
        : `${decision.route.provider} ${decision.route.modelId}`.trim(),
    reason: decision.explanation,
    /*
     * A PENDING ROUTE MAY STILL CARRY A MEASUREMENT, and showing it is correct:
     * the benchmark says how FAST it was, and the pending state says nobody has
     * confirmed it is RIGHT. Those are the two separate fields the record keeps
     * apart on purpose, so this keeps them apart too -- and the evidence line
     * says which of the two it is, because a number beside a pending row is
     * exactly the thing somebody will read as reassurance.
     */
    measuredLatencyMs: evidence === null ? null : evidence.latencyMs,
    latencyEvidence:
      evidence === null
        ? null
        : `${evidence.sampleCount} samples, recorded ${evidence.recordedAt}` +
          ` - speed only; correctness is unreviewed for ${where}`,
  };
}

/**
 * Synthesis, judged against the TARGET language -- the voice the listener hears.
 *
 * `degraded` here has a specific, expensive meaning: a Nigerian language served
 * by a general vendor rather than the specialist. That audio PLAYS, and it is
 * wrong, which is the worst failure shape available because nothing errors.
 */
export function deriveTtsStage(
  capability: TargetLanguageCapability | null,
  targetLanguage: string,
): StageReport {
  const base = {
    stage: 'tts' as const,
    // No synthesis latency is measured on this deployment either.
    measuredLatencyMs: null,
    latencyEvidence: null,
  };

  if (capability === null) {
    return {
      ...base,
      state: 'unavailable',
      provider: null,
      reason:
        `No synthesis route: ${targetLanguage} is not in this deployment ` +
        'capability catalogue.',
    };
  }

  const provider = capability.providers?.tts ?? capability.voiceId ?? null;

  if (capability.captionsOnly === true || !capability.voiceAvailable) {
    return {
      ...base,
      state: 'unavailable',
      provider,
      reason:
        capability.reason ??
        `No voice on this chain for ${targetLanguage}; this route is captions only.`,
    };
  }

  if (capability.degraded === true) {
    return {
      ...base,
      state: 'degraded',
      provider,
      reason:
        capability.reason ??
        `Fallback synthesis route: ${targetLanguage} is being spoken by a general ` +
          'voice rather than the specialist, and the audio will be wrong.',
    };
  }

  const mapped = mapCapabilityState(capability.targetState);

  if (mapped === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      provider,
      reason: capability.reason ?? `No synthesis route for ${targetLanguage}.`,
    };
  }

  if (mapped === 'degraded') {
    return {
      ...base,
      state: 'degraded',
      provider,
      reason: capability.reason ?? `Limited synthesis route for ${targetLanguage}.`,
    };
  }

  return { ...base, state: 'ready', provider, reason: null };
}

/**
 * How much airtime margin to hold, and the workings behind it.
 *
 * NOT A SUM OF TIMEOUTS. Adding configured limits produces a large, confident
 * number describing a pipeline nobody observed. This adds the WORST OBSERVED
 * time of the stages that were actually measured, applies a margin, and then
 * picks the lowest grade that clears it -- and says plainly which stages
 * contributed nothing because nobody has measured them.
 */
export function recommendDelay(
  stages: readonly StageReport[],
  overall: QualityState,
): RecommendedDelay {
  const unmeasured = stages
    .filter((s) => s.measuredLatencyMs === null)
    .map((s) => s.stage);

  if (overall === 'unavailable' || overall === 'review-pending') {
    return {
      seconds: null,
      basis: 'not-applicable',
      measuredFloorMs: 0,
      unmeasuredStages: unmeasured,
      explanation:
        'No delay is recommended because this route cannot go to air yet. A ' +
        'delay budget for a pipeline that will not produce audio would describe ' +
        'nothing.',
    };
  }

  // Worst observed, not median: a delay that only covers the typical case
  // fails exactly when the programme is under load.
  const measuredFloorMs = stages.reduce(
    (total, s) => total + (s.measuredLatencyMs === null ? 0 : s.measuredLatencyMs.max),
    0,
  );

  if (unmeasured.length === stages.length) {
    return {
      seconds: null,
      basis: 'unmeasured',
      measuredFloorMs: 0,
      unmeasuredStages: unmeasured,
      explanation:
        'Not measured. No stage of this route has a latency measurement, so any ' +
        'number here would be invented. Run a preflight measurement before ' +
        'budgeting a delay.',
    };
  }

  const withMargin = measuredFloorMs * SAFETY_MULTIPLIER;
  const grade =
    DELAY_GRADES_SECONDS.find((g) => g * 1000 >= withMargin) ??
    DELAY_GRADES_SECONDS[DELAY_GRADES_SECONDS.length - 1]!;

  const measuredNames = stages
    .filter((s) => s.measuredLatencyMs !== null)
    .map((s) => s.stage)
    .join(', ');

  return {
    seconds: grade,
    basis: unmeasured.length === 0 ? 'measured' : 'partly-measured',
    measuredFloorMs,
    unmeasuredStages: unmeasured,
    explanation:
      `${grade} s is the lowest grade that clears the measured evidence. ` +
      `Worst observed time across ${measuredNames} is ${measuredFloorMs} ms; ` +
      `with a ${SAFETY_MULTIPLIER}x margin that is ${Math.round(withMargin)} ms.` +
      (unmeasured.length > 0
        ? ` This is a FLOOR, not a full budget: ${unmeasured.join(' and ')} ` +
          'contributed nothing because neither is measured on this deployment.'
        : ''),
  };
}

export interface RouteQualityInput {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly scope: ServiceScope;
  /** The registry's answer for THIS direction and THIS scope. */
  readonly decision: TranslationDecision;
  /** Capability of the SOURCE language, for recognition. */
  readonly sourceCapability: TargetLanguageCapability | null;
  /** Capability of the TARGET language, for the voice. */
  readonly targetCapability: TargetLanguageCapability | null;
}

/** One directional row, derived from evidence that already exists. */
export function deriveRouteQuality(input: RouteQualityInput): RouteQualityRow {
  const stt = deriveSttStage(input.sourceCapability, input.sourceLanguage);
  const translation = deriveTranslationStage(
    input.decision,
    input.sourceLanguage,
    input.targetLanguage,
  );
  const tts = deriveTtsStage(input.targetCapability, input.targetLanguage);

  // THE WEAKEST STAGE, not a blend. This is the line that stops a failed stage
  // hiding behind two healthy ones.
  const overall = weakest([stt.state, translation.state, tts.state]);

  return {
    sourceLanguage: normaliseLanguageTag(input.sourceLanguage),
    targetLanguage: normaliseLanguageTag(input.targetLanguage),
    scope: input.scope,
    stt,
    translation,
    tts,
    overall,
    recommendedDelay: recommendDelay([stt, translation, tts], overall),
  };
}
